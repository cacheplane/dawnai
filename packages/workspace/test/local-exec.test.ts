import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localExec } from "../src/local-exec.js"

function ctx(workspaceRoot: string) {
  return { signal: new AbortController().signal, workspaceRoot }
}

describe("localExec", () => {
  it("runCommand captures stdout, stderr, exitCode", async () => {
    const root = mkdtempSync(join(tmpdir(), "dawn-localexec-"))
    try {
      const exec = localExec()
      const out = await exec.runCommand({ command: "echo hello" }, ctx(root))
      expect(out.stdout.trim()).toBe("hello")
      expect(out.exitCode).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("runCommand returns non-zero exitCode on failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "dawn-localexec-"))
    try {
      const exec = localExec()
      const out = await exec.runCommand({ command: "exit 7" }, ctx(root))
      expect(out.exitCode).toBe(7)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("runCommand enforces timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "dawn-localexec-"))
    try {
      const exec = localExec({ timeout: 100 })
      await expect(
        exec.runCommand({ command: "sleep 1" }, ctx(root)),
      ).rejects.toThrow(/timeout/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("runCommand respects allowedCommands regex allowlist", async () => {
    const root = mkdtempSync(join(tmpdir(), "dawn-localexec-"))
    try {
      const exec = localExec({ allowedCommands: [/^echo\b/, /^ls\b/] })
      const ok = await exec.runCommand({ command: "echo allowed" }, ctx(root))
      expect(ok.stdout.trim()).toBe("allowed")
      await expect(
        exec.runCommand({ command: "rm -rf /" }, ctx(root)),
      ).rejects.toThrow(/not allowed/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
