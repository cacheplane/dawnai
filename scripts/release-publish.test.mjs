import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { isPackageNotFoundError, npmView, publishRelease } from "./release-publish.mjs"

const packages = [packageInfo("@dawn-ai/core", "0.1.1"), packageInfo("@dawn-ai/sdk", "0.1.1")]

function recordingFs() {
  const archived = []
  const manifests = []
  return {
    archive: async (tarballPath, archiveDir) => {
      const name = `${tarballPath.split("/").pop()}`
      archived.push({ tarballPath, archiveDir, name })
      return name
    },
    writeManifest: async (archiveDir, artifacts) => {
      manifests.push({ archiveDir, artifacts })
    },
    archived,
    manifests,
  }
}

describe("publishRelease", () => {
  it("publishes unpublished versions directly to latest with git tags", async () => {
    const calls = []
    const state = registryState({
      "@dawn-ai/core": { versions: ["0.1.0"] },
      "@dawn-ai/sdk": { versions: ["0.1.0"] },
    })
    const fs = recordingFs()

    const result = await publishRelease({
      packages,
      npmView: state.view,
      run: state.runner(calls),
      log: () => {},
      archive: fs.archive,
      writeManifest: fs.writeManifest,
    })

    assert.deepEqual(calls, [
      ["publish", "@dawn-ai/core", "0.1.1", "latest"],
      ["publish", "@dawn-ai/sdk", "0.1.1", "latest"],
      ["git-tag", "@dawn-ai/core@0.1.1"],
      ["git-tag", "@dawn-ai/sdk@0.1.1"],
    ])
    assert.equal(result.status, "published")
    assert.deepEqual(result.packages, ["@dawn-ai/core@0.1.1", "@dawn-ai/sdk@0.1.1"])
    assert.deepEqual(result.artifacts, [
      { tag: "@dawn-ai/core@0.1.1", tarball: fs.archived[0].name },
      { tag: "@dawn-ai/sdk@0.1.1", tarball: fs.archived[1].name },
    ])
    assert.equal(fs.manifests.length, 1)
    assert.deepEqual(fs.manifests[0].artifacts, result.artifacts)
  })

  it("does not create git tags when a publish fails", async () => {
    const calls = []
    const state = registryState({
      "@dawn-ai/core": { versions: ["0.1.0"] },
      "@dawn-ai/sdk": { versions: ["0.1.0"] },
    })
    const fs = recordingFs()

    await assert.rejects(
      publishRelease({
        packages,
        npmView: state.view,
        run: state.runner(calls, { failPublishFor: "@dawn-ai/sdk" }),
        log: () => {},
        archive: fs.archive,
        writeManifest: fs.writeManifest,
      }),
      /Failed to publish @dawn-ai\/sdk@0\.1\.1/,
    )

    assert.deepEqual(calls, [
      ["publish", "@dawn-ai/core", "0.1.1", "latest"],
      ["publish", "@dawn-ai/sdk", "0.1.1", "latest"],
    ])
    assert.equal(fs.manifests.length, 0)
  })

  it("skips when all versions are already published", async () => {
    const calls = []
    const state = registryState({
      "@dawn-ai/core": { versions: ["0.1.0", "0.1.1"] },
      "@dawn-ai/sdk": { versions: ["0.1.0", "0.1.1"] },
    })
    const fs = recordingFs()

    const result = await publishRelease({
      packages,
      npmView: state.view,
      run: state.runner(calls),
      log: () => {},
      archive: fs.archive,
      writeManifest: fs.writeManifest,
    })

    assert.deepEqual(calls, [])
    assert.equal(result.status, "already-published")
    assert.deepEqual(result.artifacts, [])
    assert.equal(fs.manifests.length, 0)
  })
})

describe("npmView", () => {
  it("treats a never-published package (npm E404) as having no versions", async () => {
    const run = async () => {
      throw new Error(
        "npm view @dawn-ai/sqlite-storage versions --json failed with exit code 1\n" +
          "npm error code E404\n" +
          "npm error 404 Not Found - GET https://registry.npmjs.org/@dawn-ai%2fsqlite-storage - Not found",
      )
    }

    const view = await npmView("@dawn-ai/sqlite-storage", run)

    assert.deepEqual(view, { versions: [], tags: {} })
  })

  it("rethrows non-404 npm errors", async () => {
    const run = async () => {
      throw new Error(
        "npm view ... failed with exit code 1\nnpm error code E500\nnpm error 500 Internal",
      )
    }

    await assert.rejects(npmView("@dawn-ai/core", run), /E500/)
  })

  it("parses versions and tags from a published package", async () => {
    const run = async (_command, args) => {
      if (args.includes("versions")) {
        return JSON.stringify(["0.1.0", "0.1.1"])
      }
      return JSON.stringify({ latest: "0.1.1" })
    }

    const view = await npmView("@dawn-ai/core", run)

    assert.deepEqual(view.versions, ["0.1.0", "0.1.1"])
    assert.deepEqual(view.tags, { latest: "0.1.1" })
  })
})

describe("isPackageNotFoundError", () => {
  it("is true for npm E404 errors", () => {
    assert.equal(isPackageNotFoundError(new Error("npm error code E404\n404 Not Found")), true)
  })

  it("is false for other errors", () => {
    assert.equal(isPackageNotFoundError(new Error("npm error code E500")), false)
  })
})

function packageInfo(name, version) {
  return {
    dir: `/repo/packages/${name.split("/").at(-1)}`,
    packageJson: {
      name,
      version,
      publishConfig: { access: "public" },
    },
  }
}

function registryState(initialPackages) {
  const registry = new Map(
    Object.entries(initialPackages).map(([name, info]) => [
      name,
      { versions: new Set(info.versions) },
    ]),
  )

  return {
    async view(packageName) {
      const info = registry.get(packageName)
      if (!info) {
        return { versions: [], tags: {} }
      }
      return { versions: [...info.versions], tags: {} }
    },
    runner(calls, options = {}) {
      return async (command, args, { cwdPackage }) => {
        if (command === "pnpm" && args[0] === "pack") {
          const name = cwdPackage.packageJson.name.replace("@", "").replace("/", "-")
          return `${name}-${cwdPackage.packageJson.version}.tgz\n`
        }

        if (command === "npm" && args[0] === "publish" && args[1]?.endsWith(".tgz")) {
          const tag = args[args.indexOf("--tag") + 1]

          calls.push(["publish", cwdPackage.packageJson.name, cwdPackage.packageJson.version, tag])

          if (options.failPublishFor === cwdPackage.packageJson.name) {
            throw new Error("npm publish failed")
          }

          registry.get(cwdPackage.packageJson.name).versions.add(cwdPackage.packageJson.version)
          return
        }

        if (command === "git" && args[0] === "tag") {
          calls.push(["git-tag", args[1]])
          return
        }

        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`)
      }
    },
  }
}
