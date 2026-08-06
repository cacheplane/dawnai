import { join } from "node:path"
import type { NextConfig } from "next"

const config: NextConfig = {
  experimental: { useTypeScriptCli: true },
  output: "standalone",
  // Trace from the monorepo root so pnpm-linked workspace deps are copied into
  // the standalone bundle (server.js lands at .next/standalone/packages/inspector/).
  outputFileTracingRoot: join(import.meta.dirname, "../.."),
  // The app's dawn.config.ts (arbitrary user TS) is loaded at RUNTIME through
  // these packages — they must stay require()-able from node_modules, never
  // bundled. NOTE: this list alone is NOT sufficient under pnpm workspace links
  // (workspace deps resolve outside node_modules, so Next bundles them anyway);
  // the turbopackIgnore'd runtime dynamic imports in src/store/resolve.ts do
  // the real externalization — do not remove them.
  serverExternalPackages: ["@dawn-ai/core", "@dawn-ai/memory", "tsx", "typescript"],
}
export default config
