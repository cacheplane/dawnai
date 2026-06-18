import { basename, join } from "node:path"

/** Stable slug for a case name; falls back to `case-<index+1>` when empty. */
export function caseSlug(name: string | undefined, index: number): string {
  const slug = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : `case-${index + 1}`
}

/** `<baseDir>/<evalBasename>.<caseSlug>.fixtures.json` — the per-case sibling fixture file. */
export function siblingFixturePath(
  evalFile: string,
  baseDir: string,
  caseName: string | undefined,
  index: number,
): string {
  const evalBase = basename(evalFile).replace(/\.eval\.ts$/, "")
  return join(baseDir, `${evalBase}.${caseSlug(caseName, index)}.fixtures.json`)
}
