import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // Set on the WORKER, which is how they reach every child this lane spawns:
    // `spawnProcess` builds `{...process.env, ...options.env}` and neither name
    // is in `GENERATED_APP_UNSET_ENV`.
    //
    // The scaffold now turns CopilotKit telemetry off itself, in the generated
    // app's `next.config.mjs`, so this is no longer what stops the outbound
    // POST to telemetry.copilotkit.ai during `next build`. It stays as a second
    // line for anything else in a generated app that reads either name — this
    // lane's whole claim is that a generated app reaches nothing but the local
    // aimock. `packages/devkit/test/template-telemetry-off.test.ts` is what
    // guards the scaffold default.
    env: {
      COPILOTKIT_TELEMETRY_DISABLED: "true",
      DO_NOT_TRACK: "1",
    },
    exclude: ["test/generated/fixtures/**"],
    fileParallelism: false,
    globalSetup: ["test/harness/registry-global-setup.ts"],
    hookTimeout: 180_000,
    // test/harness holds the shared scaffolding helpers the framework lane
    // exercises; include their unit tests here so they actually run in CI
    // (they were previously orphaned — no config picked them up).
    include: ["test/generated/**/*.test.ts", "test/harness/**/*.test.ts"],
    testTimeout: 180_000,
  },
})
