import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Extract deployment configuration from the app's package.json and .env file.
 * Used by `dawn build` to produce a complete langgraph.json for LangGraph Platform.
 */

export interface DeploymentConfig {
  readonly dependencies: readonly string[]
  readonly env: readonly string[]
  readonly node_version: string
}

/** Packages required at runtime for LangGraph Platform deployment */
const RUNTIME_PACKAGES = [
  "@langchain/core",
  "@langchain/openai",
  "@langchain/langgraph",
  "@dawn-ai/sdk",
  "@dawn-ai/langchain",
  "@dawn-ai/core",
  "@dawn-ai/cli",
  "zod",
] as const

export function extractDeploymentConfig(appRoot: string): DeploymentConfig {
  const dependencies = detectRuntimeDependencies(appRoot)
  const env = detectEnvVars(appRoot)

  return {
    dependencies,
    env,
    node_version: "22",
  }
}

function detectRuntimeDependencies(appRoot: string): string[] {
  const packageJsonPath = join(appRoot, "package.json")

  try {
    const raw = readFileSync(packageJsonPath, "utf8")
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>
    }

    if (!pkg.dependencies) {
      return []
    }

    // Return all user dependencies (LangGraph Platform installs them)
    return Object.entries(pkg.dependencies).map(([name, version]) => `${name}@${version}`)
  } catch {
    return []
  }
}

function detectEnvVars(appRoot: string): string[] {
  const envPath = join(appRoot, ".env")
  const envExamplePath = join(appRoot, ".env.example")
  const vars: Set<string> = new Set()

  // Parse .env.example first (canonical list of required vars)
  const exampleFile = existsSync(envExamplePath) ? envExamplePath : envPath

  try {
    const content = readFileSync(exampleFile, "utf8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue
      const eqIndex = trimmed.indexOf("=")
      if (eqIndex === -1) continue
      vars.add(trimmed.slice(0, eqIndex).trim())
    }
  } catch {
    // No env file — return common defaults
  }

  // Always include these if not already present
  if (vars.size === 0) {
    vars.add("OPENAI_API_KEY")
  }

  return [...vars].sort()
}

export function generateDockerfile(nodeVersion: string): string {
  return `FROM node:${nodeVersion}-slim

WORKDIR /app

COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN corepack enable && \\
    ([ -f pnpm-lock.yaml ] && pnpm install --frozen-lockfile --prod) || \\
    ([ -f package-lock.json ] && npm ci --omit=dev) || \\
    npm install --omit=dev

COPY . .

EXPOSE 8000

CMD ["node", "--import", "tsx", "node_modules/.bin/dawn", "__dev-child", "--app-root", ".", "--port", "8000"]
`
}
