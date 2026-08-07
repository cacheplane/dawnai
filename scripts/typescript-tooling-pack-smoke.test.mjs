import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import {
  assertPackedClosureIsComplete,
  packWorkspacePackage,
  runCommand,
  runTypeScriptToolingPackSmoke,
  TOOLING_PACKAGES,
  TSX_VERSION,
  TYPESCRIPT_VERSION,
  ZOD_VERSION,
} from "./typescript-tooling-pack-smoke.mjs"

const PACKAGE_VERSION = "0.8.14"
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

describe("runTypeScriptToolingPackSmoke", () => {
  it("builds and validates local packs before an exact, scriptless clean-project install", async () => {
    const harness = await createHarness()

    const result = await runTypeScriptToolingPackSmoke(harness.dependencies)

    assert.deepEqual(TOOLING_PACKAGES, [
      { dir: "packages/sdk", name: "@dawn-ai/sdk" },
      { dir: "packages/permissions", name: "@dawn-ai/permissions" },
      { dir: "packages/sqlite-storage", name: "@dawn-ai/sqlite-storage" },
      { dir: "packages/workspace", name: "@dawn-ai/workspace" },
      { dir: "packages/core", name: "@dawn-ai/core" },
      { dir: "packages/vite-plugin", name: "@dawn-ai/vite-plugin" },
    ])
    assert.deepEqual(result.installedVersions, {
      "@dawn-ai/core": PACKAGE_VERSION,
      "@dawn-ai/permissions": PACKAGE_VERSION,
      "@dawn-ai/sdk": PACKAGE_VERSION,
      "@dawn-ai/sqlite-storage": PACKAGE_VERSION,
      "@dawn-ai/vite-plugin": PACKAGE_VERSION,
      "@dawn-ai/workspace": PACKAGE_VERSION,
      tsx: TSX_VERSION,
      typescript: TYPESCRIPT_VERSION,
      zod: ZOD_VERSION,
    })
    assert.equal(
      result.coreEntryPath,
      join(harness.canonicalTempRoot, "consumer", "node_modules", "@dawn-ai", "core", "index.js"),
    )

    const buildIndex = harness.events.findIndex(
      (event) => event.type === "command" && event.args[0] === "--filter",
    )
    const packIndexes = harness.events
      .map((event, index) => (event.type === "pack" ? index : -1))
      .filter((index) => index !== -1)
    const installIndex = harness.events.findIndex(
      (event) => event.type === "command" && event.command === "npm",
    )
    const probeIndex = harness.events.findIndex((event) => event.type === "probe")

    assert.notEqual(buildIndex, -1)
    assert.deepEqual(harness.events[buildIndex], {
      type: "command",
      command: "pnpm",
      args: ["--filter", "@dawn-ai/vite-plugin...", "build"],
      cwd: harness.repoRoot,
    })
    assert.equal(packIndexes.length, TOOLING_PACKAGES.length)
    assert.ok(packIndexes.every((index) => index > buildIndex && index < installIndex))
    assert.deepEqual(
      packIndexes.map((index) => harness.events[index].packageConfig),
      TOOLING_PACKAGES,
    )

    const install = harness.events[installIndex]
    assert.equal(install.cleanBeforeInstall, true)
    assert.deepEqual(install.args, [
      "install",
      "--ignore-scripts",
      "--save-exact",
      "--package-lock=false",
      join(harness.tempRoot, "packs", "dawn-ai-sdk-0.8.14.tgz"),
      join(harness.tempRoot, "packs", "dawn-ai-permissions-0.8.14.tgz"),
      join(harness.tempRoot, "packs", "dawn-ai-sqlite-storage-0.8.14.tgz"),
      join(harness.tempRoot, "packs", "dawn-ai-workspace-0.8.14.tgz"),
      join(harness.tempRoot, "packs", "dawn-ai-core-0.8.14.tgz"),
      join(harness.tempRoot, "packs", "dawn-ai-vite-plugin-0.8.14.tgz"),
      `typescript@${TYPESCRIPT_VERSION}`,
      `tsx@${TSX_VERSION}`,
      `zod@${ZOD_VERSION}`,
    ])
    assert.ok(
      harness.events
        .filter((event) => event.type === "validate-pack")
        .every((event) => harness.events.indexOf(event) < installIndex),
    )
    assert.ok(harness.events.some((event) => event.type === "inspect-installed"))
    assert.ok(probeIndex > installIndex)
    assert.deepEqual(harness.events[probeIndex], {
      type: "probe",
      root: join(harness.tempRoot, "consumer"),
      expectedTypeScriptVersion: TYPESCRIPT_VERSION,
    })

    const commandsAfterInstall = harness.events
      .slice(installIndex + 1)
      .filter((event) => event.type === "command")
    assert.deepEqual(
      commandsAfterInstall.map(({ command, args }) => ({ command, args })),
      [
        { command: process.execPath, args: ["runtime-probe.mjs"] },
        { command: process.execPath, args: ["typescript-tsc.mjs", "--noEmit"] },
      ],
    )
    assert.equal(harness.events.at(-1).type, "cleanup")
    assert.equal(existsSync(harness.tempRoot), false)
  })

  it("rejects packed manifests with unresolved workspace and file dependency specs", async () => {
    const harness = await createHarness({ packageValidationFailure: true })

    await assert.rejects(
      runTypeScriptToolingPackSmoke(harness.dependencies),
      /(?=.*@dawn-ai\/core@0\.8\.14)(?=.*unpublished dependency specs)(?=.*workspace:\*)(?=.*file:)/s,
    )
    assert.equal(
      harness.events.some((event) => event.type === "command" && event.command === "npm"),
      false,
    )
    assert.equal(harness.events.at(-1).type, "cleanup")
    assert.equal(existsSync(harness.tempRoot), false)
  })

  for (const coreDependency of ["^0.8.14", "0.8.13"]) {
    it(`rejects packed Vite Core dependency ${coreDependency} before install`, async () => {
      const harness = await createHarness({ packedCoreDependency: coreDependency })

      await assert.rejects(
        runTypeScriptToolingPackSmoke(harness.dependencies),
        new RegExp(
          `@dawn-ai/vite-plugin.*@dawn-ai/core.*${escapeRegExp(coreDependency)}.*expected ${PACKAGE_VERSION}`,
          "s",
        ),
      )
      assert.equal(
        harness.events.some((event) => event.type === "command" && event.command === "npm"),
        false,
      )
      assert.equal(harness.events.at(-1).type, "cleanup")
      assert.equal(existsSync(harness.tempRoot), false)
    })
  }

  it("rejects native lifecycle scripts discovered in the installed package tree", async () => {
    const harness = await createHarness({ nativeLifecycleScript: true })

    await assert.rejects(
      runTypeScriptToolingPackSmoke(harness.dependencies),
      /native-addon@1\.0\.0.*install.*node-gyp rebuild/s,
    )
    assert.equal(
      harness.events.some((event) => event.type === "probe"),
      false,
    )
    assert.equal(harness.events.at(-1).type, "cleanup")
    assert.equal(existsSync(harness.tempRoot), false)
  })

  it("rejects an install that creates a package lock", async () => {
    const harness = await createHarness({ createPackageLock: true })

    await assert.rejects(
      runTypeScriptToolingPackSmoke(harness.dependencies),
      /consumer unexpectedly created package-lock\.json/,
    )
    assert.equal(
      harness.events.some((event) => event.type === "probe"),
      false,
    )
    assert.equal(harness.events.at(-1).type, "cleanup")
    assert.equal(existsSync(harness.tempRoot), false)
  })

  it("rejects Vite resolving a nested Core instead of the root artifact", async () => {
    const harness = await createHarness({ nestedViteCore: true })

    await assert.rejects(
      runTypeScriptToolingPackSmoke(harness.dependencies),
      /Vite resolves @dawn-ai\/core to .* expected root artifact/s,
    )
    assert.equal(
      harness.events.some((event) => event.type === "probe"),
      false,
    )
    assert.equal(harness.events.at(-1).type, "cleanup")
    assert.equal(existsSync(harness.tempRoot), false)
  })

  for (const failureStage of ["install", "runtime", "tsc"]) {
    it(`always cleans up after ${failureStage} failure`, async () => {
      const harness = await createHarness({ failureStage })

      await assert.rejects(
        runTypeScriptToolingPackSmoke(harness.dependencies),
        new RegExp(`${failureStage} failure`),
      )
      assert.equal(harness.events.at(-1).type, "cleanup")
      assert.equal(existsSync(harness.tempRoot), false)
    })
  }
})

describe("runCommand", () => {
  it("retains the command, exit status, stdout, and stderr on failure", async () => {
    await assert.rejects(
      runCommand(process.execPath, [
        "-e",
        "process.stdout.write('useful stdout'); process.stderr.write('useful stderr'); process.exit(23)",
      ]),
      (error) => {
        assert.match(error.message, /node .*failed with exit code 23/s)
        assert.match(error.message, /stdout:\s*useful stdout/s)
        assert.match(error.message, /stderr:\s*useful stderr/s)
        return true
      },
    )
  })
})

describe("assertPackedClosureIsComplete", () => {
  it("accepts the real TOOLING_PACKAGES against the real workspace", async () => {
    // The regression guard. An unpacked workspace dependency resolves from the public
    // registry at the version pnpm pack stamped in — which exists on every ordinary
    // commit and does NOT exist on the release commit, so the hole is invisible until
    // it fails the publish. 0.8.17 died here on @dawn-ai/permissions.
    await assertPackedClosureIsComplete()
  })

  it("rejects a workspace dependency that is not itself packed", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "dawn-closure-"))
    try {
      await writeWorkspaceManifest(testRoot, "packages/core", "@dawn-ai/core", {
        "@dawn-ai/permissions": "workspace:*",
      })

      await assert.rejects(
        assertPackedClosureIsComplete({
          packages: [{ dir: "packages/core", name: "@dawn-ai/core" }],
          repoRoot: testRoot,
        }),
        /@dawn-ai\/core -> @dawn-ai\/permissions.*Add them to TOOLING_PACKAGES/s,
      )
    } finally {
      await rm(testRoot, { force: true, recursive: true })
    }
  })

  it("accepts a closed set and ignores registry dependencies", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "dawn-closure-"))
    try {
      await writeWorkspaceManifest(testRoot, "packages/core", "@dawn-ai/core", {
        "@dawn-ai/permissions": "workspace:*",
        zod: "^4.4.3",
      })
      await writeWorkspaceManifest(testRoot, "packages/permissions", "@dawn-ai/permissions", {})

      await assertPackedClosureIsComplete({
        packages: [
          { dir: "packages/core", name: "@dawn-ai/core" },
          { dir: "packages/permissions", name: "@dawn-ai/permissions" },
        ],
        repoRoot: testRoot,
      })
    } finally {
      await rm(testRoot, { force: true, recursive: true })
    }
  })
})

describe("verify:typescript-tooling-pack", () => {
  it("runs unit tests before the real smoke and stops when unit tests fail", async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"))
    const verifyScript = packageJson.scripts["verify:typescript-tooling-pack"]
    assert.equal(
      verifyScript,
      "pnpm test:typescript-tooling-pack-smoke && node scripts/typescript-tooling-pack-smoke.mjs",
    )

    const root = await mkdtemp(join(tmpdir(), "dawn-typescript-tooling-script-test-"))
    try {
      const binDir = join(root, "bin")
      const unitMarker = join(root, "unit-marker")
      const realMarker = join(root, "real-marker")
      await mkdir(binDir)
      await Promise.all([
        writeExecutable(
          join(binDir, "pnpm"),
          `#!/bin/sh\nprintf '%s' "$*" > ${shellQuote(unitMarker)}\nexit 17\n`,
        ),
        writeExecutable(
          join(binDir, "node"),
          `#!/bin/sh\nprintf '%s' "$*" > ${shellQuote(realMarker)}\n`,
        ),
      ])

      const result = spawnSync("/bin/sh", ["-c", verifyScript], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: binDir },
      })

      assert.equal(result.status, 17)
      assert.equal(await readFile(unitMarker, "utf8"), "test:typescript-tooling-pack-smoke")
      assert.equal(existsSync(realMarker), false)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe("packWorkspacePackage", () => {
  for (const tarballCount of [0, 2]) {
    it(`rejects when pnpm pack produces ${tarballCount} tarballs`, async () => {
      const fixture = await createPackFixture()
      try {
        await assert.rejects(
          packWorkspacePackage({
            ...fixture.options,
            async runCommand(command) {
              if (command !== "pnpm") return
              await Promise.all(
                Array.from({ length: tarballCount }, (_, index) =>
                  writeFile(join(fixture.packDir, `artifact-${index}.tgz`), "", "utf8"),
                ),
              )
            },
          }),
          new RegExp(`@dawn-ai/core pack produced ${tarballCount} new tarballs.*expected 1`),
        )
      } finally {
        await fixture.cleanup()
      }
    })
  }

  it("reports a missing extracted package manifest with package context", async () => {
    const fixture = await createPackFixture()
    try {
      await assert.rejects(
        packWorkspacePackage({
          ...fixture.options,
          runCommand: extractedManifestCommand(fixture, null),
        }),
        /@dawn-ai\/core.*missing extracted package\.json/,
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it("reports a malformed extracted package manifest with package context", async () => {
    const fixture = await createPackFixture()
    try {
      await assert.rejects(
        packWorkspacePackage({
          ...fixture.options,
          runCommand: extractedManifestCommand(fixture, "{"),
        }),
        /@dawn-ai\/core.*invalid extracted package\.json/,
      )
    } finally {
      await fixture.cleanup()
    }
  })
})

async function createHarness({
  createPackageLock = false,
  failureStage,
  nativeLifecycleScript = false,
  nestedViteCore = false,
  packedCoreDependency = PACKAGE_VERSION,
  packageValidationFailure = false,
} = {}) {
  const testRoot = await mkdtemp(join(tmpdir(), "dawn-typescript-tooling-pack-test-"))
  const tempRoot = join(testRoot, "owned-temp-root")
  const canonicalTempRoot = join(await realpath(testRoot), "owned-temp-root")
  const repoRoot = join(testRoot, "repo")
  const events = []

  const dependencies = {
    repoRoot,
    // The harness repo is synthetic and has no package manifests. The closure rule
    // itself is covered directly in the assertPackedClosureIsComplete suite below.
    async assertPackedClosureIsComplete() {
      events.push({ type: "closure-check" })
    },
    async makeTempDir(prefix) {
      assert.equal(prefix, "dawn-typescript-tooling-pack-")
      await mkdir(tempRoot)
      return tempRoot
    },
    async removeDir(path) {
      events.push({ type: "cleanup", path })
      await rm(path, { force: true, recursive: true })
      await rm(testRoot, { force: true, recursive: true })
    },
    async packWorkspacePackage({ packageConfig, packDir }) {
      events.push({ type: "pack", packageConfig: { ...packageConfig } })
      const packageJson = packedManifest(packageConfig.name, { packedCoreDependency })
      if (packageValidationFailure && packageConfig.name === "@dawn-ai/core") {
        packageJson.dependencies = {
          local: "file:../local",
          workspace: "workspace:*",
        }
      }
      return {
        packageJson,
        packageName: packageConfig.name,
        packageVersion: PACKAGE_VERSION,
        tarballPath: join(
          packDir,
          `${packageConfig.name.slice(1).replaceAll("/", "-")}-${PACKAGE_VERSION}.tgz`,
        ),
      }
    },
    async readInstalledPackageManifests(nodeModulesDir) {
      events.push({ type: "inspect-installed", nodeModulesDir })
      const manifests = []
      for (const name of [
        "@dawn-ai/core",
        "@dawn-ai/sdk",
        "@dawn-ai/vite-plugin",
        "typescript",
        "tsx",
        "zod",
      ]) {
        manifests.push({
          manifest: await readPackageManifest(join(nodeModulesDir, ...name.split("/"))),
        })
      }
      if (nativeLifecycleScript) {
        manifests.push({
          manifest: {
            name: "native-addon",
            scripts: { install: "node-gyp rebuild" },
            version: "1.0.0",
          },
        })
      }
      return manifests
    },
    async runCommand(command, args, options = {}) {
      const event = { type: "command", command, args: [...args], cwd: options.cwd }
      events.push(event)

      if (command === "npm") {
        event.cleanBeforeInstall =
          existsSync(join(options.cwd, "package.json")) &&
          !existsSync(join(options.cwd, "package-lock.json")) &&
          !existsSync(join(options.cwd, "node_modules"))
        if (failureStage === "install") {
          throw new Error("install failure with useful context")
        }
        await installFixturePackages(options.cwd)
        if (nestedViteCore) {
          await writeFixturePackage(
            join(
              options.cwd,
              "node_modules",
              "@dawn-ai",
              "vite-plugin",
              "node_modules",
              "@dawn-ai",
              "core",
            ),
            "@dawn-ai/core",
            PACKAGE_VERSION,
          )
        }
        if (createPackageLock) {
          await writeFile(join(options.cwd, "package-lock.json"), "{}\n", "utf8")
        }
      }

      if (args[0] === "runtime-probe.mjs" && failureStage === "runtime") {
        throw new Error("runtime failure with useful context")
      }
      if (args[0] === "typescript-tsc.mjs" && failureStage === "tsc") {
        throw new Error("tsc failure with useful context")
      }

      return { stderr: "", stdout: "" }
    },
    async runTypeScriptToolingProbe({ root, expectedTypeScriptVersion, runCommand: command }) {
      events.push({ type: "probe", root, expectedTypeScriptVersion })
      await command(process.execPath, ["runtime-probe.mjs"], { cwd: root })
      await command(process.execPath, ["typescript-tsc.mjs", "--noEmit"], { cwd: root })
    },
    onPackedArtifactValidated(artifact) {
      events.push({ type: "validate-pack", packageName: artifact.packageName })
    },
  }

  return { canonicalTempRoot, dependencies, events, repoRoot, tempRoot }
}

function packedManifest(name, { packedCoreDependency = PACKAGE_VERSION } = {}) {
  return {
    bugs: { url: "https://github.com/cacheplane/dawnai/issues" },
    engines: { node: ">=22.12.0" },
    exports: { ".": { default: "./dist/index.js", types: "./dist/index.d.ts" } },
    homepage: `https://github.com/cacheplane/dawnai/tree/main/${name}`,
    license: "MIT",
    name,
    publishConfig: { access: "public" },
    repository: { type: "git", url: "git+https://github.com/cacheplane/dawnai.git" },
    types: "./dist/index.d.ts",
    version: PACKAGE_VERSION,
    ...(name === "@dawn-ai/vite-plugin"
      ? { dependencies: { "@dawn-ai/core": packedCoreDependency } }
      : {}),
  }
}

async function installFixturePackages(root) {
  const packages = {
    "@dawn-ai/core": PACKAGE_VERSION,
    "@dawn-ai/permissions": PACKAGE_VERSION,
    "@dawn-ai/sdk": PACKAGE_VERSION,
    "@dawn-ai/sqlite-storage": PACKAGE_VERSION,
    "@dawn-ai/vite-plugin": PACKAGE_VERSION,
    "@dawn-ai/workspace": PACKAGE_VERSION,
    tsx: TSX_VERSION,
    typescript: TYPESCRIPT_VERSION,
    zod: ZOD_VERSION,
  }

  for (const [name, version] of Object.entries(packages)) {
    const packageRoot = join(root, "node_modules", ...name.split("/"))
    await writeFixturePackage(packageRoot, name, version)
  }
}

async function readPackageManifest(packageRoot) {
  return JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
}

async function writeFixturePackage(packageRoot, name, version) {
  await mkdir(packageRoot, { recursive: true })
  await Promise.all([
    writeFile(join(packageRoot, "index.js"), "export {}\n", "utf8"),
    writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ main: "./index.js", name, type: "module", version }),
      "utf8",
    ),
  ])
}

async function writeExecutable(path, contents) {
  await writeFile(path, contents, "utf8")
  await chmod(path, 0o755)
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function createPackFixture() {
  const root = await mkdtemp(join(tmpdir(), "dawn-typescript-tooling-pack-selector-test-"))
  const packageDir = join(root, "repo", "packages", "core")
  const packDir = join(root, "packs")
  await Promise.all([mkdir(packageDir, { recursive: true }), mkdir(packDir)])
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "@dawn-ai/core", version: PACKAGE_VERSION }),
    "utf8",
  )

  return {
    async cleanup() {
      await rm(root, { force: true, recursive: true })
    },
    options: {
      packageConfig: { dir: "packages/core", name: "@dawn-ai/core" },
      packDir,
      repoRoot: join(root, "repo"),
    },
    packDir,
  }
}

function extractedManifestCommand(fixture, manifestSource) {
  return async (command, args) => {
    if (command === "pnpm") {
      await writeFile(join(fixture.packDir, "artifact.tgz"), "", "utf8")
      return
    }
    if (manifestSource !== null) {
      const extractDir = args[args.indexOf("-C") + 1]
      await mkdir(join(extractDir, "package"), { recursive: true })
      await writeFile(join(extractDir, "package", "package.json"), manifestSource, "utf8")
    }
  }
}

async function writeWorkspaceManifest(root, dir, name, dependencies) {
  const packageDir = join(root, dir)
  await mkdir(packageDir, { recursive: true })
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ dependencies, name, version: PACKAGE_VERSION }),
    "utf8",
  )
}
