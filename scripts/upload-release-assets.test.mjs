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
})
