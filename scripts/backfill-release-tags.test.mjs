import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { backfillReleaseTags, extractChangelogSection } from "./backfill-release-tags.mjs"

function packageInfo(name, version) {
  return { dir: `/repo/packages/${name.split("/").pop()}`, packageJson: { name, version } }
}

/**
 * Builds injected fakes with configurable per-package state:
 *   published: string[] of names whose current version is on npm
 *   tagged:    string[] of tags that already exist
 *   released:  string[] of tags that already have a GitHub Release
 */
function harness({ published = [], tagged = [], released = [] }) {
  const calls = { tags: [], releases: [] }
  return {
    calls,
    deps: {
      npmView: async (name) => ({
        versions: published.includes(name) ? ["0.0.1", "0.8.9"] : ["0.0.1"],
        tags: {},
      }),
      tagExists: async (tag) => tagged.includes(tag),
      releaseExists: async (tag) => released.includes(tag),
      createTag: async (tag) => {
        calls.tags.push(tag)
      },
      createRelease: async (tag, notes) => {
        calls.releases.push({ tag, notes })
      },
      changelogSection: async (_dir, version) => `notes for ${version}`,
      log: () => {},
    },
  }
}

describe("backfillReleaseTags", () => {
  it("skips a package whose current version is not yet published (normal path owns it)", async () => {
    const { calls, deps } = harness({ published: [] })
    const result = await backfillReleaseTags({
      packages: [packageInfo("@dawn-ai/memory-pgvector", "0.8.9")],
      ...deps,
    })
    assert.deepEqual(result, [])
    assert.deepEqual(calls.tags, [])
    assert.deepEqual(calls.releases, [])
  })

  it("is a no-op when a published package already has both a tag and a release", async () => {
    const tag = "@dawn-ai/memory@0.8.9"
    const { calls, deps } = harness({
      published: ["@dawn-ai/memory"],
      tagged: [tag],
      released: [tag],
    })
    const result = await backfillReleaseTags({
      packages: [packageInfo("@dawn-ai/memory", "0.8.9")],
      ...deps,
    })
    assert.deepEqual(result, [])
    assert.deepEqual(calls.tags, [])
    assert.deepEqual(calls.releases, [])
  })

  it("backfills tag and release for a published package missing both (bootstrap case)", async () => {
    const tag = "@dawn-ai/memory-pgvector@0.8.9"
    const { calls, deps } = harness({ published: ["@dawn-ai/memory-pgvector"] })
    const result = await backfillReleaseTags({
      packages: [packageInfo("@dawn-ai/memory-pgvector", "0.8.9")],
      ...deps,
    })
    assert.deepEqual(result, [tag])
    assert.deepEqual(calls.tags, [tag])
    assert.deepEqual(calls.releases, [{ tag, notes: "notes for 0.8.9" }])
  })

  it("backfills only the release when the tag already exists", async () => {
    const tag = "@dawn-ai/memory-pgvector@0.8.9"
    const { calls, deps } = harness({
      published: ["@dawn-ai/memory-pgvector"],
      tagged: [tag],
    })
    const result = await backfillReleaseTags({
      packages: [packageInfo("@dawn-ai/memory-pgvector", "0.8.9")],
      ...deps,
    })
    assert.deepEqual(result, [tag])
    assert.deepEqual(calls.tags, [])
    assert.deepEqual(calls.releases, [{ tag, notes: "notes for 0.8.9" }])
  })

  it("reconciles a mixed set — leaves consistent packages, backfills the stragglers", async () => {
    const { calls, deps } = harness({
      published: ["@dawn-ai/memory", "@dawn-ai/memory-pgvector"],
      tagged: ["@dawn-ai/memory@0.8.9"],
      released: ["@dawn-ai/memory@0.8.9"],
    })
    const result = await backfillReleaseTags({
      packages: [
        packageInfo("@dawn-ai/memory", "0.8.9"),
        packageInfo("@dawn-ai/memory-pgvector", "0.8.9"),
      ],
      ...deps,
    })
    assert.deepEqual(result, ["@dawn-ai/memory-pgvector@0.8.9"])
    assert.deepEqual(calls.tags, ["@dawn-ai/memory-pgvector@0.8.9"])
    assert.deepEqual(calls.releases, [
      { tag: "@dawn-ai/memory-pgvector@0.8.9", notes: "notes for 0.8.9" },
    ])
  })
})

describe("extractChangelogSection", () => {
  const changelog = [
    "# @dawn-ai/memory-pgvector",
    "",
    "## 0.8.9",
    "",
    "### Patch Changes",
    "",
    "- Add the pgvector backend.",
    "",
    "## 0.8.8",
    "",
    "- Older stuff.",
    "",
  ].join("\n")

  it("extracts the body of the matching version section", () => {
    assert.equal(
      extractChangelogSection(changelog, "0.8.9"),
      "### Patch Changes\n\n- Add the pgvector backend.",
    )
  })

  it("stops at the next version heading", () => {
    assert.equal(extractChangelogSection(changelog, "0.8.8"), "- Older stuff.")
  })

  it("returns an empty string when the version is absent", () => {
    assert.equal(extractChangelogSection(changelog, "9.9.9"), "")
  })
})
