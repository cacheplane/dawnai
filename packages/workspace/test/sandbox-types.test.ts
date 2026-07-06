import { describe, expect, test } from "vitest"
import type {
  SandboxConfig,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider,
} from "../src/sandbox-types.ts"
import type { ExecBackend, FilesystemBackend } from "../src/types.ts"

describe("sandbox contract types", () => {
  test("a handle exposes workspace backends + an in-sandbox root", () => {
    const fs = {} as FilesystemBackend
    const exec = {} as ExecBackend
    const handle: SandboxHandle = { threadId: "t1", filesystem: fs, exec, workspaceRoot: "/workspace" }
    expect(handle.workspaceRoot).toBe("/workspace")
  })

  test("policy network is a discriminated union (allow|deny)", () => {
    const allow: SandboxPolicy["network"] = { mode: "allow", denylist: ["1.2.3.4"] }
    const deny: SandboxPolicy["network"] = { mode: "deny", allowlist: ["registry.npmjs.org"] }
    expect(allow.mode).toBe("allow")
    expect(deny.mode).toBe("deny")
  })

  test("a provider implements acquire/release/destroy", async () => {
    const provider: SandboxProvider = {
      name: "noop",
      acquire: async ({ threadId }) => ({
        threadId,
        filesystem: {} as FilesystemBackend,
        exec: {} as ExecBackend,
        workspaceRoot: "/workspace",
      }),
      release: async () => {},
      destroy: async () => {},
    }
    const h = await provider.acquire({ threadId: "t1", policy: { network: { mode: "allow" } }, signal: new AbortController().signal })
    expect(h.threadId).toBe("t1")
    const cfg: SandboxConfig = { provider }
    expect(cfg.provider.name).toBe("noop")
  })
})
