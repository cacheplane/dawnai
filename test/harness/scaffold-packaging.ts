import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Version specifiers for all @dawn-ai packages that the scaffold templates declare.
 * Every dep resolves from the test registry at the `latest` dist-tag, exactly what
 * a real `npm install` does against the Verdaccio uplink.
 */
export function registryLatestSpecifiers() {
  return {
    dawnCli: "latest",
    dawnConfigTypescript: "latest",
    dawnCore: "latest",
    dawnEvals: "latest",
    dawnInspector: "latest",
    dawnLangchain: "latest",
    dawnSandbox: "latest",
    dawnSdk: "latest",
    dawnTesting: "latest",
  }
}

export function candidateRegistryNpmArgs(registryUrl: string): readonly string[] {
  return [`--registry=${registryUrl}`, "--scope=", `--@dawn-ai:registry=${registryUrl}`]
}

/**
 * Point a scaffolded app at the ephemeral test registry. Real users install from
 * a registry; the generated app does exactly that — no overrides, no tarball pins.
 * A genuinely missing @dawn-ai package now 404s from Verdaccio (the registry is
 * local-only for that scope), preserving fail-closed behavior.
 */
export async function writeRegistryNpmrc(appRoot: string, registryUrl: string): Promise<void> {
  const host = registryUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
  const npmrc = [
    `registry=${registryUrl}`,
    // A user-level default scope selects that scope's registry even for an
    // unscoped install. Clear it at project precedence so candidate installs
    // cannot escape the ephemeral registry.
    "scope=",
    // Override a user-level registry mapping for Dawn's scoped packages.
    `@dawn-ai:registry=${registryUrl}`,
    // Parity with a private-registry user; harmless for read-only installs.
    `//${host}/:_authToken="fake"`,
    "",
  ].join("\n")
  await writeFile(join(appRoot, ".npmrc"), npmrc, "utf8")
  await writePnpmWorkspaceBuildPolicy(appRoot)
}

export async function writePnpmWorkspaceBuildPolicy(appRoot: string): Promise<void> {
  const workspacePath = join(appRoot, "pnpm-workspace.yaml")
  const existing = await readFile(workspacePath, "utf8").catch(() => "")

  if (
    existing.includes("onlyBuiltDependencies:") &&
    existing.includes("allowBuilds:") &&
    existing.includes("esbuild: true")
  ) {
    return
  }

  const base = existing.trimEnd() || ["packages:", "  - ."].join("\n")
  await writeFile(
    workspacePath,
    [
      base,
      "",
      "onlyBuiltDependencies:",
      "  - esbuild",
      "",
      "allowBuilds:",
      "  esbuild: true",
      "",
    ].join("\n"),
    "utf8",
  )
}
