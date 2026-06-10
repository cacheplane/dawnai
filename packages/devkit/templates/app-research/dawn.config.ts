export default {
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

  // Persistence (SQLite checkpointer + Agent Protocol) is on by default — no
  // config needed. Threads survive a restart.

  // --- Capability seam (documented, inactive): conversation summarization ---
  // Uncomment to compress older history once a thread exceeds maxTokens.
  // summarization: {
  //   enabled: true,
  //   maxTokens: 12000,
  //   keepRecentTurns: 6,
  // },
}
