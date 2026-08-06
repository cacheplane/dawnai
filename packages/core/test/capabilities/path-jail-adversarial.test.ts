/**
 * Adversarial characterization of the workspace path jail.
 *
 * Three cooperating sites decide containment on every request:
 *   1. workspace-fs.ts   — resolve the requested path against the workspace root
 *   2. the backend       — realPath() canonicalization of BOTH operands
 *   3. permission-gate.ts — `abs === root || abs.startsWith(root + sep)`
 * plus built-in/workspace.ts's `tool-outputs/` predicate, which decides whether
 * a read is uncapped.
 *
 * These cases pin site 1+3 with an IDENTITY `realPath`, isolating the pure path
 * arithmetic from symlink resolution (the symlink-escape cases live in
 * workspace-fs.test.ts and must keep passing unedited). Each case pins the
 * verdict AND the resolved absolute path, because the dangerous failure mode is
 * a wrong resolution that still classifies as "inside": `resolve(root, "/etc/passwd")`
 * is `/etc/passwd` (outside), but a join-shaped implementation would yield
 * `<root>/etc/passwd`, which passes the containment check — a silent jail escape.
 */

import type { PermissionsStore } from "@dawn-ai/permissions"
import type { FilesystemBackend } from "@dawn-ai/workspace"
import { describe, expect, it } from "vitest"

import { createWorkspaceMarker } from "../../src/capabilities/built-in/workspace.js"
import type { CapabilityMarkerContext, DawnToolDefinition } from "../../src/capabilities/types.js"
import { createWorkspaceFs } from "../../src/capabilities/workspace-fs.js"

const WORKSPACE_ROOT = "/app/workspace"
const signal = new AbortController().signal

interface Recording {
  readonly backend: FilesystemBackend
  readonly reads: string[]
  readonly readOpts: Array<{ readonly maxBytes?: number } | undefined>
}

function recordingBackend(): Recording {
  const reads: string[] = []
  const readOpts: Array<{ readonly maxBytes?: number } | undefined> = []
  const backend: FilesystemBackend = {
    readFile: async (path, _ctx, opts) => {
      reads.push(path)
      readOpts.push(opts)
      return "content"
    },
    writeFile: async () => ({ bytesWritten: 0 }),
    listDir: async () => [],
    // Identity: keeps this suite about path arithmetic only.
    realPath: async (path) => path,
  }
  return { backend, reads, readOpts }
}

/**
 * A store that never has an opinion, in the mode that fails closed — so any
 * path the jail classifies as OUTSIDE is denied, and the denial names the
 * absolute path the gate compared.
 */
function unknowingStore(seen: string[]): PermissionsStore {
  return {
    mode: "non-interactive",
    load: async () => {},
    match: (_tool, candidate) => {
      seen.push(candidate)
      return "unknown"
    },
    addAllow: async () => {},
  }
}

type Verdict = "inside" | "outside"

async function classify(
  requestedPath: string,
): Promise<{ readonly verdict: Verdict; readonly absPath: string | undefined }> {
  const { backend, reads } = recordingBackend()
  const gated: string[] = []
  const fs = createWorkspaceFs({
    workspaceRoot: WORKSPACE_ROOT,
    backend,
    permissions: unknowingStore(gated),
    signal,
    interruptCapable: false,
  })
  try {
    await fs.readFile(requestedPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Only a fail-closed denial counts as "outside" — any other failure must
    // surface rather than be mistaken for containment.
    if (!message.includes("fail-closed")) throw error
    return { verdict: "outside", absPath: gated[0] }
  }
  return { verdict: "inside", absPath: reads[0] }
}

const CASES: ReadonlyArray<readonly [requested: string, verdict: Verdict, absPath: string]> = [
  ["notes.txt", "inside", "/app/workspace/notes.txt"],
  ["sub/dir/notes.txt", "inside", "/app/workspace/sub/dir/notes.txt"],
  [".", "inside", "/app/workspace"],
  ["", "inside", "/app/workspace"],
  ["sub/", "inside", "/app/workspace/sub"],
  ["sub/../notes.txt", "inside", "/app/workspace/notes.txt"],
  ["sub/../../workspace/notes.txt", "inside", "/app/workspace/notes.txt"],
  ["/app/workspace/notes.txt", "inside", "/app/workspace/notes.txt"],
  // POSIX: a backslash is an ordinary filename character, not a separator, so
  // this is one leaf inside the workspace — not a traversal.
  ["..\\escape", "inside", "/app/workspace/..\\escape"],
  // THE JAIL-ESCAPE CASE: an absolute second operand DISCARDS the root.
  ["/etc/passwd", "outside", "/etc/passwd"],
  ["//etc/passwd", "outside", "/etc/passwd"],
  ["../escape", "outside", "/app/escape"],
  ["..", "outside", "/app"],
  ["../workspace-evil/x", "outside", "/app/workspace-evil/x"],
  ["sub/../../escape", "outside", "/app/escape"],
  // Sibling-prefix: string-prefix containment without a separator would call
  // these inside.
  ["/app/workspace-evil/secret", "outside", "/app/workspace-evil/secret"],
  ["/app/workspace-evil", "outside", "/app/workspace-evil"],
  ["/app/workspacex", "outside", "/app/workspacex"],
]

describe("workspace path jail — adversarial containment", () => {
  for (const [requested, expected, expectedAbs] of CASES) {
    it(`classifies ${JSON.stringify(requested)} as ${expected} (${expectedAbs})`, async () => {
      const { verdict, absPath } = await classify(requested)
      expect(verdict).toBe(expected)
      expect(absPath).toBe(expectedAbs)
    })
  }

  it("treats the root itself as inside, with no trailing separator", async () => {
    const { verdict, absPath } = await classify(".")
    expect(verdict).toBe("inside")
    expect(absPath).toBe(WORKSPACE_ROOT)
    expect(absPath?.endsWith("/")).toBe(false)
  })

  it("never hands the backend a path outside the root", async () => {
    for (const [requested, expected, expectedAbs] of CASES) {
      const { verdict, absPath } = await classify(requested)
      if (verdict === "inside") {
        expect(absPath === WORKSPACE_ROOT || (absPath ?? "").startsWith(`${WORKSPACE_ROOT}/`)).toBe(
          true,
        )
        expect(absPath).toBe(expectedAbs)
      } else {
        expect(expected).toBe("outside")
      }
    }
  })
})

// ---------------------------------------------------------------------------
// tool-outputs/ exemption predicate (built-in/workspace.ts)
// ---------------------------------------------------------------------------

function findTool(
  tools: ReadonlyArray<DawnToolDefinition> | undefined,
  name: string,
): DawnToolDefinition {
  const tool = (tools ?? []).find((t) => t.name === name)
  if (!tool) throw new Error(`Tool ${name} not found`)
  return tool
}

async function readWithMarker(
  requestedPath: string,
): Promise<{ readonly maxBytes: number | undefined }> {
  const { backend, readOpts } = recordingBackend()
  const context: CapabilityMarkerContext = {
    routeManifest: { appRoot: "/app", routes: [] },
    descriptor: undefined,
    appRoot: "/app",
    // Explicit root: skips the host existsSync probe, so the predicate can be
    // exercised against a synthetic POSIX root.
    workspaceRoot: WORKSPACE_ROOT,
    backends: { filesystem: backend },
  }
  const contribution = await createWorkspaceMarker().load("/app/routes/x", context)
  const readFile = findTool(contribution.tools, "readFile")
  await readFile.run({ path: requestedPath }, { signal })
  return { maxBytes: readOpts[0]?.maxBytes }
}

const UNCAPPED = Number.POSITIVE_INFINITY

describe("tool-outputs/ uncapped-read predicate — adversarial", () => {
  const OUTPUT_CASES: ReadonlyArray<readonly [requested: string, uncapped: boolean]> = [
    ["tool-outputs/x.txt", true],
    ["tool-outputs", true],
    ["sub/../tool-outputs/x.txt", true],
    ["notes.md", false],
    // Prefix sibling: "tool-outputs-evil" must not inherit the exemption.
    ["tool-outputs-evil/x.txt", false],
    // An escape that lands in a DIFFERENT tool-outputs dir must not inherit it.
    ["../tool-outputs/x.txt", false],
    ["/etc/tool-outputs/x.txt", false],
  ]

  for (const [requested, uncapped] of OUTPUT_CASES) {
    it(`${JSON.stringify(requested)} is ${uncapped ? "uncapped" : "capped"}`, async () => {
      const { maxBytes } = await readWithMarker(requested)
      expect(maxBytes).toBe(uncapped ? UNCAPPED : undefined)
    })
  }
})
