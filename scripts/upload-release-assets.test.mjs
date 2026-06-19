import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { uploadReleaseAssets } from "./upload-release-assets.mjs"

const manifest = [
  { tag: "@dawn-ai/core@0.1.1", tarball: "dawn-ai-core-0.1.1.tgz" },
  { tag: "@dawn-ai/sdk@0.1.1", tarball: "dawn-ai-sdk-0.1.1.tgz" },
]

function fakeDeps() {
  const calls = []
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, ...args])
      return ""
    },
    copyProvenance: async (bundlePath, destPath) => {
      calls.push(["copy", bundlePath, destPath])
    },
  }
}

describe("uploadReleaseAssets", () => {
  it("uploads tarball + provenance to each release", async () => {
    const d = fakeDeps()
    const uploaded = await uploadReleaseAssets({
      manifest,
      archiveDir: "/art",
      bundlePath: "/art/attestation.jsonl",
      run: d.run,
      copyProvenance: d.copyProvenance,
      log: () => {},
    })

    assert.deepEqual(uploaded, ["@dawn-ai/core@0.1.1", "@dawn-ai/sdk@0.1.1"])
    assert.deepEqual(d.calls, [
      ["copy", "/art/attestation.jsonl", "/art/dawn-ai-core-0.1.1.intoto.jsonl"],
      [
        "gh",
        "release",
        "upload",
        "@dawn-ai/core@0.1.1",
        "/art/dawn-ai-core-0.1.1.tgz",
        "/art/dawn-ai-core-0.1.1.intoto.jsonl",
        "--clobber",
      ],
      ["copy", "/art/attestation.jsonl", "/art/dawn-ai-sdk-0.1.1.intoto.jsonl"],
      [
        "gh",
        "release",
        "upload",
        "@dawn-ai/sdk@0.1.1",
        "/art/dawn-ai-sdk-0.1.1.tgz",
        "/art/dawn-ai-sdk-0.1.1.intoto.jsonl",
        "--clobber",
      ],
    ])
  })

  it("returns [] and makes no calls for an empty manifest", async () => {
    const d = fakeDeps()
    const uploaded = await uploadReleaseAssets({
      manifest: [],
      archiveDir: "/art",
      bundlePath: "/art/attestation.jsonl",
      run: d.run,
      copyProvenance: d.copyProvenance,
      log: () => {},
    })

    assert.deepEqual(uploaded, [])
    assert.deepEqual(d.calls, [])
  })

  it("rejects with a clear error when the manifest is not an array", async () => {
    const d = fakeDeps()
    await assert.rejects(
      uploadReleaseAssets({
        manifest: { tag: "x", tarball: "x.tgz" },
        archiveDir: "/art",
        bundlePath: "/art/attestation.jsonl",
        run: d.run,
        copyProvenance: d.copyProvenance,
        log: () => {},
      }),
      /Invalid release manifest: expected an array/,
    )
  })

  it("rejects with a clear error when a manifest entry is missing tarball", async () => {
    const d = fakeDeps()
    await assert.rejects(
      uploadReleaseAssets({
        manifest: [{ tag: "x" }],
        archiveDir: "/art",
        bundlePath: "/art/attestation.jsonl",
        run: d.run,
        copyProvenance: d.copyProvenance,
        log: () => {},
      }),
      /Invalid release manifest: entry 0 missing tag\/tarball/,
    )
  })

  it("rejects when run throws on the second entry and still attempted the first upload", async () => {
    // Re-running uploadReleaseAssets after a partial failure is safe because gh release upload
    // uses --clobber, which overwrites already-uploaded assets without error.
    const calls = []
    let callIndex = 0
    const run = async (command, args) => {
      calls.push([command, ...args])
      callIndex++
      if (callIndex === 2) {
        // Second gh call (second entry's upload) throws
        throw new Error("gh release upload failed")
      }
    }
    const copyProvenance = async (bundlePath, destPath) => {
      calls.push(["copy", bundlePath, destPath])
    }

    await assert.rejects(
      uploadReleaseAssets({
        manifest,
        archiveDir: "/art",
        bundlePath: "/art/attestation.jsonl",
        run,
        copyProvenance,
        log: () => {},
      }),
      /gh release upload failed/,
    )

    // First entry's upload was attempted before the failure
    assert.ok(
      calls.some(
        (c) =>
          c[0] === "gh" &&
          c[1] === "release" &&
          c[2] === "upload" &&
          c[3] === "@dawn-ai/core@0.1.1",
      ),
      "expected first entry upload to have been attempted",
    )
  })
})
