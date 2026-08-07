import type { PermissionMode, PermissionsFile, PermissionsStore } from "@dawn-ai/permissions"
import { expect, test } from "vitest"

/** What a backend needs in order to build a store: the config-seeded lists plus the resolved mode. */
export interface PermissionsStoreInit {
  readonly config: PermissionsFile | undefined
  readonly mode: PermissionMode
}

const file = (
  allow: Record<string, string[]>,
  deny: Record<string, string[]> = {},
): PermissionsFile => ({ version: 1, allow, deny })

/**
 * The contract every PermissionsStore must satisfy. Run against the file-backed
 * node store (tmpdir, always) and any other backend (e.g. Postgres, gated) so
 * they cannot drift. Pass vitest's `describe`; `makeStore` returns a FRESH
 * store — no config entries beyond `init.config`, no prior runtime grants.
 *
 * Runtime grants are seeded through `addAllow` rather than by writing the
 * backing store directly: that is the only portable way to reach the "runtime"
 * half of the state machine, since where those entries live (a JSON file, a
 * table) is exactly what differs between backends.
 */
export function runPermissionsStoreConformance(opts: {
  readonly name: string
  readonly makeStore: (init: PermissionsStoreInit) => Promise<PermissionsStore> | PermissionsStore
  readonly describe: (name: string, fn: () => void) => void
  readonly close?: (store: PermissionsStore) => Promise<void> | void
}): void {
  const { name, makeStore, describe, close } = opts
  describe(`PermissionsStore conformance: ${name}`, () => {
    async function withStore(
      init: PermissionsStoreInit,
      fn: (store: PermissionsStore) => Promise<void>,
    ): Promise<void> {
      const store = await makeStore(init)
      try {
        await store.load()
        await fn(store)
      } finally {
        await close?.(store)
      }
    }

    test("exposes the resolved mode", async () => {
      await withStore({ config: undefined, mode: "non-interactive" }, async (s) => {
        expect(s.mode).toBe("non-interactive")
      })
    })
    test("no entries for a tool → unknown", async () => {
      await withStore({ config: undefined, mode: "interactive" }, async (s) => {
        expect(s.match("bash", "npm install")).toBe("unknown")
        expect(s.match("unknownTool", "anything")).toBe("unknown")
      })
    })
    test("config allow entries match by prefix", async () => {
      await withStore(
        { config: file({ bash: ["npm install"] }), mode: "interactive" },
        async (s) => {
          expect(s.match("bash", "npm install react")).toBe("allow")
          expect(s.match("bash", "npm install")).toBe("allow")
          // The candidate must start with the pattern, not the other way round.
          expect(s.match("bash", "npm")).toBe("unknown")
          expect(s.match("bash", "rm -rf /")).toBe("unknown")
        },
      )
    })
    test("patterns are scoped per tool key", async () => {
      await withStore({ config: file({ bash: ["ls"] }), mode: "interactive" }, async (s) => {
        expect(s.match("bash", "ls -la")).toBe("allow")
        expect(s.match("readFile", "ls -la")).toBe("unknown")
      })
    })
    test("deny wins over allow", async () => {
      await withStore(
        { config: file({ bash: ["rm"] }, { bash: ["rm -rf"] }), mode: "interactive" },
        async (s) => {
          expect(s.match("bash", "rm -rf /tmp")).toBe("deny")
          expect(s.match("bash", "rm ./file")).toBe("allow")
        },
      )
    })
    test('the reserved "tool" key matches EXACTLY, never by prefix', async () => {
      await withStore({ config: file({ tool: ["deploy"] }), mode: "interactive" }, async (s) => {
        expect(s.match("tool", "deploy")).toBe("allow")
        // Tool names must not prefix-match, or approving "deploy" would
        // silently approve "deployProd".
        expect(s.match("tool", "deployProd")).toBe("unknown")
      })
      await withStore(
        { config: file({}, { tool: ["deploy"] }), mode: "interactive" },
        async (s) => {
          expect(s.match("tool", "deploy")).toBe("deny")
          expect(s.match("tool", "deployProd")).toBe("unknown")
        },
      )
    })
    test("bypass mode: match is always unknown, even with config allow AND deny", async () => {
      await withStore(
        { config: file({ bash: ["ls"] }, { bash: ["rm"] }), mode: "bypass" },
        async (s) => {
          expect(s.match("bash", "ls -la")).toBe("unknown")
          expect(s.match("bash", "rm -rf /")).toBe("unknown")
          await s.addAllow("bash", "cat")
          expect(s.match("bash", "cat x")).toBe("unknown")
        },
      )
    })
    test("non-interactive mode: config applies, runtime grants are ignored", async () => {
      await withStore(
        { config: file({ bash: ["ls"] }, { bash: ["rm"] }), mode: "non-interactive" },
        async (s) => {
          expect(s.match("bash", "ls -la")).toBe("allow")
          expect(s.match("bash", "rm -rf /")).toBe("deny")
          await s.addAllow("bash", "npm install")
          expect(s.match("bash", "npm install react")).toBe("unknown")
        },
      )
    })
    test("interactive mode: config and runtime grants are concatenated per tool key", async () => {
      await withStore({ config: file({ bash: ["ls"] }), mode: "interactive" }, async (s) => {
        await s.addAllow("bash", "npm install")
        await s.addAllow("readFile", "/tmp/")
        // Same key: both lists contribute. Different key: independent.
        expect(s.match("bash", "ls -la")).toBe("allow")
        expect(s.match("bash", "npm install react")).toBe("allow")
        expect(s.match("readFile", "/tmp/x.txt")).toBe("allow")
      })
    })
    test("interactive mode: a config deny beats a runtime allow", async () => {
      await withStore(
        { config: file({}, { bash: ["rm -rf"] }), mode: "interactive" },
        async (s) => {
          await s.addAllow("bash", "rm")
          expect(s.match("bash", "rm -rf /tmp")).toBe("deny")
          expect(s.match("bash", "rm ./file")).toBe("allow")
        },
      )
    })
    test("addAllow is visible to match() as soon as it resolves", async () => {
      await withStore({ config: undefined, mode: "interactive" }, async (s) => {
        expect(s.match("bash", "npm install")).toBe("unknown")
        await s.addAllow("bash", "npm install")
        expect(s.match("bash", "npm install react")).toBe("allow")
      })
    })
    test("addAllow is idempotent — repeating a grant changes nothing", async () => {
      await withStore({ config: undefined, mode: "interactive" }, async (s) => {
        await s.addAllow("bash", "ls")
        await s.addAllow("bash", "ls")
        // Whether the backend de-duplicates its rows is storage-internal; what
        // the contract pins is that a repeat neither throws nor flips the
        // decision.
        expect(s.match("bash", "ls -la")).toBe("allow")
      })
    })
    test("concurrent addAllow calls all land", async () => {
      await withStore({ config: undefined, mode: "interactive" }, async (s) => {
        await Promise.all([
          s.addAllow("bash", "ls"),
          s.addAllow("bash", "pwd"),
          s.addAllow("bash", "cat"),
        ])
        expect(s.match("bash", "ls -la")).toBe("allow")
        expect(s.match("bash", "pwd")).toBe("allow")
        expect(s.match("bash", "cat f")).toBe("allow")
      })
    })
    test('addAllow under the "tool" key stays exact', async () => {
      await withStore({ config: undefined, mode: "interactive" }, async (s) => {
        await s.addAllow("tool", "deploy")
        expect(s.match("tool", "deploy")).toBe("allow")
        expect(s.match("tool", "deployProd")).toBe("unknown")
      })
    })
    test("load() is re-callable and preserves config plus runtime grants", async () => {
      await withStore({ config: file({ bash: ["ls"] }), mode: "interactive" }, async (s) => {
        await s.addAllow("bash", "npm install")
        await s.load()
        await s.load()
        expect(s.match("bash", "ls -la")).toBe("allow")
        expect(s.match("bash", "npm install react")).toBe("allow")
      })
    })
    test("load() on a store with no config and no prior grants leaves it empty", async () => {
      await withStore({ config: undefined, mode: "interactive" }, async (s) => {
        await s.load()
        expect(s.match("bash", "anything")).toBe("unknown")
      })
    })
  })
}
