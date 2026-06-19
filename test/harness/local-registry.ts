import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
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

  // Write an isolated npmrc that only declares our local registry. We pass
  // npm_config_userconfig to npm so it reads THIS file instead of ~/.npmrc —
  // that bypasses any global scope/registry settings that npm 10 would otherwise
  // apply (including the default replace-registry-host=npmjs behaviour that
  // silently redirects PUT calls back to registry.npmjs.org).
  const packsDir = await mkdtemp(join(tmpdir(), "dawn-packs-"))
  const npmrcPath = join(packsDir, ".npmrc")
  await writeFile(
    npmrcPath,
    [`registry=${url}`, `//${host}/:_authToken=fake`, ""].join("\n"),
    "utf8",
  )

  // Pack each public package into a temp dir, then publish the tarball directly
  // to the local Verdaccio using `npm publish tarball` with an isolated userconfig.
  try {
    for (const { dir } of packages) {
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

      const tarballPath = join(packsDir, basename(tarballName))
      await runPackagedCommand({
        args: ["publish", tarballPath, "--tag", "latest", "--access", "public"],
        command: "npm",
        cwd: dir,
        env: {
          // Point npm at our isolated npmrc so it uses the local registry URL.
          // This is the only reliable way to override registry in npm >=10 — the
          // --registry flag and npm_config_registry env var are both overridden by
          // the user's ~/.npmrc when replace-registry-host=npmjs (npm 10 default).
          npm_config_userconfig: npmrcPath,
        },
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
