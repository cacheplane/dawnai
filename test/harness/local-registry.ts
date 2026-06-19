import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

import { runServer } from "verdaccio"

import { runPackagedCommand } from "./packaged-app.ts"

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url))

export interface LocalRegistry {
  readonly url: string
  readonly stop: () => Promise<void>
}

export async function startLocalRegistry(): Promise<LocalRegistry> {
  const storage = await mkdtemp(join(tmpdir(), "dawn-verdaccio-"))
  const config = {
    configPath: join(storage, "config.yaml"),
    storage,
    uplinks: { npmjs: { url: "https://registry.npmjs.org/", maxage: "30m" } },
    packages: {
      // Dawn's own packages: local publish only, no npmjs proxy so versions
      // already on the public registry don't shadow our local publish.
      "@dawn-ai/*": { access: "$all", publish: "$anonymous", unpublish: "$anonymous" },
      "create-dawn-ai-app": { access: "$all", publish: "$anonymous", unpublish: "$anonymous" },
      // Everything else: proxy through npmjs for transitive deps
      "**": { access: "$all", publish: "$anonymous", proxy: "npmjs" },
    },
    log: { type: "stdout", format: "pretty", level: "warn" },
  }

  try {
    const app = (await runServer(config as never)) as Server
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s))
    })

    const address = server.address()
    if (!address || typeof address === "string") {
      throw new Error("Verdaccio failed to bind a port")
    }
    const url = `http://127.0.0.1:${address.port}/`

    return {
      url,
      stop: async () => {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        )
        await rm(storage, { force: true, recursive: true })
      },
    }
  } catch (err) {
    await rm(storage, { force: true, recursive: true })
    throw err
  }
}

export async function publishWorkspace(url: string): Promise<void> {
  await assertUniformPublishableVersion()
  const packages = await readPublicPackages()

  const host = url.replace(/^https?:\/\//, "").replace(/\/$/, "")

  // npm config passed as env, the highest-precedence config layer after the command
  // line. Setting these in the publish env makes them authoritative: they override
  // any `registry`/auth inherited from ~/.npmrc, the project .npmrc, or an
  // env-injected npm_config_registry, regardless of what the host machine carries.
  //
  //   - registry: the local Verdaccio (the publish target for unscoped packages once
  //     the inherited default scope is cleared — see `--scope=` below).
  //   - //<host>/:_authToken: Verdaccio accepts $anonymous publish but npm still
  //     wants an auth token in the env for the target host, else ENEEDAUTH.
  //   - replace-registry-host=never: npm 10 otherwise rewrites the PUT target host
  //     back to the public registry; pin it so the tarball PUT stays local.
  //
  // ROOT CAUSE this guards against: `npm publish` resolves the *publish* registry by
  // scope, not from the top-level `registry`. Two failure modes, both silently
  // routing to registry.npmjs.org → ENEEDAUTH/E404 on a developer or CI machine:
  //   1. A SCOPED package (@dawn-ai/*) uses `@<scope>:registry` and falls back to
  //      the public registry — NOT the top-level `registry` — when that scope has no
  //      registry. We set `npm_config_@<scope>:registry` per package below.
  //   2. An inherited default `scope=@foo` in ~/.npmrc routes EVERY publish (even
  //      unscoped create-dawn-ai-app) through `@foo:registry`, ignoring both
  //      `--registry` and `npm_config_registry`. We pass `--scope=` to clear it so
  //      unscoped publishes fall back to the top-level `registry`.
  const baseEnv: NodeJS.ProcessEnv = {
    npm_config_registry: url,
    [`npm_config_//${host}/:_authToken`]: "fake",
    npm_config_replace_registry_host: "never",
    // The release workflow exports NPM_CONFIG_PROVENANCE=true (uppercase) at the
    // job level for trusted publishing to npmjs. Inherited by this `npm publish`
    // it fails with EUSAGE "provenance generation not supported" — Sigstore
    // provenance can't be produced for a throwaway local registry. Override the
    // exact (uppercase) key so it always wins over the job env; harmless on a dev
    // machine where it is unset.
    NPM_CONFIG_PROVENANCE: "false",
  }

  // Pack each public package into a temp dir, then publish the tarball directly
  // to the local Verdaccio.
  const packsDir = await mkdtemp(join(tmpdir(), "dawn-packs-"))
  try {
    for (const { dir, name } of packages) {
      const packResult = await runPackagedCommand({
        args: ["pack", "--pack-destination", packsDir],
        command: "pnpm",
        cwd: dir,
      })
      const tarballName = packResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .find((line) => line.endsWith(".tgz"))

      if (!tarballName) {
        throw new Error(`Could not determine tarball name from pnpm pack in ${dir}`)
      }

      const scope = name.startsWith("@") ? name.slice(0, name.indexOf("/")) : undefined
      const tarballPath = join(packsDir, basename(tarballName))
      await runPackagedCommand({
        // `--scope=` clears any inherited default scope so the publish target comes
        // from `registry` (for unscoped) or the package's own scope (set in env).
        args: ["publish", tarballPath, "--tag", "latest", "--access", "public", "--scope="],
        command: "npm",
        cwd: dir,
        env: scope ? { ...baseEnv, [`npm_config_${scope}:registry`]: url } : baseEnv,
      })
    }
  } finally {
    await rm(packsDir, { force: true, recursive: true })
  }
}

async function readPublicPackages(): Promise<Array<{ dir: string; name: string }>> {
  const packagesDir = join(REPO_ROOT, "packages")
  const entries = await readdir(packagesDir, { withFileTypes: true })
  const packages: Array<{ dir: string; name: string }> = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(packagesDir, entry.name)
    let manifest: { name?: string; private?: boolean }
    try {
      manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
    } catch {
      continue
    }
    if (manifest.private || !manifest.name) continue
    packages.push({ dir, name: manifest.name })
  }

  // Sort for deterministic publish order
  return packages.sort((a, b) => a.name.localeCompare(b.name))
}

const REGISTRY_URL_ENV = "DAWN_TEST_REGISTRY_URL"

/** Read the registry URL published by the lane's globalSetup. Throws if setup did not run. */
export function getTestRegistryUrl(): string {
  const url = process.env[REGISTRY_URL_ENV]
  if (!url) {
    throw new Error(
      `${REGISTRY_URL_ENV} is not set — the lane's registry globalSetup must run before scaffolding helpers.`,
    )
  }
  return url
}

export { REGISTRY_URL_ENV }

async function assertUniformPublishableVersion(): Promise<void> {
  const packagesDir = join(REPO_ROOT, "packages")
  const entries = await readdir(packagesDir, { withFileTypes: true })
  const versions = new Map<string, string>()

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let manifest: { name?: string; version?: string; private?: boolean }
    try {
      manifest = JSON.parse(await readFile(join(packagesDir, entry.name, "package.json"), "utf8"))
    } catch {
      continue
    }
    if (manifest.private || !manifest.name || !manifest.version) continue
    versions.set(manifest.name, manifest.version)
  }

  const unique = new Set(versions.values())
  if (unique.size > 1) {
    const detail = [...versions.entries()].map(([name, v]) => `${name}@${v}`).join(", ")
    throw new Error(
      `Publishable packages must share one canonical version before publishing to the test registry, found: ${detail}`,
    )
  }
}
