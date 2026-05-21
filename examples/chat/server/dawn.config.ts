export default {
  appDir: "src/app",
  permissions: {
    // Default mode (omitted) is "interactive" — the demo shows the permission flow.
    // Seed a few obviously-safe commands so prompt fatigue is reasonable on first run.
    allow: {
      bash: ["ls", "pwd", "cat", "echo", "head", "tail", "wc"],
    },
    // Block obviously-destructive patterns even when interactive.
    deny: {
      bash: ["rm -rf", "sudo", "chmod 777"],
    },
  },
}
