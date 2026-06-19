import { writeFile } from "node:fs/promises"
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
    dawnLangchain: "latest",
    dawnSdk: "latest",
    dawnTesting: "latest",
  }
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
    // Parity with a private-registry user; harmless for read-only installs.
    `//${host}/:_authToken="fake"`,
    "",
  ].join("\n")
  await writeFile(join(appRoot, ".npmrc"), npmrc, "utf8")
}
