import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const templates = ["app-basic", "app-research"] as const

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

/** Every place the same two authorization files are shipped from. */
const copies = [
  fileURLToPath(new URL("../templates/app-basic/src/", import.meta.url)),
  fileURLToPath(new URL("../templates/app-research/src/", import.meta.url)),
  `${resolve(repoRoot, "examples/research/server/src")}/`,
] as const

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

    it(`${name} tells the reader what the missing-row deny costs them`, () => {
      const policy = read(name, "src/thread-access.ts.example")

      // The deny on `req.thread === undefined` is justified in this file on
      // DELETE-existence-oracle grounds. It ALSO refuses every `run.*`
      // operation on a thread id whose row does not exist yet — which is every
      // AG-UI turn, because CopilotKit picks its `threadId` in the browser and
      // never calls `POST /threads`. A scaffold that refuses a first-class flow
      // and does not say so gets copied, then cursed.
      expect(policy).toContain("run.*")
      expect(policy).toContain("/agui/")
      // And the supported way through it, which is not "relax this line": the
      // implicit create those endpoints do writes no access stamp, so a
      // relaxed line authorizes one turn and denies the next. Minting the id
      // through POST /threads is the only path that stamps an owner.
      expect(policy).toContain("POST /threads")
      expect(policy).toContain("no access stamp")
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
