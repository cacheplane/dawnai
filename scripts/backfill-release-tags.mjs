import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { npmView, readPublicPackages } from "./release-publish.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const packages = await readPublicPackages(repoRoot)
    const backfilled = await backfillReleaseTags({
      packages,
      npmView,
      tagExists,
      releaseExists,
      createTag,
      createRelease,
      changelogSection,
      log: console.log,
    })

    if (backfilled.length === 0) {
      console.log("Release tags/releases already consistent — nothing to backfill.")
    } else {
      console.log(`Backfilled ${backfilled.length}: ${backfilled.join(", ")}`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

/**
 * Ensures every already-published public package at its current version has both
 * a git tag AND a GitHub Release, backfilling any that are missing.
 *
 * Why this exists: the normal release path (changesets/action + release-publish.mjs)
 * only tags/releases packages it publishes IN THAT RUN. A brand-new package name
 * must be bootstrap-published manually first (OIDC trusted publishing cannot create
 * a new package), so the automated run finds it already on npm, skips it, and leaves
 * it with no tag/release. This idempotent reconciliation catches exactly those.
 *
 * For a normal release (no bootstrap) every published version already has its tag
 * and release, so this is a no-op. It never touches a not-yet-published version —
 * that is the publish path's job, and racing it could create a tag for a version
 * that then fails to publish.
 */
export async function backfillReleaseTags({
  packages,
  npmView,
  tagExists,
  releaseExists,
  createTag,
  createRelease,
  changelogSection,
  log,
}) {
  const backfilled = []

  for (const pkg of packages) {
    const name = pkg.packageJson.name
    const version = pkg.packageJson.version
    const tag = `${name}@${version}`

    const view = await npmView(name)
    if (!view.versions.includes(version)) {
      // Not published yet — the release/publish path owns tagging this version.
      continue
    }

    const hasTag = await tagExists(tag)
    const hasRelease = await releaseExists(tag)
    if (hasTag && hasRelease) {
      continue
    }

    if (!hasTag) {
      await createTag(tag)
      log(`Backfilled tag: ${tag}`)
    }
    if (!hasRelease) {
      const notes = await changelogSection(pkg.dir, version)
      await createRelease(tag, notes)
      log(`Backfilled release: ${tag}`)
    }
    backfilled.push(tag)
  }

  return backfilled
}

/**
 * Extracts the body of the `## <version>` section from a package CHANGELOG.md,
 * i.e. everything between that heading and the next `## ` heading (or EOF).
 * Returns an empty string when the version has no section.
 */
export function extractChangelogSection(changelog, version) {
  const lines = changelog.split("\n")
  const start = lines.findIndex((line) => line.trim() === `## ${version}`)
  if (start === -1) {
    return ""
  }

  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^## /.test(line))
  const body = end === -1 ? rest : rest.slice(0, end)
  return body.join("\n").trim()
}

async function changelogSection(dir, version) {
  let changelog
  try {
    changelog = await readFile(resolve(dir, "CHANGELOG.md"), "utf8")
  } catch {
    return ""
  }
  return extractChangelogSection(changelog, version)
}

async function tagExists(tag) {
  const output = await runCommand("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])
  return output.trim().length > 0
}

async function releaseExists(tag) {
  try {
    await runCommand("gh", ["release", "view", tag])
    return true
  } catch {
    return false
  }
}

async function createTag(tag) {
  // Lightweight tag at HEAD (the release commit), matching the tags the release
  // path creates. `-c tag.gpgsign=false` guards against a signed-tag git config.
  await runCommand("git", ["-c", "tag.gpgsign=false", "tag", tag])
  await runCommand("git", ["push", "origin", `refs/tags/${tag}`])
}

async function createRelease(tag, notes) {
  const args = ["release", "create", tag, "--title", tag, "--verify-tag"]
  if (notes) {
    args.push("--notes", notes)
  } else {
    args.push("--generate-notes")
  }
  await runCommand("gh", args)
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout)
        return
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${stderr}`))
    })
  })
}
