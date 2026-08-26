import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

interface RootManifest {
  readonly scripts: Readonly<Record<string, string>>
}

const rootManifest = (): RootManifest =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../templates/app-research/package.json.template", import.meta.url)),
      "utf8",
    ),
  ) as RootManifest

/** `npm run x --workspace server` — one package, so the caller's flags belong to it. */
const isDelegator = (command: string): boolean => /\s--workspace\s/u.test(command)

/** `npm run x --workspaces` — every package, so nobody's flags belong to any of them. */
const isFanOut = (command: string): boolean => /\s--workspaces\b/u.test(command)

const WHY_THE_TERMINATOR = [
  "Every single-workspace delegator in the research template's root package.json must end",
  'with a literal " --". It reads like a stray typo. It is not, and deleting it breaks the',
  "scaffold harness.",
  "",
  "Verified on node 24.19.0 / npm 11.17.0: without the terminator, `npm run dev -- --port 4123`",
  'reaches the child as ["4123"] — npm swallows the flag NAME and forwards only its value — and',
  "`dawn dev` then hard-errors with \"too many arguments for 'dev'\". The harness boots generated",
  "apps exactly that way, so the failure lands on whoever runs the lane next, far from this file.",
  "",
  "If you came here to tidy the trailing dashes away, change nothing and close the file.",
].join("\n")

const WHY_NO_TERMINATOR_ON_FAN_OUTS = [
  'A `--workspaces` fan-out must NOT end with " --". It runs in every package, so forwarding one',
  "caller's flags to all of them is wrong by construction — `--port 4123` means something to the",
  "server and nothing to the web client. Fan-outs take `--if-present` instead, so a package that",
  "does not define the script is skipped rather than failing the run.",
].join("\n")

describe("research template root scripts", () => {
  it("terminates every single-workspace delegator with a literal ` --`", () => {
    const { scripts } = rootManifest()
    const delegators = Object.entries(scripts).filter(([, command]) => isDelegator(command))

    // A refactor that renames the delegators away should red here rather than
    // pass vacuously on an empty list.
    expect(delegators.length).toBeGreaterThan(0)

    const missingTerminator = delegators
      .filter(([, command]) => !command.endsWith(" --"))
      .map(([name, command]) => `${name}: ${command}`)

    expect(missingTerminator, WHY_THE_TERMINATOR).toEqual([])
  })

  it("leaves the `--workspaces` fan-outs unterminated and `--if-present`", () => {
    const { scripts } = rootManifest()
    const fanOuts = Object.entries(scripts).filter(([, command]) => isFanOut(command))

    expect(fanOuts.length).toBeGreaterThan(0)

    const wrong = fanOuts
      .filter(([, command]) => command.endsWith(" --") || !command.includes("--if-present"))
      .map(([name, command]) => `${name}: ${command}`)

    expect(wrong, WHY_NO_TERMINATOR_ON_FAN_OUTS).toEqual([])
  })
})
