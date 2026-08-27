import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // Set on the WORKER, which is how they reach every child this lane spawns:
    // `spawnProcess` builds `{...process.env, ...options.env}` and neither name
    // is in `GENERATED_APP_UNSET_ENV`. Without them the generated app's
    // `npm run build` fans out to `next build`, which evaluates the CopilotKit
    // runtime handler at module scope during "Collecting page data" and fires a
    // real POST to telemetry.copilotkit.ai — an outbound call from a lane whose
    // whole claim is that a generated app reaches nothing but the local aimock.
    // (Whether the SCAFFOLD should default these off is a separate product
    // question; this only closes the test lane. See the plan's S2.)
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
