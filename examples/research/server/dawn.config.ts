import { config } from "@dawn-ai/cli"
import { dockerSandbox } from "@dawn-ai/sandbox"

export default config({
  appDir: "src/app",

  // HITL permissions. Default mode (omitted) is "interactive": a runBash
  // command that is NOT on the allow-list pauses the run for human approval.
  // The external-fetch step (node scripts/fetch-source.mjs ...) is intentionally
  // left off the allow-list so the approval flow is visible on first run.
  permissions: {
    allow: {
      bash: ["ls", "cat", "head", "wc"],
    },
    deny: {
      bash: ["rm -rf", "sudo", "chmod 777", "curl", "wget"],
    },
  },

  // Tool-output offloading. Large tool results are spilled to
  // workspace/tool-outputs/ and replaced in-context with a short stub the
  // agent can read back on demand. The threshold is lowered so a single full
  // corpus document trips it (the default is 40000 chars).
  toolOutput: {
    offloadThresholdChars: 1500,
    previewLines: 10,
  },

  memory: {
    // Keep durable writes reviewable: remember() creates candidates until a
    // developer runs `npm run memory:approve -- <id>`.
    writes: "candidate",
  },

  // Persistence (SQLite checkpointer + Agent Protocol) is on by default — no
  // config needed. Threads survive a restart.

  // --- Capability seam: Docker execution sandbox ---
  // Default runs use the local workspace so the bundled corpus works without
  // Docker. Run `npm run test:sandbox:docker` to dogfood the same scaffold with
  // per-thread isolated Docker workspaces.
  ...(process.env.DAWN_DEMO_DOCKER_SANDBOX === "1"
    ? {
        sandbox: {
          provider: dockerSandbox({ image: "node:22-slim" }),
          network: { mode: "deny" },
          resources: { memoryMb: 512, cpus: 1, timeoutMs: 120_000 },
          idleTimeoutMs: 600_000,
        },
      }
    : {}),

  // --- Capability seam (documented, inactive): conversation summarization ---
  // Uncomment to compress older history once a thread exceeds maxTokens.
  // summarization: {
  //   enabled: true,
  //   maxTokens: 12000,
  //   keepRecentTurns: 6,
  // },
})
