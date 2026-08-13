import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const templates = ["app-basic", "app-research"] as const

const read = (name: string, file: string): string =>
  readFileSync(fileURLToPath(new URL(`../templates/${name}/${file}`, import.meta.url)), "utf8")

const exists = (name: string, file: string): boolean =>
  existsSync(fileURLToPath(new URL(`../templates/${name}/${file}`, import.meta.url)))

/** Line-oriented and deliberately crude: enough to tell code from commentary. */
const stripComments = (source: string): string =>
  source
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim()
      return !(
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed === ""
      )
    })
    .join("\n")

describe("scaffolded thread-access policy", () => {
  for (const name of templates) {
    it(`${name} ships a deny-by-default policy and the shared auth module`, () => {
      const policy = read(name, "src/thread-access.ts.example")

      expect(policy).toContain("defineThreadAccess")
      // `fallback` is the deny-by-default floor: an action with no handler of
      // its own lands there rather than falling through to an allow.
      expect(policy).toContain("fallback: owned")
      // The DELETE existence oracle: a missing row is denied ahead of any admin
      // branch, so "not yours" and "never existed" answer identically.
      expect(policy).toContain("if (req.thread === undefined) return deny()")
      expect(read(name, "src/auth.ts.example")).toContain("export async function principalOf")
      // One principal, imported by both authorization files — not two header
      // parsers that can disagree.
      expect(policy).toContain('from "./auth.js"')
    })

    it(`${name}'s policy authorizes against the server stamp, never client metadata`, () => {
      const policy = read(name, "src/thread-access.ts.example")

      expect(policy).toContain("req.thread.access?.ownerId")
      // `thread.metadata` is client-supplied and untrusted. A scaffold that
      // read the owner out of it would ship the forgery it exists to prevent.
      // Comments are stripped first — the file explains the rule, in prose that
      // necessarily names the field it forbids.
      expect(stripComments(policy)).not.toContain("thread.metadata")
    })

    it(`${name} leaves the policy inert until the app renames it`, () => {
      // Deliberate: the templates are also the quickstart and the base fixture
      // for the Agent Protocol runtime harness, and an active deny-by-default
      // policy denies every request from an app that has no authenticated
      // caller yet. The scaffold is one `mv` from active, and the file says so.
      expect(exists(name, "src/thread-access.ts")).toBe(false)
      expect(exists(name, "src/auth.ts")).toBe(false)
      expect(read(name, "src/thread-access.ts.example")).toContain(
        "Rename to `src/thread-access.ts`",
      )
    })
  }
})
