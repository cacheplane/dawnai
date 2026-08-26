import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test, vi } from "vitest"

import {
  cleanupTrackedTempDirs,
  createTrackedTempDir,
  installPackagedScaffolder,
  type TrackedTempDir,
} from "../../../test/harness/packaged-app.ts"
import { run } from "../src/index.js"

const tempDirs: TrackedTempDir[] = []

/**
 * The root orchestrator manifest of the two-package research workspace. Every
 * single-workspace delegator ends with a literal ` --`; without it npm eats the
 * flag NAME out of `npm run dev -- --port 4123`. See
 * `packages/devkit/test/template-root-scripts.test.ts`.
 */
const RESEARCH_ROOT_SCRIPTS = {
  dev: "npm run dev --workspace server --",
  "dev:server": "npm run dev --workspace server --",
  "dev:web": "npm run dev --workspace web --",
  verify: "npm run verify --workspace server --",
  typegen: "npm run typegen --workspace server --",
  check: "npm run check --workspace server --",
  typecheck: "npm run typecheck --workspaces --if-present",
  test: "npm run test --workspaces --if-present",
  eval: "npm run eval --workspace server --",
  build: "npm run build --workspaces --if-present",
  start: "npm start --workspace server --",
  "memory:list": "npm run memory:list --workspace server --",
  "memory:approve": "npm run memory:approve --workspace server --",
} as const

/** The Dawn app itself, one level down in `server/`. */
const RESEARCH_SERVER_SCRIPTS = {
  dev: "dawn dev --port 3002",
  verify: "dawn verify",
  typegen: "dawn typegen",
  check: "dawn check",
  typecheck: "tsc --noEmit",
  test: "vitest run",
  eval: "dawn eval",
  build: "dawn build",
  start: "node --env-file-if-exists=.env .dawn/build/server.mjs",
  "test:sandbox:docker": "DAWN_DEMO_DOCKER_SANDBOX=1 vitest run test/sandbox-docker.test.ts",
  "memory:list": "dawn memory list",
  "memory:approve": "dawn memory approve",
} as const

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupTrackedTempDirs(tempDirs)
})

async function assertExists(path: string) {
  await expect(access(path, constants.F_OK)).resolves.toBeUndefined()
}

function extractYamlStringValue(yaml: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = yaml.match(new RegExp(`^  "${escaped}": "([^"]+)"$`, "m"))
  if (!match?.[1]) throw new Error(`Missing YAML override for ${key}`)
  return match[1]
}

async function runCommand(command: string, args: readonly string[], cwd: string) {
  return await new Promise<{
    readonly code: number | null
    readonly stdout: string
    readonly stderr: string
  }>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })

    child.once("error", rejectPromise)
    child.once("close", (code) => {
      resolvePromise({ code, stderr, stdout })
    })
  })
}

async function withMockedPlatform<T>(
  platform: NodeJS.Platform,
  action: () => Promise<T>,
): Promise<T> {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")

  if (!platformDescriptor?.configurable) {
    throw new Error("process.platform must be configurable for this test")
  }

  try {
    Object.defineProperty(process, "platform", {
      ...platformDescriptor,
      value: platform,
    })
    return await action()
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor)
  }
}

function resolveFileSpecifier(specifier: string): string {
  return specifier.startsWith("file://")
    ? fileURLToPath(specifier)
    : specifier.slice("file:".length)
}

describe("create-dawn-ai-app", () => {
  test("scaffolds external mode from the packaged bin with published dist-tag specifiers", {
    timeout: 30_000,
  }, async () => {
    const tempRoot = await createTrackedTempDir("create-dawn-app-standalone-", tempDirs)

    const { installerDir: installDir } = await installPackagedScaffolder(tempRoot)
    const targetDir = join(tempRoot, "hello-dawn")

    const scaffoldResult = await runCommand(
      "pnpm",
      ["exec", "create-dawn-ai-app", targetDir, "--dist-tag", "next"],
      installDir,
    )
    expect(scaffoldResult.code).toBe(0)

    // Root of the npm workspace: orchestrator manifest, workspace config, docs.
    await assertExists(join(targetDir, "package.json"))
    await assertExists(join(targetDir, "pnpm-workspace.yaml"))
    await assertExists(join(targetDir, "README.md"))
    await assertExists(join(targetDir, ".gitignore"))

    // The Dawn app itself now lives in the `server` workspace.
    await assertExists(join(targetDir, "server/package.json"))
    await assertExists(join(targetDir, "server/dawn.config.ts"))
    await assertExists(join(targetDir, "server/.env.example"))
    await assertExists(join(targetDir, "server/src/app/research/index.ts"))
    await assertExists(join(targetDir, "server/src/app/research/state.ts"))
    await assertExists(join(targetDir, "server/src/app/research/plan.md"))
    await assertExists(join(targetDir, "server/src/tools/searchCorpus.ts"))
    await assertExists(join(targetDir, "server/src/tools/readDoc.ts"))
    await assertExists(join(targetDir, "server/src/app/research/subagents/researcher/index.ts"))
    await assertExists(join(targetDir, "server/src/app/research/skills/cite-sources/SKILL.md"))
    await assertExists(join(targetDir, "server/src/app/research/evals/research-quality.eval.ts"))
    await assertExists(join(targetDir, "server/test/research.test.ts"))
    await assertExists(join(targetDir, "server/workspace/AGENTS.md"))
    await assertExists(join(targetDir, "server/workspace/corpus/agent-architectures.md"))
    await assertExists(join(targetDir, "server/workspace/scripts/fetch-source.mjs"))

    // ...and the Workbench UI in the `web` workspace.
    await assertExists(join(targetDir, "web/package.json"))

    const rootManifest = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8")) as {
      readonly name: string
      readonly scripts: Record<string, string>
      readonly workspaces: readonly string[]
    }
    const serverManifest = JSON.parse(
      await readFile(join(targetDir, "server/package.json"), "utf8"),
    ) as {
      readonly name: string
      readonly dependencies: Record<string, string>
      readonly devDependencies: Record<string, string>
      readonly scripts: Record<string, string>
    }

    const researchRoute = await readFile(
      join(targetDir, "server/src/app/research/index.ts"),
      "utf8",
    )

    expect(rootManifest.name).toBe("hello-dawn")
    expect(rootManifest.workspaces).toEqual(["server", "web"])
    expect(rootManifest.scripts).toEqual(RESEARCH_ROOT_SCRIPTS)
    expect(serverManifest.name).toBe("hello-dawn-server")
    expect(serverManifest.scripts).toEqual(RESEARCH_SERVER_SCRIPTS)
    expect(researchRoute).toContain("recursionLimit: 100")
    expect(serverManifest.dependencies["@dawn-ai/cli"]).not.toMatch(/^file:/)
    expect(serverManifest.dependencies["@dawn-ai/langchain"]).not.toMatch(/^file:/)
    expect(serverManifest.dependencies["@dawn-ai/sandbox"]).not.toMatch(/^file:/)
    expect(serverManifest.devDependencies["@dawn-ai/config-typescript"]).not.toMatch(/^file:/)
    expect(serverManifest.devDependencies["@dawn-ai/testing"]).not.toMatch(/^file:/)
    expect(serverManifest.devDependencies["@dawn-ai/evals"]).not.toMatch(/^file:/)
    expect(serverManifest.devDependencies["@dawn-ai/inspector"]).not.toMatch(/^file:/)
    expect(serverManifest.dependencies["@dawn-ai/cli"]).toBe("next")
    expect(serverManifest.dependencies["@dawn-ai/langchain"]).toBe("next")
    expect(serverManifest.dependencies["@dawn-ai/sandbox"]).toBe("next")
    expect(serverManifest.devDependencies["@dawn-ai/config-typescript"]).toBe("next")
    expect(serverManifest.devDependencies["@dawn-ai/testing"]).toBe("next")
    expect(serverManifest.devDependencies["@dawn-ai/evals"]).toBe("next")
    expect(serverManifest.devDependencies["@dawn-ai/inspector"]).toBe("next")

    // The web workspace owns the only `@dawn-ai/ag-ui` dependency edge.
    const webManifest = JSON.parse(await readFile(join(targetDir, "web/package.json"), "utf8")) as {
      readonly name: string
      readonly dependencies: Record<string, string>
    }

    expect(webManifest.name).toBe("hello-dawn-web")
    expect(webManifest.dependencies["@dawn-ai/ag-ui"]).toBe("next")

    await expect(access(join(targetDir, ".npmrc"), constants.F_OK)).rejects.toThrow()

    expect(scaffoldResult.stdout).toContain(
      [
        `  cd '${targetDir}'`,
        "  npm install",
        "  cp server/.env.example server/.env",
        "  # add OPENAI_API_KEY",
        "  npm run verify",
        "",
        "Then start both processes, one per terminal:",
        "  npm run dev:server  # agent server on http://127.0.0.1:3002",
        "  npm run dev:web     # web UI on http://localhost:3010",
        "",
        "See your agent:",
        "  npx dawn inspect --cwd server  # memory Inspector (browser UI), in a third terminal",
      ].join("\n"),
    )
    expect(scaffoldResult.stdout).toContain("See README.md for the full tour")
    expect(scaffoldResult.stdout).not.toContain("docs/recipes/research-web-ui")
    expect(scaffoldResult.stdout).not.toContain("npm run check")
    expect(scaffoldResult.stdout).not.toContain("npm test")
    expect(scaffoldResult.stdout).not.toContain("export OPENAI_API_KEY")
  })

  test("shell-quotes POSIX research target paths with metacharacters", async () => {
    const tempRoot = await createTrackedTempDir("create-dawn-app-internal-", tempDirs)
    const targetDir = join(tempRoot, "hello dawn's $HOME $(touch pwned); `whoami`")
    const targetLiteral = `'${targetDir.replaceAll("'", "'\\''")}'`
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    const exitCode = await withMockedPlatform("linux", () => run([targetDir, "--mode", "internal"]))
    const stdout = stdoutWrite.mock.calls.map(([chunk]) => String(chunk)).join("")

    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      [
        "Next steps:",
        `  cd ${targetLiteral}`,
        "  npm install",
        "  cp server/.env.example server/.env",
        "  # add OPENAI_API_KEY",
        "  npm run verify",
        "",
        "Then start both processes, one per terminal:",
        "  npm run dev:server  # agent server on http://127.0.0.1:3002",
        "  npm run dev:web     # web UI on http://localhost:3010",
        "",
        "See your agent:",
        "  npx dawn inspect --cwd server  # memory Inspector (browser UI), in a third terminal",
      ].join("\n"),
    )
    expect(stdout).not.toContain("docs/recipes/research-web-ui")
    expect(stdout).not.toContain("npm run check")
    expect(stdout).not.toContain("npm test")
    expect(stdout).not.toContain("export OPENAI_API_KEY")
  })

  test("prints safe PowerShell research activation steps on Windows", async () => {
    const tempRoot = await createTrackedTempDir("create-dawn-app-internal-", tempDirs)
    const targetDir = join(tempRoot, "hello dawn's $HOME $(noop); `noop`")
    const targetLiteral = `'${targetDir.replaceAll("'", "''")}'`
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    const exitCode = await withMockedPlatform("win32", () => run([targetDir, "--mode", "internal"]))
    const stdout = stdoutWrite.mock.calls.map(([chunk]) => String(chunk)).join("")

    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      [
        "Next steps (PowerShell):",
        `  Set-Location -LiteralPath ${targetLiteral}`,
        "  npm install",
        "  Copy-Item -LiteralPath server/.env.example -Destination server/.env",
        "  # add OPENAI_API_KEY",
        "  npm run verify",
        "",
        "Then start both processes, one per terminal:",
        "  npm run dev:server  # agent server on http://127.0.0.1:3002",
        "  npm run dev:web     # web UI on http://localhost:3010",
        "",
        "See your agent:",
        "  npx dawn inspect --cwd server  # memory Inspector (browser UI), in a third terminal",
      ].join("\n"),
    )
    expect(stdout).not.toContain("  cp server/.env.example server/.env")
    expect(stdout).not.toContain("docs/recipes/research-web-ui")
    expect(stdout).not.toContain("npm run check")
    expect(stdout).not.toContain("npm test")
    expect(stdout).not.toContain("export OPENAI_API_KEY")
  })

  test("rejects packaged internal mode outside a Dawn monorepo checkout", {
    timeout: 30_000,
  }, async () => {
    const tempRoot = await createTrackedTempDir("create-dawn-app-standalone-", tempDirs)

    const { installerDir: installDir } = await installPackagedScaffolder(tempRoot)

    const invalidInternalTargetDir = join(tempRoot, "hello-dawn-internal")
    const internalModeResult = await runCommand(
      "pnpm",
      ["exec", "create-dawn-ai-app", invalidInternalTargetDir, "--mode", "internal"],
      installDir,
    )

    expect(internalModeResult.code).toBe(1)
    expect(internalModeResult.stderr).toContain("Internal mode requires a Dawn monorepo checkout")
  })

  test("supports explicit internal dev scaffolding with repo-local package edges", async () => {
    const tempRoot = await createTrackedTempDir("create-dawn-app-internal-", tempDirs)

    const targetDir = join(tempRoot, "hello-dawn")

    const exitCode = await run([targetDir, "--mode", "internal"])

    expect(exitCode).toBe(0)

    const rootManifest = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8")) as {
      readonly scripts: Record<string, string>
      readonly workspaces: readonly string[]
    }
    const serverManifest = JSON.parse(
      await readFile(join(targetDir, "server/package.json"), "utf8"),
    ) as {
      readonly dependencies: Record<string, string>
      readonly devDependencies: Record<string, string>
      readonly scripts: Record<string, string>
    }

    expect(rootManifest.workspaces).toEqual(["server", "web"])
    expect(rootManifest.scripts).toEqual(RESEARCH_ROOT_SCRIPTS)
    expect(serverManifest.scripts).toEqual(RESEARCH_SERVER_SCRIPTS)
    expect(serverManifest.dependencies["@dawn-ai/cli"]).toMatch(/^file:/)
    expect(serverManifest.dependencies["@dawn-ai/langchain"]).toMatch(/^file:/)
    expect(serverManifest.dependencies["@dawn-ai/sandbox"]).toMatch(/^file:/)
    expect(serverManifest.devDependencies["@dawn-ai/config-typescript"]).toMatch(/^file:/)
    expect(serverManifest.devDependencies["@dawn-ai/testing"]).toMatch(/^file:/)
    expect(serverManifest.devDependencies["@dawn-ai/evals"]).toMatch(/^file:/)
    expect(serverManifest.devDependencies["@dawn-ai/inspector"]).toMatch(/^file:/)
    await assertExists(join(targetDir, "README.md"))
    await assertExists(join(targetDir, ".npmrc"))
    await assertExists(join(targetDir, "pnpm-workspace.yaml"))
    await assertExists(join(targetDir, "server/.env.example"))
    await assertExists(join(targetDir, "server/src/app/research/index.ts"))
    await assertExists(join(targetDir, "server/src/app/research/state.ts"))
    await assertExists(join(targetDir, "server/src/app/research/plan.md"))
    await assertExists(join(targetDir, "server/src/tools/searchCorpus.ts"))
    await assertExists(join(targetDir, "server/src/tools/readDoc.ts"))
    await assertExists(join(targetDir, "server/src/app/research/subagents/researcher/index.ts"))
    await assertExists(join(targetDir, "server/src/app/research/skills/cite-sources/SKILL.md"))
    await assertExists(join(targetDir, "server/src/app/research/evals/research-quality.eval.ts"))
    await assertExists(join(targetDir, "server/test/research.test.ts"))
    await assertExists(join(targetDir, "server/workspace/AGENTS.md"))
    await assertExists(join(targetDir, "server/workspace/corpus/agent-architectures.md"))
    await assertExists(join(targetDir, "server/workspace/scripts/fetch-source.mjs"))

    // ...and the Workbench UI in the `web` workspace.
    await assertExists(join(targetDir, "web/package.json"))
  })

  test("scaffolds the basic tree when --template basic is passed", async () => {
    const tempRoot = await createTrackedTempDir("create-dawn-app-internal-", tempDirs)

    const targetDir = join(tempRoot, "hello-dawn")
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    const exitCode = await run([targetDir, "--mode", "internal", "--template", "basic"])
    const stdout = stdoutWrite.mock.calls.map(([chunk]) => String(chunk)).join("")

    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      [
        "Next steps:",
        `  cd '${targetDir}'`,
        "  npm install",
        "  npm run check     # validate the app",
        "  npm test          # offline tests — no API key needed",
        "",
        "Run it live (needs an OpenAI key):",
        "  export OPENAI_API_KEY=sk-...",
        "  npm run dev       # Dawn dev server on http://127.0.0.1:3000",
      ].join("\n"),
    )
    expect(stdout).toContain(
      "See AGENTS.md for the app's conventions, or https://dawnai.org/docs/getting-started",
    )
    expect(stdout).not.toContain("See README.md")
    expect(stdout).not.toContain("npx dawn inspect")
    expect(stdout).not.toContain("generate route + tool types")
    expect(stdout).not.toContain(".env.example")
    expect(stdout).not.toContain("npm run verify")

    await assertExists(join(targetDir, "src/app/(public)/hello/[tenant]/index.ts"))
    await assertExists(join(targetDir, "src/app/(public)/hello/[tenant]/tools/greet.ts"))
    await assertExists(join(targetDir, "test/agent.test.ts"))
    await expect(
      access(join(targetDir, "src/app/research/index.ts"), constants.F_OK),
    ).rejects.toThrow()
  })

  test("prints safe PowerShell basic steps on Windows", async () => {
    const tempRoot = await createTrackedTempDir("create-dawn-app-internal-", tempDirs)
    const targetDir = join(tempRoot, "hello dawn's basic")
    const targetLiteral = `'${targetDir.replaceAll("'", "''")}'`
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    const exitCode = await withMockedPlatform("win32", () =>
      run([targetDir, "--mode", "internal", "--template", "basic"]),
    )
    const stdout = stdoutWrite.mock.calls.map(([chunk]) => String(chunk)).join("")

    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      [
        "Next steps (PowerShell):",
        `  Set-Location -LiteralPath ${targetLiteral}`,
        "  npm install",
        "  npm run check     # validate the app",
        "  npm test          # offline tests — no API key needed",
        "",
        "Run it live (needs an OpenAI key):",
        "  $env:OPENAI_API_KEY = 'sk-...'",
        "  npm run dev       # Dawn dev server on http://127.0.0.1:3000",
      ].join("\n"),
    )
    expect(stdout).toContain(
      "See AGENTS.md for the app's conventions, or https://dawnai.org/docs/getting-started",
    )
    expect(stdout).not.toContain("See README.md")
    expect(stdout).not.toContain("npx dawn inspect")
    expect(stdout).not.toContain("export OPENAI_API_KEY")
    expect(stdout).not.toContain(".env.example")
    expect(stdout).not.toContain("Copy-Item")
    expect(stdout).not.toContain("npm run verify")
  })

  test("writes contributor-local package specifiers and overrides as stable repo-local paths", async () => {
    const tempRoot = await createTrackedTempDir("create-dawn-app-internal-", tempDirs)
    const targetDir = join(tempRoot, "hello-dawn")
    const repoRoot = resolve(import.meta.dirname, "../../..")

    const exitCode = await run([targetDir, "--mode", "internal"])

    expect(exitCode).toBe(0)

    const serverManifest = JSON.parse(
      await readFile(join(targetDir, "server/package.json"), "utf8"),
    ) as {
      readonly dependencies: Record<string, string>
      readonly devDependencies: Record<string, string>
    }
    const pnpmWorkspace = await readFile(join(targetDir, "pnpm-workspace.yaml"), "utf8")

    // Internal mode APPENDS its overrides; it must not clobber the workspace
    // members the template declares. Losing them leaves pnpm with only the
    // dependency-free root to install, so the overrides apply to nothing.
    expect(pnpmWorkspace).toContain("packages:\n  - server\n  - web\n")

    expect(resolveFileSpecifier(serverManifest.dependencies["@dawn-ai/cli"])).toBe(
      resolve(repoRoot, "packages/cli"),
    )
    expect(resolveFileSpecifier(serverManifest.dependencies["@dawn-ai/langchain"])).toBe(
      resolve(repoRoot, "packages/langchain"),
    )
    expect(resolveFileSpecifier(serverManifest.dependencies["@dawn-ai/sandbox"])).toBe(
      resolve(repoRoot, "packages/sandbox"),
    )
    expect(resolveFileSpecifier(serverManifest.devDependencies["@dawn-ai/config-typescript"])).toBe(
      resolve(repoRoot, "packages/config-typescript"),
    )

    // The web workspace owns the only `@dawn-ai/ag-ui` dependency edge.
    const webManifest = JSON.parse(await readFile(join(targetDir, "web/package.json"), "utf8")) as {
      readonly dependencies: Record<string, string>
    }

    expect(resolveFileSpecifier(webManifest.dependencies["@dawn-ai/ag-ui"])).toBe(
      resolve(repoRoot, "packages/ag-ui"),
    )

    expect(resolveFileSpecifier(extractYamlStringValue(pnpmWorkspace, "@dawn-ai/ag-ui"))).toBe(
      resolve(repoRoot, "packages/ag-ui"),
    )
    expect(resolveFileSpecifier(extractYamlStringValue(pnpmWorkspace, "@dawn-ai/core"))).toBe(
      resolve(repoRoot, "packages/core"),
    )
    expect(resolveFileSpecifier(extractYamlStringValue(pnpmWorkspace, "@dawn-ai/cli"))).toBe(
      resolve(repoRoot, "packages/cli"),
    )
    expect(resolveFileSpecifier(extractYamlStringValue(pnpmWorkspace, "@dawn-ai/langchain"))).toBe(
      resolve(repoRoot, "packages/langchain"),
    )
    expect(resolveFileSpecifier(extractYamlStringValue(pnpmWorkspace, "@dawn-ai/sandbox"))).toBe(
      resolve(repoRoot, "packages/sandbox"),
    )
    expect(
      resolveFileSpecifier(extractYamlStringValue(pnpmWorkspace, "@dawn-ai/config-typescript")),
    ).toBe(resolve(repoRoot, "packages/config-typescript"))
    expect(pnpmWorkspace).toContain("allowBuilds:")
    expect(pnpmWorkspace).toContain("esbuild: true")
  })
})
