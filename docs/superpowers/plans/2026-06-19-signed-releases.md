# Signed Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach each published package tarball plus a Sigstore SLSA provenance file (`*.intoto.jsonl`) to its GitHub Release, so OSSF Scorecard's Signed-Releases check finds a recognized signature asset.

**Architecture:** `release-publish.mjs` keeps each published tarball in `release-artifacts/` and writes a `manifest.json`. `release.yml` then runs `actions/attest-build-provenance` over those tarballs (keyless OIDC) and a new `upload-release-assets.mjs` uploads, for each of the 15 per-package releases, the tarball + a `.intoto.jsonl`-named copy of the attestation bundle. Pure logic is dependency-injected and unit-tested with `node --test`; the end-to-end signing is verified on the next real release.

**Tech Stack:** Node ESM scripts (`node:fs/promises`, `node:test`), GitHub Actions, `actions/attest-build-provenance`, `gh` CLI, changesets.

**Reference spec:** `docs/superpowers/specs/2026-06-19-signed-releases-design.md`

**Branch:** `blove/signed-releases` (already created off `main`). Do not switch branches.

**Pinned action SHA:** `actions/attest-build-provenance@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # v4.1.0`

**Existing patterns to follow:**
- `scripts/release-publish.mjs` exports `publishRelease({ packages, npmView, run, log })`; dependencies are injected (`run`, `npmView`, `log`). Today it does `pnpm pack` → `npm publish <tarball> --provenance` → `rm` tarball → `git tag`. Returns `{ status, packages: [name@version, …] }`.
- `scripts/release-publish.test.mjs` uses `node:test` with an injected fake `run` that records calls and returns a fake `.tgz` path for `pnpm pack`.
- `package.json`: `release:publish = node scripts/release-publish.mjs`, `test:release-publish = node --test scripts/release-publish.test.mjs`, and `ci:validate` chains the release-publish test.

---

### Task 1: Retain published tarballs and write a manifest

Change `publishRelease` to move each published tarball into `release-artifacts/` (instead of deleting it) and write `release-artifacts/manifest.json` mapping each release tag to its tarball filename. Keep the dependency-injection style so the unit test stays offline.

**Files:**
- Modify: `scripts/release-publish.mjs`
- Modify: `scripts/release-publish.test.mjs`

- [ ] **Step 1: Add injectable archive + manifest writer to `publishRelease`**

In `scripts/release-publish.mjs`, change the `publishRelease` signature and body. Replace the `rm` import usage and the per-package `await rm(tarballPath, { force: true })` with an archive call, accumulate artifacts, and write a manifest at the end. New signature and relevant body:

```js
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"

// ... (readPublicPackages etc. unchanged) ...

export async function publishRelease({
  packages,
  npmView,
  run,
  log,
  archiveDir = resolve(repoRoot, "release-artifacts"),
  archive = defaultArchive,
  writeManifest = defaultWriteManifest,
}) {
  const packageStates = await readPackageStates(packages, npmView)
  const unpublished = packageStates.filter((state) => !state.versions.includes(state.version))

  if (unpublished.length === 0) {
    return { status: "already-published", packages: [] }
  }

  const artifacts = []

  for (const state of unpublished) {
    log(`Publishing ${state.name}@${state.version}`)

    try {
      const packOutput = await run("pnpm", ["pack", "--pack-destination", state.dir], {
        cwd: state.dir,
        cwdPackage: state.package,
        stdio: "pipe",
      })
      const tarball = packOutput
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .find((l) => l.endsWith(".tgz"))

      if (!tarball) {
        throw new Error(`Could not determine tarball name from pnpm pack output`)
      }

      const tarballPath = resolve(state.dir, basename(tarball))

      await run(
        "npm",
        ["publish", tarballPath, "--tag", "latest", "--access", state.access, "--provenance"],
        { cwd: state.dir, cwdPackage: state.package },
      )

      const tag = `${state.name}@${state.version}`
      const archivedName = await archive(tarballPath, archiveDir)
      artifacts.push({ tag, tarball: archivedName })
    } catch (error) {
      throw new Error(`Failed to publish ${state.name}@${state.version}: ${formatError(error)}`)
    }
  }

  for (const state of unpublished) {
    const tagName = `${state.name}@${state.version}`
    await run("git", ["tag", tagName], { cwd: repoRoot, cwdPackage: state.package })
    log(`New tag: ${tagName}`)
  }

  await writeManifest(archiveDir, artifacts)

  return {
    status: "published",
    packages: unpublished.map((state) => `${state.name}@${state.version}`),
    artifacts,
  }
}

async function defaultArchive(tarballPath, archiveDir) {
  await mkdir(archiveDir, { recursive: true })
  const name = basename(tarballPath)
  await rename(tarballPath, resolve(archiveDir, name))
  return name
}

async function defaultWriteManifest(archiveDir, artifacts) {
  await mkdir(archiveDir, { recursive: true })
  await writeFile(resolve(archiveDir, "manifest.json"), `${JSON.stringify(artifacts, null, 2)}\n`)
}
```

Note: `rm` may now be unused — remove it from the import if so (the import line above keeps it only if still referenced elsewhere; `readPackageStates`/`npmView` do not use it, so delete `rm` from the import list).

- [ ] **Step 2: Update the existing tests to inject archive + writeManifest, and assert artifacts**

In `scripts/release-publish.test.mjs`, every `publishRelease({ … })` call must now inject `archive` and `writeManifest` fakes so no real filesystem work happens. Add a shared helper near the top and thread it in. Example for the first test (apply the same `archive`/`writeManifest` injection to all `publishRelease` calls in the file):

```js
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
```

Then in the "publishes unpublished versions" test:

```js
const fs = recordingFs()
const result = await publishRelease({
  packages,
  npmView: state.view,
  run: state.runner(calls),
  log: () => {},
  archive: fs.archive,
  writeManifest: fs.writeManifest,
})

// existing assertions on `calls` and `result.status` stay …
assert.deepEqual(result.artifacts, [
  { tag: "@dawn-ai/core@0.1.1", tarball: fs.archived[0].name },
  { tag: "@dawn-ai/sdk@0.1.1", tarball: fs.archived[1].name },
])
assert.equal(fs.manifests.length, 1)
assert.deepEqual(fs.manifests[0].artifacts, result.artifacts)
```

For the other existing tests (`does not create git tags when a publish fails`, `skips when all versions are already published`), inject `archive: fs.archive, writeManifest: fs.writeManifest` too. The failure test should additionally assert `fs.manifests.length === 0` (manifest only written after a full successful pass) and the skip test asserts `result.artifacts`/manifest absent (status `already-published`, no manifest write).

- [ ] **Step 3: Run the tests to verify they pass**

Run: `node --test scripts/release-publish.test.mjs`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/release-publish.mjs scripts/release-publish.test.mjs
git commit -m "feat(release): retain published tarballs and write release manifest"
```

---

### Task 2: New upload-release-assets script + unit test

A new script reads `manifest.json` and an attestation bundle path, and for each release tag uploads the tarball + a `.intoto.jsonl`-named copy of the bundle — skipping releases that already have assets (idempotence). The pure logic is dependency-injected.

**Files:**
- Create: `scripts/upload-release-assets.mjs`
- Create: `scripts/upload-release-assets.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/upload-release-assets.test.mjs`:

```js
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { uploadReleaseAssets } from "./upload-release-assets.mjs"

const manifest = [
  { tag: "@dawn-ai/core@0.1.1", tarball: "dawn-ai-core-0.1.1.tgz" },
  { tag: "@dawn-ai/sdk@0.1.1", tarball: "dawn-ai-sdk-0.1.1.tgz" },
]

function fakeDeps(existing = new Set()) {
  const calls = []
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, ...args])
      return ""
    },
    releaseHasAssets: async (tag) => existing.has(tag),
    copyProvenance: async (bundlePath, destPath) => {
      calls.push(["copy", bundlePath, destPath])
    },
  }
}

describe("uploadReleaseAssets", () => {
  it("uploads tarball + provenance to each release without assets", async () => {
    const d = fakeDeps()
    const uploaded = await uploadReleaseAssets({
      manifest,
      archiveDir: "/art",
      bundlePath: "/art/attestation.jsonl",
      run: d.run,
      releaseHasAssets: d.releaseHasAssets,
      copyProvenance: d.copyProvenance,
      log: () => {},
    })

    assert.deepEqual(uploaded, ["@dawn-ai/core@0.1.1", "@dawn-ai/sdk@0.1.1"])
    assert.deepEqual(d.calls, [
      ["copy", "/art/attestation.jsonl", "/art/dawn-ai-core-0.1.1.intoto.jsonl"],
      ["gh", "release", "upload", "@dawn-ai/core@0.1.1",
        "/art/dawn-ai-core-0.1.1.tgz", "/art/dawn-ai-core-0.1.1.intoto.jsonl", "--clobber"],
      ["copy", "/art/attestation.jsonl", "/art/dawn-ai-sdk-0.1.1.intoto.jsonl"],
      ["gh", "release", "upload", "@dawn-ai/sdk@0.1.1",
        "/art/dawn-ai-sdk-0.1.1.tgz", "/art/dawn-ai-sdk-0.1.1.intoto.jsonl", "--clobber"],
    ])
  })

  it("skips releases that already have assets (idempotent)", async () => {
    const d = fakeDeps(new Set(["@dawn-ai/core@0.1.1"]))
    const uploaded = await uploadReleaseAssets({
      manifest,
      archiveDir: "/art",
      bundlePath: "/art/attestation.jsonl",
      run: d.run,
      releaseHasAssets: d.releaseHasAssets,
      copyProvenance: d.copyProvenance,
      log: () => {},
    })

    assert.deepEqual(uploaded, ["@dawn-ai/sdk@0.1.1"])
    assert.ok(!d.calls.some((c) => c[3] === "@dawn-ai/core@0.1.1"))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/upload-release-assets.test.mjs`
Expected: FAIL — `Cannot find module './upload-release-assets.mjs'` / `uploadReleaseAssets is not a function`.

- [ ] **Step 3: Write the implementation**

Create `scripts/upload-release-assets.mjs`:

```js
import { spawn } from "node:child_process"
import { copyFile, readFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirnameOf(import.meta.url), "..")

function dirnameOf(metaUrl) {
  return resolve(fileURLToPath(metaUrl), "..")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const archiveDir = resolve(repoRoot, "release-artifacts")
    const bundlePath = process.env.ATTESTATION_BUNDLE
    if (!bundlePath) {
      throw new Error("ATTESTATION_BUNDLE env var (attestation bundle path) is required")
    }

    const manifestRaw = await readFile(resolve(archiveDir, "manifest.json"), "utf8")
    const manifest = JSON.parse(manifestRaw)

    const uploaded = await uploadReleaseAssets({
      manifest,
      archiveDir,
      bundlePath,
      run: runCommand,
      releaseHasAssets: defaultReleaseHasAssets,
      copyProvenance: copyFile,
      log: console.log,
    })

    console.log(`Uploaded assets to ${uploaded.length} release(s).`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

/**
 * For each release in the manifest, upload its tarball plus a copy of the
 * attestation bundle renamed to <tarball-base>.intoto.jsonl (so Scorecard's
 * Signed-Releases check recognizes the asset). Skips releases that already
 * have assets, so re-runs after a partial failure are safe.
 */
export async function uploadReleaseAssets({
  manifest,
  archiveDir,
  bundlePath,
  run,
  releaseHasAssets,
  copyProvenance,
  log,
}) {
  const uploaded = []

  for (const { tag, tarball } of manifest) {
    if (await releaseHasAssets(tag)) {
      log(`Skipping ${tag} (already has assets)`)
      continue
    }

    const tarballPath = resolve(archiveDir, tarball)
    const provenanceName = `${basename(tarball, ".tgz")}.intoto.jsonl`
    const provenancePath = resolve(archiveDir, provenanceName)

    await copyProvenance(bundlePath, provenancePath)
    await run("gh", ["release", "upload", tag, tarballPath, provenancePath, "--clobber"])

    log(`Uploaded assets to ${tag}`)
    uploaded.push(tag)
  }

  return uploaded
}

async function defaultReleaseHasAssets(tag) {
  const out = await runCommand("gh", [
    "release", "view", tag, "--json", "assets", "--jq", ".assets | length",
  ])
  return Number.parseInt(out.trim() || "0", 10) > 0
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (c) => (stdout += c))
    child.stderr?.on("data", (c) => (stderr += c))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(`${command} ${args.join(" ")} failed (${code})\n${stderr}`))
    })
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/upload-release-assets.test.mjs`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/upload-release-assets.mjs scripts/upload-release-assets.test.mjs
git commit -m "feat(release): add upload-release-assets script for signed release assets"
```

---

### Task 3: Wire the new test into package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the test script and chain it in ci:validate**

Add a `test:upload-release-assets` script and include it in `ci:validate` right after `test:release-publish`:

```json
"test:upload-release-assets": "node --test scripts/upload-release-assets.test.mjs",
```

In `ci:validate`, change `… && pnpm test:release-publish && …` to `… && pnpm test:release-publish && pnpm test:upload-release-assets && …`.

- [ ] **Step 2: Verify both release tests run**

Run: `pnpm test:release-publish && pnpm test:upload-release-assets`
Expected: both PASS.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "ci: run upload-release-assets test in ci:validate"
```

---

### Task 4: Wire signing + upload into release.yml

Add `attestations: write` to the release job, an attestation step over the retained tarballs, and the upload step. SHA-pin the new action.

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add the permission and the two steps**

In the `release` job's `permissions:` block, add `attestations: write` (keep `contents: write`, `pull-requests: write`, `id-token: write`).

After the existing `Create Release Pull Request or Publish` (changesets/action) step, append:

```yaml
      # Attest the just-published tarballs (kept in release-artifacts/ by
      # release-publish.mjs). Keyless OIDC — registers SLSA in-toto provenance
      # in GitHub's attestation store and emits a bundle file.
      - name: Attest release tarballs
        id: attest
        if: ${{ hashFiles('release-artifacts/*.tgz') != '' }}
        uses: actions/attest-build-provenance@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # v4.1.0
        with:
          subject-path: "release-artifacts/*.tgz"

      # Attach each package tarball + a .intoto.jsonl-named copy of the bundle
      # to its GitHub Release so OSSF Signed-Releases finds a signature asset.
      - name: Upload signed release assets
        if: ${{ steps.attest.outputs.bundle-path != '' }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ATTESTATION_BUNDLE: ${{ steps.attest.outputs.bundle-path }}
        run: node scripts/upload-release-assets.mjs
```

The `if:` guards mean these steps no-op on runs where changesets only opened the "Version Packages" PR (no publish happened, so `release-artifacts/` is empty).

- [ ] **Step 2: Validate YAML parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Confirm the new action is SHA-pinned and permission added**

Run: `grep -n 'attest-build-provenance@a2bbfa25' .github/workflows/release.yml && grep -n 'attestations: write' .github/workflows/release.yml && grep -n 'uses: .*@v' .github/workflows/release.yml; echo "checked"`
Expected: the first two grep lines match; the `@v` grep prints nothing (all pinned); `checked` prints.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: attest and upload signed release assets in release.yml"
```

---

### Task 5: Verification

- [ ] **Step 1: Run the full release-related test suite**

Run: `pnpm test:release-publish && pnpm test:upload-release-assets`
Expected: all PASS.

- [ ] **Step 2: Lint + typecheck the changed scripts (repo gates)**

Run: `pnpm lint && pnpm build && pnpm typecheck`
Expected: PASS (the new `.mjs` scripts are plain Node ESM; lint should accept them as the existing scripts are).

- [ ] **Step 3: actionlint if available**

Run: `command -v actionlint >/dev/null && actionlint .github/workflows/release.yml || echo "actionlint not installed — relying on YAML parse"`
Expected: no errors or the fallback message.

- [ ] **Step 4: Confirm all workflow actions remain SHA-pinned repo-wide**

Run: `grep -rn 'uses: .*@v' .github/workflows/ ; echo "exit: $?"`
Expected: no matches (grep exit 1).

- [ ] **Step 5: Note post-merge live verification (next real release only)**

The attest + upload path runs only on a real version-bump release. After the next release:
1. `gh release view <name>@<version> --json assets --jq '.assets[].name'` shows a `*.tgz` and a `*.intoto.jsonl`.
2. `gh attestation verify release-artifacts/<tarball> --repo cacheplane/dawnai` passes (provenance is registered in GitHub's store).
3. After Scorecard recomputes, Signed-Releases moves from `-1` toward ~10 at `https://api.scorecard.dev/projects/github.com/cacheplane/dawnai`.

Also add `release-artifacts/` to `.gitignore` if it isn't already covered, so a local release dry-run never commits tarballs:
Run: `grep -q 'release-artifacts' .gitignore || echo 'release-artifacts/' >> .gitignore`
Then commit if changed:
```bash
git add .gitignore && git commit -m "chore: ignore release-artifacts/" || echo "no gitignore change"
```

---

## Self-review notes

- **Spec coverage:** retain tarballs + manifest (Task 1), attest keyless Sigstore (Task 4 step), upload tarball + `.intoto.jsonl` to each release with idempotence (Task 2, wired in Task 4), `attestations: write` permission (Task 4), unit test (Task 2), test wired into ci:validate (Task 3), live verification (Task 5). Keeps per-package releases; attaches both artifact and provenance — matches the approved design.
- **Combined-bundle decision:** the attestation step produces one bundle covering all tarballs; the upload copies it (renamed `*.intoto.jsonl`) onto each release. Scorecard only needs a recognized filename present; genuine per-tarball verification remains available via `gh attestation verify` against GitHub's store. This intentionally avoids per-subject bundle-splitting complexity (the spec's flagged risk).
- **Type/name consistency:** `uploadReleaseAssets({ manifest, archiveDir, bundlePath, run, releaseHasAssets, copyProvenance, log })` and the manifest entry shape `{ tag, tarball }` are used identically in the script, its test, and Task 1's `defaultWriteManifest`.
- **No placeholders:** all code is complete; the only runtime value is the live `<name>@<version>` tag in the post-merge manual step.
