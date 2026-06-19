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
 * Signed-Releases check recognizes the asset). Uses --clobber so re-runs
 * after a partial failure are safe/idempotent.
 */
export async function uploadReleaseAssets({
  manifest,
  archiveDir,
  bundlePath,
  run,
  copyProvenance,
  log,
}) {
  const uploaded = []

  for (const { tag, tarball } of manifest) {
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
