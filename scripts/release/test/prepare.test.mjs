import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as defaultFileSystem from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { gzipSync } from "node:zlib"
import { readReleaseInventory } from "../inventory.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "../limits.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import { prepareReleaseArtifacts } from "../prepare.mjs"
import {
  assertSafePackedPublicationManifest,
  inspectPreparedTarball,
  localPublishArguments,
  scanPreparedTarball,
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
        async scanTarball() {},
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
  assert.deepEqual(localPublishArguments("/tmp/exact.tgz", "http://127.0.0.1:4873/"), [
    "publish",
    "/tmp/exact.tgz",
    "--registry",
    "http://127.0.0.1:4873/",
    "--ignore-scripts",
    "--tag",
    "latest",
    "--access",
    "public",
    "--scope=",
  ])
})

test("packed publication metadata cannot redirect npm or escape the registry", () => {
  const base = {
    name: "@dawn-ai/example",
    version: VERSION,
    publishConfig: { access: "public" },
    dependencies: {
      zod: "^4.4.3",
      typescript: "npm:@typescript/typescript6@6.0.2",
    },
  }
  assert.doesNotThrow(() => assertSafePackedPublicationManifest(base))

  for (const publishConfig of [
    { access: "public", registry: "https://registry.npmjs.org/" },
    { access: "public", tag: "foreign" },
  ]) {
    assert.throws(
      () => assertSafePackedPublicationManifest({ ...base, publishConfig }),
      /publishConfig|redirect|access.*only/iu,
    )
  }
  for (const specifier of [
    "https://example.test/package.tgz",
    "git+ssh://git@example.test/repository.git",
    "github:owner/repository",
    "owner/repository",
    "file:../package",
    "link:../package",
    "workspace:*",
    "../package",
    "/absolute/package",
  ]) {
    assert.throws(
      () =>
        assertSafePackedPublicationManifest({
          ...base,
          dependencies: { unsafe: specifier },
        }),
      /dependency.*registry|specifier|unsafe/iu,
    )
  }
})

test("tarball preflight bounds entry count and expanded bytes before extraction", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "dawn-tar-preflight-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const tarball = path.join(temporary, "fixture.tgz")
  await writeFile(
    tarball,
    gzipSync(
      tarArchive([
        { name: "package/package.json", bytes: Buffer.from("{}") },
        { name: "package/index.js", bytes: Buffer.from("export {}") },
      ]),
    ),
  )

  await assert.rejects(
    scanPreparedTarball(tarball, { maxEntries: 1 }),
    /entry count|too many.*entries/iu,
  )
  await assert.rejects(
    scanPreparedTarball(tarball, { maxExpandedBytes: 1_000 }),
    /expanded.*byte|tar.*size/iu,
  )
})

test("tarball preflight validates npm PAX path headers without weakening path checks", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "dawn-tar-pax-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  for (const [name, expected] of [
    ["package/a-very-long-safe-path/index.js", "verified"],
    ["../escape.js", "rejected"],
  ]) {
    const tarball = path.join(temporary, `${expected}.tgz`)
    await writeFile(
      tarball,
      gzipSync(
        tarArchive([
          { name: "PaxHeader", type: "x", bytes: Buffer.from(paxRecord("path", name)) },
          { name: "PaxHeader", bytes: Buffer.from("export {}") },
        ]),
      ),
    )
    if (expected === "verified") {
      assert.equal((await scanPreparedTarball(tarball)).entries, 2)
    } else {
      await assert.rejects(scanPreparedTarball(tarball), /unsafe.*path|archive path/iu)
    }
  }
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
    if (command === "npm" && ["publish", "install"].includes(args[0])) {
      assert.deepEqual(args.slice(args.indexOf("--registry"), args.indexOf("--registry") + 2), [
        "--registry",
        registry.url,
      ])
    }
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

test("production smoke rejects non-loopback registry injection", async () => {
  await assert.rejects(
    smokePreparedTarballs({
      candidate: CANDIDATE,
      manifest: { packages: [] },
      tarballs: [],
      async run() {
        throw new Error("npm must not run")
      },
      startRegistry: async () => ({
        url: "https://registry.npmjs.org/",
        async close() {},
      }),
    }),
    /loopback.*registry|registry.*loopback/iu,
  )
})

test("production smoke attempts temp cleanup even when registry shutdown fails", async () => {
  const removals = []
  await assert.rejects(
    smokePreparedTarballs({
      candidate: CANDIDATE,
      manifest: { packages: [{ name: "@dawn-ai/sdk", version: VERSION }] },
      tarballs: ["/sealed/sdk.tgz"],
      async run() {
        throw new Error("primary smoke failure")
      },
      startRegistry: async () => ({
        url: "http://127.0.0.1:4873/",
        async close() {
          throw new Error("registry close failure")
        },
      }),
      fileSystem: {
        ...defaultFileSystem,
        async rm(target, options) {
          removals.push(target)
          return defaultFileSystem.rm(target, options)
        },
      },
    }),
    /primary smoke failure.*registry close fail|multiple.*smoke.*cleanup/isu,
  )
  assert.equal(removals.length, 1)
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
  const target = path.join(path.dirname(fixture.root), "real-parent")
  const linked = path.join(path.dirname(fixture.root), "linked-parent")
  await mkdir(target)
  await symlink(target, linked)
  fixture.options.outputDir = path.join(linked, "release-output")

  await assert.rejects(prepareReleaseArtifacts(fixture.options), /output parent.*symlink/u)
})

test("preparation requires output outside the canonical repository root", async (t) => {
  const fixture = await preparationFixture(t)
  fixture.options.outputDir = path.join(fixture.root, "release-output")

  await assert.rejects(prepareReleaseArtifacts(fixture.options), /output.*outside.*repository/iu)
  assert.ok(!fixture.operations.includes("pnpm build"))
})

test("preparation revalidates the exact clean checkout immediately before sealing", async (t) => {
  const fixture = await preparationFixture(t, { mutateRepositoryAfterSmoke: true })

  await assert.rejects(prepareReleaseArtifacts(fixture.options), /clean checkout|dirty|untracked/iu)
  await assert.rejects(readFile(path.join(fixture.outputDir, "manifest.json")), /ENOENT/u)
  assert.equal(fixture.checkoutChecks, 2)
})

test("preparation rejects oversized tarballs before readFile", async (t) => {
  const fixture = await preparationFixture(t, { oversizedTarball: true })

  await assert.rejects(
    prepareReleaseArtifacts(fixture.options),
    /tarball.*byte limit|size.*limit/iu,
  )
  assert.equal(fixture.tarballReads, 0)
})

test("preparation snapshots security inputs without invoking accessors", async (t) => {
  for (const target of ["candidate", "ci", "prepareRun", "preparationAuthority", "inventory"]) {
    const fixture = await preparationFixture(t)
    let reads = 0
    const object =
      target === "inventory"
        ? fixture.options.inventory.workspacePackages[0]
        : fixture.options[target]
    const field = target === "inventory" ? "name" : Object.keys(object)[0]
    Object.defineProperty(object, field, {
      enumerable: true,
      get() {
        reads += 1
        return "forged"
      },
    })

    await assert.rejects(
      prepareReleaseArtifacts(fixture.options),
      /snapshot|accessor|data property/iu,
    )
    assert.equal(reads, 0)
    assert.equal(fixture.operations.length, 0)
  }
})

test("preparation snapshots reject symbols, hidden fields, unsafe keys, and prototypes", async (t) => {
  const cases = [
    (options) => {
      options.candidate[Symbol("unsafe")] = true
    },
    (options) => {
      Object.defineProperty(options.ci, "hidden", { value: true })
    },
    (options) => {
      Object.setPrototypeOf(options.prepareRun, { unsafe: true })
    },
    (options) => {
      Object.defineProperty(options.preparationAuthority, "__proto__", {
        value: "unsafe",
        enumerable: true,
      })
    },
    (options) => {
      options.inventory.workspacePackages[0][Symbol("unsafe")] = true
    },
  ]
  for (const mutate of cases) {
    const fixture = await preparationFixture(t)
    mutate(fixture.options)
    await assert.rejects(
      prepareReleaseArtifacts(fixture.options),
      /snapshot|unsafe|symbol|non-enumerable/iu,
    )
    assert.equal(fixture.operations.length, 0)
  }
})

test("preparation uses deep-frozen snapshots despite caller mutation during await", async (t) => {
  const fixture = await preparationFixture(t)
  let productionInputs
  delete fixture.options.inspectTarball
  delete fixture.options.smokeTarballs
  fixture.options.createProductionChecks = (inputs) => {
    productionInputs = inputs
    return {
      async inspectTarball() {
        return { status: "verified" }
      },
      async smokeTarballs() {
        return { cleanInstall: "passed", typeScript: "passed", scaffold: "passed" }
      },
    }
  }
  const originalRun = fixture.options.run
  let mutated = false
  fixture.options.run = async (...args) => {
    if (!mutated) {
      mutated = true
      fixture.options.candidate.version = "9.9.9"
      fixture.options.ci.commitSha = "b".repeat(40)
      fixture.options.prepareRun.attempt = 99
      fixture.options.preparationAuthority.npm = "complete"
      fixture.options.inventory.workspacePackages[0].name = "mutated"
    }
    return originalRun(...args)
  }

  const result = await prepareReleaseArtifacts(fixture.options)

  assert.equal(result.manifest.version, VERSION)
  assert.deepEqual(result.manifest.packageOrder, CANONICAL_RELEASE_PACKAGE_ORDER)
  assertRecursivelyFrozen(productionInputs.candidate)
  assertRecursivelyFrozen(productionInputs.inventory)
})

async function preparationFixture(t, overrides = {}) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "dawn-prepare-fixture-")))
  const root = path.join(temporary, "repository")
  await mkdir(root)
  const outputDir = path.join(temporary, "release-output")
  t.after(() => rm(temporary, { recursive: true, force: true }))
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
  let checkoutChecks = 0
  let tarballReads = 0
  const output = (stdout) => (overrides.commandEnvelope ? { stdout, stderr: "" } : stdout)
  const run = async (command, args) => {
    if (command === "git" && args.join(" ") === "rev-parse HEAD") return output(`${headSha}\n`)
    if (command === "git" && args.join(" ") === `rev-list -n 1 v${VERSION}`) {
      return output(`${tagSha}\n`)
    }
    if (command === "git" && args.join(" ") === "status --porcelain=v1 --untracked-files=all") {
      checkoutChecks += 1
      return output(
        overrides.checkoutStatus ??
          (overrides.mutateRepositoryAfterSmoke && operations.includes("smoke")
            ? " M packages/sdk/package.json\n"
            : ""),
      )
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
    candidate: { ...CANDIDATE },
    inventory,
    root,
    outputDir,
    ci: { ...CI },
    prepareRun: { ...PREPARE_RUN },
    preparationAuthority: { ...(overrides.authority ?? AUTHORITY) },
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
      async lstat(target) {
        const stat = await defaultFileSystem.lstat(target)
        if (overrides.oversizedTarball && target.endsWith(".tgz")) {
          return {
            isDirectory: () => stat.isDirectory(),
            isFile: () => stat.isFile(),
            isSymbolicLink: () => stat.isSymbolicLink(),
            size: RELEASE_PAYLOAD_LIMITS.tarballBytes + 1,
          }
        }
        return stat
      },
      async readFile(target, ...args) {
        if (target.endsWith(".tgz")) tarballReads += 1
        return defaultFileSystem.readFile(target, ...args)
      },
      async writeFile(target, ...args) {
        const result = await defaultFileSystem.writeFile(target, ...args)
        if (path.basename(target) === "manifest.json") operations.push("write-manifest")
        return result
      },
    },
  }
  return {
    options,
    operations,
    outputDir,
    root,
    get checkoutChecks() {
      return checkoutChecks
    },
    get tarballReads() {
      return tarballReads
    },
  }
}

function tarArchive(entries) {
  const blocks = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, "utf8")
    header.write("0000644\0", 100, 8, "ascii")
    header.write("0000000\0", 108, 8, "ascii")
    header.write("0000000\0", 116, 8, "ascii")
    header.write(`${entry.bytes.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii")
    header.write("00000000000\0", 136, 12, "ascii")
    header.fill(0x20, 148, 156)
    header.write(entry.type ?? "0", 156, 1, "ascii")
    header.write("ustar\0", 257, 6, "ascii")
    header.write("00", 263, 2, "ascii")
    const checksum = [...header].reduce((total, byte) => total + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii")
    const padding = Buffer.alloc((512 - (entry.bytes.length % 512)) % 512)
    blocks.push(header, Buffer.from(entry.bytes), padding)
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function paxRecord(key, value) {
  let length = Buffer.byteLength(` ${key}=${value}\n`) + 1
  while (true) {
    const record = `${length} ${key}=${value}\n`
    const actual = Buffer.byteLength(record)
    if (actual === length) return record
    length = actual
  }
}

function assertRecursivelyFrozen(value) {
  if (value === null || typeof value !== "object") return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertRecursivelyFrozen(child)
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
