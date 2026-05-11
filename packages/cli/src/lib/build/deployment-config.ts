import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Configuration for LangSmith deployment.
 * Produces fields compatible with langgraph.json schema.
 */

export interface LangGraphConfig {
  /** Paths to local directories/tarballs to install. Always ["."] for Dawn apps. */
  readonly dependencies: readonly string[]
  /** Path to env file relative to build output. */
  readonly env: string
  /** Node.js version. */
  readonly node_version: string
}

export function extractDeploymentConfig(appRoot: string): LangGraphConfig {
  return {
    dependencies: ["."],
    env: detectEnvFilePath(appRoot),
    node_version: "22",
  }
}

function detectEnvFilePath(appRoot: string): string {
  // Prefer .env.example (canonical list of required vars, no secrets)
  if (existsSync(join(appRoot, ".env.example"))) {
    return ".env.example"
  }

  // Fall back to .env (may contain secrets — LangSmith reads var names only)
  return ".env"
}
