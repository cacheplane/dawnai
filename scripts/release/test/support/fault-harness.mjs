import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join } from "node:path"

import { orderReleasePackages } from "../../topology.mjs"
import { startFaultProxy } from "./fault-proxy.mjs"
import { createGitFixture } from "./git-fixture.mjs"
import { startVerdaccio } from "./verdaccio.mjs"

const COMMAND_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export async function createFaultHarness({ fixtureDirectory }) {
  if (typeof fixtureDirectory !== "string" || !isAbsolute(fixtureDirectory)) {
    throw new TypeError("Fault workspace fixture must be an absolute path")
  }
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "dawn-release-fault-harness-"))
  let registry
  let proxy
  let git
  try {
    registry = await startVerdaccio()
    proxy = await startFaultProxy({ upstreamUrl: registry.url })
    git = await createGitFixture({ sourceDirectory: fixtureDirectory })
    const packsDirectory = join(runtimeDirectory, "packs")
    const cacheDirectory = join(runtimeDirectory, "npm-cache")
    const tempDirectory = join(runtimeDirectory, "tmp")
    await Promise.all([mkdir(packsDirectory), mkdir(cacheDirectory), mkdir(tempDirectory)])
    const userConfig = join(runtimeDirectory, "npmrc")
    await writeFile(userConfig, npmConfiguration(registry.url), { mode: 0o600 })
    let closed = false
    let published = false
    return Object.freeze({
      runtimeDirectory,
      registry,
      proxy,
      git,
      async packAndPublish() {
        if (published) throw new Error("Fault workspace was already published")
        assertDisposableRegistry(registry.url)
        await command(
          "pnpm",
          ["install", "--offline", "--ignore-scripts", "--frozen-lockfile=false"],
          {
            cwd: git.workingDirectory,
            env: npmEnvironment({
              registryUrl: registry.url,
              userConfig,
              cacheDirectory,
              tempDirectory,
            }),
          },
        )
        const packages = await releasePackages(git.workingDirectory)
        const ordered = orderReleasePackages(packages, { gateOrder: ["fault-gate"] })
        const publication = []
        for (const packageJson of ordered) {
          const packageDirectory = join(
            git.workingDirectory,
            "packages",
            packageJson.fixtureDirectory,
          )
          const packedOutput = await command(
            "pnpm",
            ["pack", "--pack-destination", packsDirectory],
            {
              cwd: packageDirectory,
              env: npmEnvironment({
                registryUrl: registry.url,
                userConfig,
                cacheDirectory,
                tempDirectory,
              }),
            },
          )
          const tarballName = packedOutput
            .split("\n")
            .map((line) => line.trim())
            .findLast((line) => line.endsWith(".tgz"))
          if (tarballName === undefined) throw new Error("Package manager did not report a tarball")
          const tarballPath = join(packsDirectory, basename(tarballName))
          const bytes = await readFile(tarballPath)
          await command(
            "npm",
            [
              "publish",
              tarballPath,
              "--registry",
              registry.url,
              "--tag",
              "latest",
              "--access",
              "public",
              "--provenance=false",
              "--userconfig",
              userConfig,
              "--scope=",
            ],
            {
              cwd: packageDirectory,
              env: npmEnvironment({
                registryUrl: registry.url,
                userConfig,
                cacheDirectory,
                tempDirectory,
              }),
            },
          )
          publication.push(
            Object.freeze({
              name: packageJson.name,
              version: packageJson.version,
              tarballPath,
              sha256: digest("sha256", bytes, "hex"),
              integrity: `sha512-${digest("sha512", bytes, "base64")}`,
              registryUrl: registry.url,
            }),
          )
        }
        published = true
        return Object.freeze(publication)
      },
      async close() {
        if (closed) return
        closed = true
        const results = await Promise.allSettled([proxy.close(), registry.close(), git.close()])
        await rm(runtimeDirectory, { recursive: true, force: true })
        if (results.some(({ status }) => status === "rejected")) {
          throw new Error("Fault harness cleanup failed")
        }
      },
    })
  } catch (error) {
    await Promise.allSettled([proxy?.close(), registry?.close(), git?.close()])
    await rm(runtimeDirectory, { recursive: true, force: true })
    throw error
  }
}

async function releasePackages(workspaceDirectory) {
  const packagesDirectory = join(workspaceDirectory, "packages")
  const directories = (await readdir(packagesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  return Promise.all(
    directories.map(async (fixtureDirectory) => ({
      ...JSON.parse(
        await readFile(join(packagesDirectory, fixtureDirectory, "package.json"), "utf8"),
      ),
      fixtureDirectory,
    })),
  )
}

function npmConfiguration(registryUrl) {
  const host = new URL(registryUrl).host
  return [
    `registry=${registryUrl}`,
    `@fault:registry=${registryUrl}`,
    `//${host}/:_authToken=fault-harness-token`,
    "replace-registry-host=never",
    "provenance=false",
    "fund=false",
    "audit=false",
    "",
  ].join("\n")
}

function npmEnvironment({ registryUrl, userConfig, cacheDirectory, tempDirectory }) {
  return {
    ...process.env,
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_CACHE: cacheDirectory,
    NPM_CONFIG_REGISTRY: registryUrl,
    NPM_CONFIG_PROVENANCE: "false",
    NPM_CONFIG_REPLACE_REGISTRY_HOST: "never",
    "npm_config_@fault:registry": registryUrl,
    npm_config_scope: "",
    npm_config_tmp: tempDirectory,
  }
}

function command(executable, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd,
        env,
        shell: false,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(
            Object.assign(new Error("Fault harness package command failed"), {
              code: "PACKAGE_COMMAND_FAILED",
            }),
          )
          return
        }
        resolve(stdout)
      },
    )
  })
}

function assertDisposableRegistry(value) {
  const url = new URL(value)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    url.pathname !== "/" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new TypeError("Publish registry must be a disposable loopback URL")
  }
}

function digest(algorithm, bytes, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding)
}
