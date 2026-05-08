/**
 * Require a changeset when user-facing files change.
 *
 * Runs in CI on pull requests. Compares the PR head against `BASE_REF`
 * (defaults to `origin/main`) and fails if either:
 *   - any file under `packages/<pkg>/src/` changed, OR
 *   - any `packages/<pkg>/README.md` changed
 * AND no new file was added under `.changeset/`.
 *
 * Empty changesets (created via `pnpm changeset --empty`) satisfy the check
 * — they're how you opt out for genuinely no-version-bump changes.
 *
 * Excluded from the check:
 *   - The auto-managed `changeset-release/main` branch (skip).
 *   - PRs from `dependabot[bot]` or `github-actions[bot]` (skip).
 */

import { execSync } from "node:child_process"

const baseRef = process.env.BASE_REF ?? "origin/main"
const headRef = process.env.HEAD_REF ?? ""
const prAuthor = process.env.PR_AUTHOR ?? ""

if (headRef === "changeset-release/main") {
  console.log("Changesets check skipped (auto-managed Version Packages branch).")
  process.exit(0)
}

if (prAuthor === "dependabot[bot]" || prAuthor === "github-actions[bot]") {
  console.log(`Changesets check skipped (PR author: ${prAuthor}).`)
  process.exit(0)
}

let changed
try {
  changed = execSync(`git diff --name-only --diff-filter=ACMR ${baseRef}...HEAD`, {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
} catch (error) {
  console.error(
    `Changesets check could not diff against ${baseRef}: ${error instanceof Error ? error.message : String(error)}`,
  )
  console.error("Hint: ensure git fetch-depth is unrestricted in CI (fetch-depth: 0).")
  process.exit(1)
}

const userFacingPatterns = [/^packages\/[^/]+\/src\//, /^packages\/[^/]+\/README\.md$/]

const userFacingChanges = changed.filter((path) =>
  userFacingPatterns.some((pattern) => pattern.test(path)),
)

const newChangesets = changed.filter(
  (path) =>
    path.startsWith(".changeset/") && path.endsWith(".md") && path !== ".changeset/README.md",
)

if (userFacingChanges.length === 0) {
  console.log("Changesets check skipped (no user-facing changes detected).")
  process.exit(0)
}

if (newChangesets.length === 0) {
  console.error("Changeset required.")
  console.error("")
  console.error("This PR changes user-facing files in packages/* but does not include a")
  console.error("changeset, so the next release will not pick up the change.")
  console.error("")
  console.error("Files that triggered this check:")
  for (const path of userFacingChanges) {
    console.error(`  - ${path}`)
  }
  console.error("")
  console.error("Add a changeset:")
  console.error("  pnpm changeset")
  console.error("")
  console.error("If this PR is genuinely a no-op for consumers (internal refactor, test-only,")
  console.error("etc.), add an empty changeset to opt out:")
  console.error("  pnpm changeset --empty")
  process.exit(1)
}

console.log(
  `Changesets check passed (${userFacingChanges.length} user-facing change(s), ${newChangesets.length} changeset(s) added).`,
)
