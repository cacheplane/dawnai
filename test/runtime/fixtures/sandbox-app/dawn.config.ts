// Imported from source (not the "@dawn-ai/sandbox/testing" package specifier)
// because this fixture's dawn.config.ts is loaded at runtime by the tsx loader,
// and @dawn-ai/sandbox is not symlinked into this worktree's node_modules. The
// relative source path resolves under tsx with no install/link step. fakeSandbox
// only type-imports from @dawn-ai/workspace (erased at runtime), so this pulls in
// no runtime package dependency.
import { fakeSandbox } from "../../../../packages/sandbox/src/testing/fake-sandbox.ts"

// A single fakeSandbox instance backs the whole app: the SandboxManager keeps
// one provider and asks it for a per-thread handle, so each thread gets its own
// in-memory volume (path → content) that persists across turns and is isolated
// from other threads. The `exec` is observable — it echoes the command into
// stdout so a runBash routing assertion is possible — but the primary proof in
// run-sandbox-wiring.test.ts is the filesystem (writeFile/readFile), which works
// with the default exec too.
export default {
  appDir: "src/app",
  sandbox: {
    provider: fakeSandbox({
      exec: async ({ command }) => ({
        stdout: `SANDBOX_EXEC: ${command}`,
        stderr: "",
        exitCode: 0,
      }),
    }),
  },
}
