import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { publishRelease } from "./release-publish.mjs"

const packages = [packageInfo("@dawn-ai/core", "0.1.1"), packageInfo("@dawn-ai/sdk", "0.1.1")]

describe("publishRelease", () => {
  it("publishes missing versions directly to latest", async () => {
    const calls = []
    const state = registryState({
      "@dawn-ai/core": { versions: ["0.1.0"], latest: "0.1.0" },
      "@dawn-ai/sdk": { versions: ["0.1.0"], latest: "0.1.0" },
    })

    await publishRelease({
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
  })

  it("does not create git tags when any package fails to publish", async () => {
    const calls = []
    const state = registryState({
      "@dawn-ai/core": { versions: ["0.1.0"], latest: "0.1.0" },
      "@dawn-ai/sdk": { versions: ["0.1.0"], latest: "0.1.0" },
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

  it("promotes already-published versions that are not on latest", async () => {
    const calls = []
    const state = registryState({
      "@dawn-ai/core": { versions: ["0.1.0", "0.1.1"], latest: "0.1.0" },
      "@dawn-ai/sdk": { versions: ["0.1.0", "0.1.1"], latest: "0.1.0" },
    })

    await publishRelease({
      packages,
      npmView: state.view,
      run: state.runner(calls),
      log: () => {},
    })

    assert.deepEqual(calls, [
      ["dist-tag", "@dawn-ai/core", "0.1.1", "latest"],
      ["dist-tag", "@dawn-ai/sdk", "0.1.1", "latest"],
      ["git-tag", "@dawn-ai/core@0.1.1"],
      ["git-tag", "@dawn-ai/sdk@0.1.1"],
    ])
  })

  it("retries verification when registry has propagation delay", async () => {
    const calls = []
    let viewCallCount = 0
    const state = registryState({
      "@dawn-ai/core": { versions: ["0.1.0"], latest: "0.1.0" },
      "@dawn-ai/sdk": { versions: ["0.1.0"], latest: "0.1.0" },
    })

    // Wrap view to simulate propagation delay: sdk latest tag not visible until later
    const delayedView = async (packageName) => {
      viewCallCount++
      const result = await state.view(packageName)
      if (packageName === "@dawn-ai/sdk" && viewCallCount <= 4) {
        return { versions: result.versions, tags: { latest: "0.1.0" } }
      }
      return result
    }

    await publishRelease({
      packages,
      npmView: delayedView,
      run: state.runner(calls),
      log: () => {},
    })

    assert.deepEqual(calls, [
      ["publish", "@dawn-ai/core", "0.1.1", "latest"],
      ["publish", "@dawn-ai/sdk", "0.1.1", "latest"],
      ["git-tag", "@dawn-ai/core@0.1.1"],
      ["git-tag", "@dawn-ai/sdk@0.1.1"],
    ])
    // Verify retry happened
    assert.ok(viewCallCount > 4, `Expected retries but only got ${viewCallCount} view calls`)
  })

  it("skips packages that are already published on latest", async () => {
    const calls = []
    const state = registryState({
      "@dawn-ai/core": { versions: ["0.1.0", "0.1.1"], latest: "0.1.1" },
      "@dawn-ai/sdk": { versions: ["0.1.0", "0.1.1"], latest: "0.1.1" },
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
      {
        versions: new Set(info.versions),
        latest: info.latest,
      },
    ]),
  )

  return {
    async view(packageName) {
      const info = registry.get(packageName)
      if (!info) {
        return { versions: [], tags: {} }
      }

      return {
        versions: [...info.versions],
        tags: { latest: info.latest },
      }
    },
    runner(calls, options = {}) {
      return async (command, args, { cwdPackage }) => {
        if (command === "pnpm" && args[0] === "pack") {
          const name = cwdPackage.packageJson.name.replace("@", "").replace("/", "-")
          return `${name}-${cwdPackage.packageJson.version}.tgz\n`
        }

        if (command === "npm" && args[0] === "publish" && args[1]?.endsWith(".tgz")) {
          const tag = args[args.indexOf("--tag") + 1]
          const info = registry.get(cwdPackage.packageJson.name)

          calls.push(["publish", cwdPackage.packageJson.name, cwdPackage.packageJson.version, tag])

          if (options.failPublishFor === cwdPackage.packageJson.name) {
            throw new Error("npm publish failed")
          }

          info.versions.add(cwdPackage.packageJson.version)
          info.latest = cwdPackage.packageJson.version
          return
        }

        if (command === "npm" && args[0] === "dist-tag" && args[1] === "add") {
          const [name, version] = splitPackageSpec(args[2])
          const tag = args[3]
          const info = registry.get(name)

          calls.push(["dist-tag", name, version, tag])
          info.latest = version
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

function splitPackageSpec(spec) {
  const atIndex = spec.lastIndexOf("@")
  return [spec.slice(0, atIndex), spec.slice(atIndex + 1)]
}
