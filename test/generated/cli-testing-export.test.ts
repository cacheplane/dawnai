import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { spawnProcess } from "../../packages/devkit/src/testing/index.ts"
import {
  cleanupTrackedTempDirs,
  createPackagedInstaller,
  createTrackedTempDir,
  type TrackedTempDir,
} from "../harness/packaged-app.ts"

const tempDirs: TrackedTempDir[] = []

afterEach(async () => {
  await cleanupTrackedTempDirs(tempDirs)
})

describe.each([
  { subpath: "@dawn-ai/sdk/testing", label: "sdk" },
  { subpath: "@dawn-ai/cli/testing", label: "cli" },
])("$subpath", ({ subpath, label }) => {
  test("packed consumers can import the published testing helpers", {
    timeout: 30_000,
  }, async () => {
    const tempRoot = await createTrackedTempDir(`dawn-${label}-testing-pack-`, tempDirs)
    const { installerDir, tarballs } = await createPackagedInstaller({
      packageNames: ["@dawn-ai/core", "@dawn-ai/langchain", "@dawn-ai/langgraph", "@dawn-ai/sdk", "@dawn-ai/cli"],
      tempRoot,
    })

    await writeInstallerOverrides(installerDir, tarballs)
    await runCommand(
      "pnpm",
      [
        "add",
        requiredTarball(tarballs, "@dawn-ai/core"),
        requiredTarball(tarballs, "@dawn-ai/langchain"),
        requiredTarball(tarballs, "@dawn-ai/langgraph"),
        requiredTarball(tarballs, "@dawn-ai/sdk"),
        requiredTarball(tarballs, "@dawn-ai/cli"),
      ],
      installerDir,
    )

    const scriptPath = join(installerDir, "testing-check.mjs")

    await writeFile(
      scriptPath,
      [
        `import { expectError, expectMeta, expectOutput } from "${subpath}";`,
        "const passed = {",
        '  appRoot: "/tmp/dawn-app",',
        "  durationMs: 1,",
        '  executionSource: "server",',
        '  finishedAt: "2026-04-13T00:00:01.000Z",',
        '  mode: "graph",',
        "  output: { profile: { tenant: 'acme', region: 'us-west' }, tags: ['alpha', 'beta'] },",
        '  routeId: "/support/[tenant]",',
        '  routePath: "src/app/support/[tenant]/index.ts",',
        '  startedAt: "2026-04-13T00:00:00.000Z",',
        '  status: "passed",',
        "};",
        "expectOutput(passed, { profile: { tenant: 'acme' }, tags: ['alpha', 'beta'] });",
        "expectMeta(passed, { executionSource: 'server', mode: 'graph', routeId: '/support/[tenant]', routePath: 'src/app/support/[tenant]/index.ts' });",
        "const failed = {",
        '  appRoot: "/tmp/dawn-app",',
        "  durationMs: 1,",
        "  error: { kind: 'execution_error', message: 'tenant acme exploded while rendering' },",
        '  executionSource: "server",',
        '  finishedAt: "2026-04-13T00:00:01.000Z",',
        '  mode: "graph",',
        '  routeId: "/support/[tenant]",',
        '  routePath: "src/app/support/[tenant]/index.ts",',
        '  startedAt: "2026-04-13T00:00:00.000Z",',
        '  status: "failed",',
        "};",
        "expectError(failed, { kind: 'execution_error', message: { includes: 'acme exploded' } });",
      ].join("\n"),
      "utf8",
    )

    await expect(runCommand("node", [scriptPath], installerDir)).resolves.toMatchObject({
      stderr: "",
      stdout: "",
    })
  })
})

function requiredTarball(tarballs: Readonly<Record<string, string>>, packageName: string): string {
  const tarball = tarballs[packageName]

  if (!tarball) {
    throw new Error(`Missing tarball for ${packageName}`)
  }

  return tarball
}

async function runCommand(command: string, args: readonly string[], cwd: string) {
  const result = await spawnProcess({
    args,
    command,
    cwd,
  })

  if (!result.ok) {
    throw new Error(
      [`${command} ${args.join(" ")} failed`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    )
  }

  return {
    stderr: result.stderr,
    stdout: result.stdout,
  }
}

async function writeInstallerOverrides(
  installerDir: string,
  tarballs: Readonly<Record<string, string>>,
): Promise<void> {
  const packageJsonPath = join(installerDir, "package.json")
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    readonly pnpm?: {
      readonly overrides?: Record<string, string>
    }
  } & Record<string, unknown>

  const overrides = {
    ...(packageJson.pnpm?.overrides ?? {}),
    "@dawn-ai/cli": requiredTarball(tarballs, "@dawn-ai/cli"),
    "@dawn-ai/core": requiredTarball(tarballs, "@dawn-ai/core"),
    "@dawn-ai/langchain": requiredTarball(tarballs, "@dawn-ai/langchain"),
    "@dawn-ai/langgraph": requiredTarball(tarballs, "@dawn-ai/langgraph"),
    "@dawn-ai/sdk": requiredTarball(tarballs, "@dawn-ai/sdk"),
  }

  await writeFile(
    packageJsonPath,
    `${JSON.stringify(
      {
        ...packageJson,
        pnpm: {
          ...(packageJson.pnpm ?? {}),
          overrides,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
}
