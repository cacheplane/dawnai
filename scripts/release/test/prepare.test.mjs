import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as defaultFileSystem from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { readReleaseInventory } from "../inventory.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import { prepareReleaseArtifacts } from "../prepare.mjs"
import {
  inspectPreparedTarball,
  localPublishArguments,
  smokePreparedTarballs,
  startLoopbackRegistry,
} from "../prepare-checks.mjs"
import { orderReleasePackages } from "../topology.mjs"

const { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } = defaultFileSystem

const VERSION = "0.8.22"
const SHA = "a".repeat(40)
const CANDIDATE = Object.freeze({
  version: VERSION,
  commitSha: SHA,
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})
const CI = Object.freeze({
  status: "success",
  retryable: false,
  commitSha: SHA,
  workflow: "CI",
  check: "validate",
  runId: 100,
  runAttempt: 1,
})
const PREPARE_RUN = Object.freeze({ id: 200, attempt: 2 })
const AUTHORITY = Object.freeze({
  state: "CANDIDATE_TAGGED",
  releaseRecord: "absent",
  npm: "absent",
})

test("the sealed fixed-group-v1 order matches the live repository inventory and topology", async () => {
  const inventory = await readReleaseInventory({ root: process.cwd() })
  const packages = inventory.workspacePackages.filter((packageJson) => packageJson.private !== true)

  assert.deepEqual(
    orderReleasePackages(packages).map((packageJson) => packageJson.name),
    CANONICAL_RELEASE_PACKAGE_ORDER,
  )
  assert.deepEqual(
    [...inventory.fixedGroups[0]].sort(),
    [...CANONICAL_RELEASE_PACKAGE_ORDER].sort(),
  )
})

test("preparation builds, packs all and only 21 packages once in stable dependency order, then inspects and smokes", async (t) => {
  const fixture = await preparationFixture(t)

  const result = await prepareReleaseArtifacts(fixture.options)

  assert.equal(result.artifactName, `release-v${VERSION}-${SHA.slice(0, 12)}`)
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/u)
  assert.deepEqual(
    result.manifest.packages.map((entry) => entry.name),
    CANONICAL_RELEASE_PACKAGE_ORDER,
  )
  assert.equal(result.manifest.packages.length, 21)
  assert.equal(new Set(result.manifest.packages.map((entry) => entry.name)).size, 21)
  assert.equal(result.manifest.packages.at(-1).name, "create-dawn-ai-app")
  assert.ok(result.manifest.packages.every((entry) => entry.version === VERSION))
  assert.ok(result.manifest.packages.every((entry) => entry.access === "public"))
  assert.ok(result.manifest.packages.every((entry) => entry.size > 0))
  assert.ok(result.manifest.packages.every((entry) => /^[0-9a-f]{64}$/u.test(entry.sha256)))
  assert.ok(result.manifest.packages.every((entry) => /^[0-9a-f]{128}$/u.test(entry.sha512)))
  assert.ok(result.manifest.packages.every((entry) => entry.npmIntegrity.startsWith("sha512-")))

  const operations = fixture.operations
  assert.ok(
    operations.indexOf("pnpm build") < operations.findIndex((item) => item.startsWith("pack:")),
  )
  assert.equal(operations.filter((item) => item.startsWith("pack:")).length, 21)
  assert.deepEqual(
    operations.filter((item) => item.startsWith("pack:")).map((item) => item.slice(5)),
    CANONICAL_RELEASE_PACKAGE_ORDER,
  )
  assert.ok(operations.lastIndexOf("inspect") < operations.indexOf("smoke"))
  assert.ok(operations.indexOf("smoke") < operations.indexOf("write-manifest"))
  assert.ok(operations.every((item) => item !== "pnpm ci:validate"))

  const persisted = JSON.parse(
    await readFile(path.join(fixture.outputDir, "manifest.json"), "utf8"),
  )
  assert.deepEqual(persisted, result.manifest)
})

test("preparation verifies HEAD and the candidate tag before building", async (t) => {
  const fixture = await preparationFixture(t, { tagSha: "b".repeat(40) })
  await assert.rejects(prepareReleaseArtifacts(fixture.options), /candidate tag.*SHA/iu)
  assert.ok(!fixture.operations.includes("pnpm build"))
})

test("preparation accepts the production command adapter stdout envelope", async (t) => {
  const fixture = await preparationFixture(t, { commandEnvelope: true })
  await prepareReleaseArtifacts(fixture.options)
  assert.ok(fixture.operations.includes("pnpm build"))
})

test("preparation requires the exact candidate tag ref and a clean checkout", async (t) => {
  for (const override of [
    { sourceRef: "refs/heads/main" },
    { checkoutStatus: " M packages/sdk/package.json\n" },
    { checkoutStatus: "?? untracked.txt\n" },
  ]) {
    const fixture = await preparationFixture(t, override)
    await assert.rejects(
      prepareReleaseArtifacts(fixture.options),
      /source ref|clean checkout|dirty|untracked/iu,
    )
    assert.ok(!fixture.operations.includes("pnpm build"))
  }
})

test("preparation uses production inspection and smoke defaults when callbacks are omitted", async (t) => {
  const fixture = await preparationFixture(t)
  delete fixture.options.inspectTarball
  delete fixture.options.smokeTarballs
  fixture.options.createProductionChecks = () => ({
    async inspectTarball({ entry }) {
      fixture.operations.push(`production-inspect:${entry.name}`)
      return { status: "verified" }
    },
    async smokeTarballs() {
      fixture.operations.push("production-smoke")
      return { cleanInstall: "passed", typeScript: "passed", scaffold: "passed" }
    },
  })

  await prepareReleaseArtifacts(fixture.options)

  assert.equal(
    fixture.operations.filter((operation) => operation.startsWith("production-inspect:")).length,
    21,
  )
  assert.equal(fixture.operations.filter((operation) => operation === "production-smoke").length, 1)
})

test("production inspection rejects tar symlinks and hardlinks before extraction", async () => {
  for (const type of ["l", "h"]) {
    const commands = []
    await assert.rejects(
      inspectPreparedTarball({
        packageJson: { name: "@dawn-ai/evals", path: "packages/evals/package.json" },
        tarballPath: "/tmp/evals.tgz",
        entry: { name: "@dawn-ai/evals", version: VERSION, access: "public" },
        root: "/tmp/repository",
        async run(command, args) {
          commands.push([command, ...args])
          if (args[0] === "-tzf") return { stdout: "package/package.json\n", stderr: "" }
          if (args[0] === "-tvzf") {
            return {
              stdout: `${type}rwxr-xr-x 0 user group 0 Jan 1 00:00 package/link\n`,
              stderr: "",
            }
          }
          throw new Error("archive extraction must not run")
        },
        fileSystem: {
          async mkdtemp() {
            return "/tmp/dawn-inspect"
          },
          async realpath(target) {
            return target
          },
          async rm() {},
        },
      }),
      /symlink|hardlink|link entry/u,
    )
    assert.ok(commands.every(([, argument]) => argument !== "-xzf"))
  }
})

test("local registry publication reuses exact tgzs without lifecycle scripts", () => {
  assert.deepEqual(localPublishArguments("/tmp/exact.tgz"), [
    "publish",
    "/tmp/exact.tgz",
    "--ignore-scripts",
    "--tag",
    "latest",
    "--access",
    "public",
    "--scope=",
  ])
})

test("loopback registry startup has a hard deadline", async () => {
  await assert.rejects(
    startLoopbackRegistry({ runServerImpl: () => new Promise(() => {}), timeoutMs: 10 }),
    /registry startup.*timed out/iu,
  )
})

test("production smoke orchestrates exact tgz publication, install, TypeScript, and scaffold gates", async () => {
  const manifest = {
    packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => ({ name, version: VERSION })),
  }
  const tarballs = manifest.packages.map(
    ({ name }) => `/sealed/${tarballStem(name)}-${VERSION}.tgz`,
  )
  const events = []
  const registry = {
    url: "http://127.0.0.1:4873/",
    async close() {
      events.push("registry-close")
    },
  }
  const run = async (command, args, { cwd }) => {
    if (command === "npm" && args[0] === "publish") {
      events.push(`publish:${args[1]}`)
      return { stdout: "", stderr: "" }
    }
    if (command === "npm" && args[0] === "install" && cwd.endsWith("consumer")) {
      if (args.some((arg) => String(arg).startsWith("typescript@"))) {
        events.push("typescript-install")
      } else {
        events.push("candidate-install")
        await writeInstalledManifests(cwd, manifest.packages)
      }
      return { stdout: "", stderr: "" }
    }
    if (command === "npm" && args[0] === "install" && cwd.endsWith("scaffolder-installer")) {
      events.push("scaffolder-install")
      return { stdout: "", stderr: "" }
    }
    if (command.endsWith("create-dawn-ai-app")) {
      events.push("scaffold-create")
      await mkdir(args[0])
      await writeFile(
        path.join(args[0], "package.json"),
        `${JSON.stringify({ dependencies: { "@dawn-ai/sdk": "latest" } })}\n`,
      )
      return { stdout: "", stderr: "" }
    }
    if (command === "npm" && args[0] === "install" && cwd.endsWith("scaffold")) {
      events.push("scaffold-install")
      await writeInstalledManifests(cwd, [{ name: "@dawn-ai/sdk", version: VERSION }])
      return { stdout: "", stderr: "" }
    }
    if (command === "npm" && args.join(" ") === "run typecheck") {
      events.push("scaffold-typecheck")
      return { stdout: "", stderr: "" }
    }
    if (command === "npm" && args.join(" ") === "run build") {
      events.push("scaffold-build")
      return { stdout: "", stderr: "" }
    }
    throw new Error(`Unexpected smoke command: ${command} ${args.join(" ")}`)
  }

  const result = await smokePreparedTarballs({
    candidate: CANDIDATE,
    manifest,
    tarballs,
    run,
    startRegistry: async () => registry,
    async runTypeScriptProbe() {
      events.push("typescript-probe")
    },
  })

  assert.deepEqual(result, {
    cleanInstall: "passed",
    typeScript: "passed",
    scaffold: "passed",
  })
  assert.deepEqual(
    events.slice(0, 21),
    tarballs.map((tarball) => `publish:${tarball}`),
  )
  assert.deepEqual(events.slice(21), [
    "candidate-install",
    "typescript-install",
    "typescript-probe",
    "scaffolder-install",
    "scaffold-create",
    "scaffold-install",
    "scaffold-typecheck",
    "scaffold-build",
    "registry-close",
  ])
})

test("only candidate-tag-only authority can prepare or retry lost preparation", async (t) => {
  for (const authority of [
    { state: "ARTIFACTS_PREPARED", releaseRecord: "present", npm: "absent" },
    { state: "CANDIDATE_TAGGED", releaseRecord: "absent", npm: "partial" },
    { state: "NPM_COMPLETE", releaseRecord: "present", npm: "complete" },
  ]) {
    const fixture = await preparationFixture(t, { authority })
    await assert.rejects(prepareReleaseArtifacts(fixture.options), /preparation authority/iu)
    assert.equal(fixture.operations.length, 0)
  }
})

test("manifest remains absent when inspection or smoke fails", async (t) => {
  for (const failure of ["inspect", "smoke"]) {
    const fixture = await preparationFixture(t, { failure })
    await assert.rejects(prepareReleaseArtifacts(fixture.options), new RegExp(failure, "u"))
    await assert.rejects(readFile(path.join(fixture.outputDir, "manifest.json")), /ENOENT/u)
  }
})

test("preparation rejects extra pack output and tarballs changed by smoke before manifest", async (t) => {
  for (const defect of ["extra-tarball", "mutate-after-smoke"]) {
    const fixture = await preparationFixture(t, { defect })
    await assert.rejects(prepareReleaseArtifacts(fixture.options), /tarball|changed|file set/iu)
    await assert.rejects(readFile(path.join(fixture.outputDir, "manifest.json")), /ENOENT/u)
  }
})

test("preparation rejects an output parent that resolves through a symlink", async (t) => {
  const fixture = await preparationFixture(t)
  const target = path.join(fixture.root, "real-parent")
  const linked = path.join(fixture.root, "linked-parent")
  await mkdir(target)
  await symlink(target, linked)
  fixture.options.outputDir = path.join(linked, "release-output")

  await assert.rejects(prepareReleaseArtifacts(fixture.options), /output parent.*symlink/u)
})

async function preparationFixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "dawn-prepare-root-")))
  const outputDir = path.join(root, "release-output")
  t.after(() => rm(root, { recursive: true, force: true }))
  const operations = []
  const packages = CANONICAL_RELEASE_PACKAGE_ORDER.map((name, index) => ({
    name,
    version: VERSION,
    path: `packages/package-${index}`,
    publishConfig: { access: "public" },
    ...(index === 0
      ? {}
      : { dependencies: { [CANONICAL_RELEASE_PACKAGE_ORDER[index - 1]]: "workspace:*" } }),
  }))
  const inventory = {
    fixedGroups: [[...CANONICAL_RELEASE_PACKAGE_ORDER]],
    workspacePackages: packages,
  }
  const headSha = overrides.headSha ?? SHA
  const tagSha = overrides.tagSha ?? SHA
  const output = (stdout) => (overrides.commandEnvelope ? { stdout, stderr: "" } : stdout)
  const run = async (command, args) => {
    if (command === "git" && args.join(" ") === "rev-parse HEAD") return output(`${headSha}\n`)
    if (command === "git" && args.join(" ") === `rev-list -n 1 v${VERSION}`) {
      return output(`${tagSha}\n`)
    }
    if (command === "git" && args.join(" ") === "status --porcelain=v1 --untracked-files=all") {
      return output(overrides.checkoutStatus ?? "")
    }
    if (command === "pnpm" && args.join(" ") === "build") {
      operations.push("pnpm build")
      return output("")
    }
    if (command === "pnpm" && args[0] === "--filter" && args[2] === "pack") {
      const name = args[1]
      operations.push(`pack:${name}`)
      const filename = `${tarballStem(name)}-${VERSION}.tgz`
      await writeFile(path.join(outputDir, filename), `packed:${name}`)
      if (overrides.defect === "extra-tarball") {
        await writeFile(path.join(outputDir, `extra-${name.replaceAll("/", "-")}.tgz`), "extra")
      }
      return output(`${path.join(outputDir, filename)}\n`)
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`)
  }
  const options = {
    candidate: CANDIDATE,
    inventory,
    root,
    outputDir,
    ci: CI,
    prepareRun: PREPARE_RUN,
    preparationAuthority: overrides.authority ?? AUTHORITY,
    sourceRef: overrides.sourceRef ?? `refs/tags/v${VERSION}`,
    run,
    async inspectTarball({ entry, bytes }) {
      operations.push("inspect")
      assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256)
      if (overrides.failure === "inspect") throw new Error("inspect failed")
      return { status: "verified" }
    },
    async smokeTarballs({ manifest }) {
      operations.push("smoke")
      assert.equal(manifest.packages.length, 21)
      if (overrides.failure === "smoke") throw new Error("smoke failed")
      if (overrides.defect === "mutate-after-smoke") {
        await writeFile(
          path.join(outputDir, `${tarballStem(manifest.packages[0].name)}-${VERSION}.tgz`),
          "changed",
        )
      }
      return { cleanInstall: "passed", typeScript: "passed", scaffold: "passed" }
    },
    fileSystem: {
      ...defaultFileSystem,
      async writeFile(target, ...args) {
        const result = await defaultFileSystem.writeFile(target, ...args)
        if (path.basename(target) === "manifest.json") operations.push("write-manifest")
        return result
      },
    },
  }
  return { options, operations, outputDir, root }
}

function tarballStem(name) {
  return name.startsWith("@") ? name.slice(1).replaceAll("/", "-") : name
}

async function writeInstalledManifests(root, packages) {
  for (const packageJson of packages) {
    const directory = path.join(root, "node_modules", ...packageJson.name.split("/"))
    await mkdir(directory, { recursive: true })
    await writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify({ ...packageJson, scripts: {} })}\n`,
    )
  }
}
