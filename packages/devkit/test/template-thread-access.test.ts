import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const templates = ["app-basic", "app-research"] as const

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

/**
 * Where each template's app tree starts. `app-research` is an npm workspace,
 * so its `src/` — and the authorization files in it — live under `server/`.
 */
const appRoot = (name: string): string => (name === "app-research" ? `${name}/server` : name)

/** Every place the same two authorization files are shipped from. */
const copies = [
  fileURLToPath(new URL("../templates/app-basic/src/", import.meta.url)),
  fileURLToPath(new URL("../templates/app-research/server/src/", import.meta.url)),
  `${resolve(repoRoot, "examples/research/server/src")}/`,
] as const

const read = (name: string, file: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../templates/${appRoot(name)}/${file}`, import.meta.url)),
    "utf8",
  )

const exists = (name: string, file: string): boolean =>
  existsSync(fileURLToPath(new URL(`../templates/${appRoot(name)}/${file}`, import.meta.url)))

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

    it(`${name} says what the missing-row deny does and does not reach`, () => {
      const policy = read(name, "src/thread-access.ts.example")

      // The deny on `req.thread === undefined` is justified in this file on
      // DELETE-existence-oracle grounds, and the obvious misreading of it is
      // that it also refuses every AG-UI turn on a browser-chosen `threadId`.
      // It does not: a run endpoint that finds no row asks under `create`, and
      // the row it writes carries that decision's stamp. A scaffold whose
      // commentary describes a first-class flow wrongly gets copied, then
      // cursed.
      expect(policy).toContain("/agui/")
      expect(policy).toContain('`action: "create"`')
      // And the cost that comes with it, which is the one thing a reader
      // cannot infer from the code: the ids are client-chosen, so whoever
      // names an unused one owns it, and can deny it to the caller who meant
      // to use it. `POST /threads` mints ids nobody can call first.
      expect(policy).toContain("first come, first served")
      expect(policy).toContain("POST /threads")
    })
  }

  it("keeps every shipped copy in byte-for-byte parity", () => {
    for (const file of ["thread-access.ts.example", "auth.ts.example"]) {
      const [first, ...rest] = copies.map((dir) => readFileSync(`${dir}${file}`, "utf8"))
      // Three copies of an authorization scaffold that drift are three
      // different security postures, only one of which anybody reviewed.
      for (const other of rest) expect(other).toBe(first)
    }
  })
})
