import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { publishRelease } from "./release-publish.mjs"

const packages = [packageInfo("@dawn-ai/core", "0.1.1"), packageInfo("@dawn-ai/sdk", "0.1.1")]

describe("publishRelease", () => {
  it("publishes unpublished versions directly to latest with git tags", async () => {
    const calls = []
    const state = registryState({
      "@dawn-ai/core": { versions: ["0.1.0"] },
      "@dawn-ai/sdk": { versions: ["0.1.0"] },
    })

    const result = await publishRelease({
      packages,
      npmView: state.view,
      run: state.runner(calls),
      log: () => {},
    })

    assert.deepEqual(calls, [
      ["publish", "@dawn-ai/core", "0.1.1", "latest"],
      ["publish", "@dawn-ai/sdk", "0.1.1", "latest"],
      ["git-tag", "@dawn-ai/core@0.1.1"],
      ["git-tag", "@dawn-ai/sdk@0.1.1"],
    ])
    assert.equal(result.status, "published")
    assert.deepEqual(result.packages, ["@dawn-ai/core@0.1.1", "@dawn-ai/sdk@0.1.1"])
  })

  it("does not create git tags when a publish fails", async () => {
    const calls = []
    const state = registryState({
      "@dawn-ai/core": { versions: ["0.1.0"] },
      "@dawn-ai/sdk": { versions: ["0.1.0"] },
    })

    await assert.rejects(
      publishRelease({
        packages,
        npmView: state.view,
        run: state.runner(calls, { failPublishFor: "@dawn-ai/sdk" }),
        log: () => {},
      }),
      /Failed to publish @dawn-ai\/sdk@0\.1\.1/,
    )

    assert.deepEqual(calls, [
      ["publish", "@dawn-ai/core", "0.1.1", "latest"],
      ["publish", "@dawn-ai/sdk", "0.1.1", "latest"],
    ])
  })

  it("skips when all versions are already published", async () => {
    const calls = []
    const state = registryState({
      "@dawn-ai/core": { versions: ["0.1.0", "0.1.1"] },
      "@dawn-ai/sdk": { versions: ["0.1.0", "0.1.1"] },
    })

    const result = await publishRelease({
      packages,
      npmView: state.view,
      run: state.runner(calls),
      log: () => {},
    })

    assert.deepEqual(calls, [])
    assert.equal(result.status, "already-published")
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
