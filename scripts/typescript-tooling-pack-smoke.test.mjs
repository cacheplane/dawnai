import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  runCommand,
  runTypeScriptToolingPackSmoke,
  TOOLING_PACKAGES,
  TSX_VERSION,
  TYPESCRIPT_VERSION,
  ZOD_VERSION,
} from "./typescript-tooling-pack-smoke.mjs"

const PACKAGE_VERSION = "0.8.14"

describe("runTypeScriptToolingPackSmoke", () => {
  it("builds and validates local packs before an exact, scriptless clean-project install", async () => {
    const harness = await createHarness()

    const result = await runTypeScriptToolingPackSmoke(harness.dependencies)

    assert.deepEqual(TOOLING_PACKAGES, [
      { dir: "packages/core", name: "@dawn-ai/core" },
      { dir: "packages/vite-plugin", name: "@dawn-ai/vite-plugin" },
    ])
    assert.deepEqual(result.installedVersions, {
      "@dawn-ai/core": PACKAGE_VERSION,
      "@dawn-ai/vite-plugin": PACKAGE_VERSION,
      tsx: TSX_VERSION,
      typescript: TYPESCRIPT_VERSION,
      zod: ZOD_VERSION,
    })

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
    assert.equal(packIndexes.length, 2)
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

async function createHarness({
  createPackageLock = false,
  failureStage,
  nativeLifecycleScript = false,
  packageValidationFailure = false,
} = {}) {
  const testRoot = await mkdtemp(join(tmpdir(), "dawn-typescript-tooling-pack-test-"))
  const tempRoot = join(testRoot, "owned-temp-root")
  const repoRoot = join(testRoot, "repo")
  const events = []

  const dependencies = {
    repoRoot,
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
      const packageJson = packedManifest(packageConfig.name)
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
      for (const name of ["@dawn-ai/core", "@dawn-ai/vite-plugin", "typescript", "tsx", "zod"]) {
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

  return { dependencies, events, repoRoot, tempRoot }
}

function packedManifest(name) {
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
  }
}

async function installFixturePackages(root) {
  const packages = {
    "@dawn-ai/core": PACKAGE_VERSION,
    "@dawn-ai/vite-plugin": PACKAGE_VERSION,
    tsx: TSX_VERSION,
    typescript: TYPESCRIPT_VERSION,
    zod: ZOD_VERSION,
  }

  for (const [name, version] of Object.entries(packages)) {
    const packageRoot = join(root, "node_modules", ...name.split("/"))
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name, version }), "utf8")
  }
}

async function readPackageManifest(packageRoot) {
  return JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
}
