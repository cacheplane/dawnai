import { spawn } from "node:child_process"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

export const packageSets = {
  "memory-pgvector-core": ["@dawn-ai/memory-pgvector", "@dawn-ai/memory", "@dawn-ai/langchain"],
  public: null,
}

export function resolvePackageSet(name, publicPackages = []) {
  if (name === "public") {
    return publicPackages.map((pkg) => pkg.packageJson.name)
  }

  const packages = packageSets[name]
  if (!packages) {
    throw new Error(`Unknown package set "${name}". Known sets: ${Object.keys(packageSets).join(", ")}`)
  }

  return packages
}

export function resolveRequestedVersion({ requested, tags }) {
  if (requested === "latest") {
    if (!tags?.latest) {
      throw new Error("Could not resolve npm dist-tag latest")
    }

    return tags.latest
  }

  return requested
}

export async function readPublicPackages(rootDir = repoRoot) {
  const packagesDir = resolve(rootDir, "packages")
  const entries = await readdir(packagesDir, { withFileTypes: true })
  const packages = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const dir = resolve(packagesDir, entry.name)
    const packageJson = JSON.parse(await readFile(resolve(dir, "package.json"), "utf8"))

    if (packageJson.private !== true) {
      packages.push({ dir, packageJson })
    }
  }

  return packages.sort((left, right) => left.packageJson.name.localeCompare(right.packageJson.name))
}

export function assertCleanDependencySpecs(packageName, packageJson) {
  const bad = []

  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(packageJson[field] ?? {})) {
      if (String(version).startsWith("workspace:") || String(version).startsWith("file:")) {
        bad.push(`${field}.${name}@${version}`)
      }
    }
  }

  if (bad.length > 0) {
    throw new Error(`${packageName} contains unpublished dependency specs: ${bad.join(", ")}`)
  }
}

export function validatePackageMetadata(packageName, packageJson) {
  const failures = []

  for (const field of [
    "name",
    "version",
    "license",
    "repository",
    "homepage",
    "bugs",
    "engines.node",
    "publishConfig.access",
  ]) {
    if (readField(packageJson, field) === undefined) {
      failures.push(`${packageName}: missing package.json ${field}`)
    }
  }

  if (!packageJson.exports && !packageJson.bin) {
    failures.push(`${packageName}: package.json must expose exports or bin`)
  }

  if (packageJson.exports && exportsRequireTypes(packageJson.exports) && !packageJson.types) {
    failures.push(`${packageName}: package.json has exports but no top-level types`)
  }

  return failures
}

function exportsRequireTypes(exportsField) {
  return exportedTargets(exportsField).some((target) => !target.endsWith(".json"))
}

function exportedTargets(value) {
  if (typeof value === "string") {
    return [value]
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => exportedTargets(entry))
  }

  if (value && typeof value === "object") {
    return Object.values(value).flatMap((entry) => exportedTargets(entry))
  }

  return []
}

export function readField(value, path) {
  return path.split(".").reduce((current, part) => current?.[part], value)
}

export async function npmJson(args, options = {}) {
  const output = await run("npm", [...args, "--json"], { ...options, stdio: "pipe" })
  return JSON.parse(output || "null")
}

export async function npmView(packageName) {
  const [versions, tags] = await Promise.all([
    npmJson(["view", packageName, "versions"]),
    npmJson(["view", packageName, "dist-tags"]),
  ])

  return {
    versions: Array.isArray(versions) ? versions : [],
    tags: tags ?? {},
  }
}

export async function makeTempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function removeDir(path) {
  await rm(path, { recursive: true, force: true })
}

export async function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: process.platform === "win32",
      stdio: options.stdio === "pipe" ? ["ignore", "pipe", "pipe"] : "inherit",
    })

    let stdout = ""
    let stderr = ""

    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout)
        return
      }

      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${stderr}`))
    })
  })
}
