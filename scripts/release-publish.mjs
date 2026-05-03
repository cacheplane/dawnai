import { spawn } from "node:child_process"
import { readdir, readFile, rm } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const packages = await readPublicPackages(repoRoot)
    const result = await publishRelease({
      packages,
      npmView,
      run: runCommand,
      log: console.log,
    })

    if (result.status === "already-published") {
      console.log("All public package versions are already published on latest.")
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

/**
 * Publishes packages that are not yet on the registry at their current version.
 * Uses OIDC trusted publishing (--provenance) for authentication — no token needed.
 * Publishes directly with --tag latest so no separate dist-tag promotion is required.
 */
export async function publishRelease({ packages, npmView, run, log }) {
  const packageStates = await readPackageStates(packages, npmView)
  const unpublished = packageStates.filter((state) => !state.versions.includes(state.version))

  if (unpublished.length === 0) {
    return { status: "already-published", packages: [] }
  }

  for (const state of unpublished) {
    log(`Publishing ${state.name}@${state.version}`)

    try {
      // pnpm pack resolves workspace:* protocol into the tarball
      const packOutput = await run("pnpm", ["pack", "--pack-destination", state.dir], {
        cwd: state.dir,
        cwdPackage: state.package,
        stdio: "pipe",
      })
      const tarball = packOutput
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .find((l) => l.endsWith(".tgz"))

      if (!tarball) {
        throw new Error(`Could not determine tarball name from pnpm pack output`)
      }

      const tarballPath = resolve(state.dir, basename(tarball))

      // OIDC trusted publishing: no token needed, provenance handles auth + signing
      await run(
        "npm",
        ["publish", tarballPath, "--tag", "latest", "--access", state.access, "--provenance"],
        { cwd: state.dir, cwdPackage: state.package },
      )

      await rm(tarballPath, { force: true })
    } catch (error) {
      throw new Error(`Failed to publish ${state.name}@${state.version}: ${formatError(error)}`)
    }
  }

  for (const state of unpublished) {
    const tagName = `${state.name}@${state.version}`

    await run("git", ["tag", tagName], {
      cwd: repoRoot,
      cwdPackage: state.package,
    })
    log(`New tag: ${tagName}`)
  }

  return {
    status: "published",
    packages: unpublished.map((state) => `${state.name}@${state.version}`),
  }
}

export async function readPublicPackages(rootDir) {
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

async function readPackageStates(packages, npmViewPackage) {
  return Promise.all(
    packages.map(async (pkg) => {
      const view = await npmViewPackage(pkg.packageJson.name)

      return {
        package: pkg,
        dir: pkg.dir,
        name: pkg.packageJson.name,
        version: pkg.packageJson.version,
        access: pkg.packageJson.publishConfig?.access ?? "public",
        versions: view.versions,
        tags: view.tags,
      }
    }),
  )
}

async function npmView(packageName) {
  const versions = await npmJson(["view", packageName, "versions", "--json"])
  const tags = await npmJson(["view", packageName, "dist-tags", "--json"])

  return {
    versions: Array.isArray(versions) ? versions : [],
    tags: tags && typeof tags === "object" ? tags : {},
  }
}

async function npmJson(args) {
  const output = await runCommand("npm", args, {
    cwd: repoRoot,
    stdio: "pipe",
  })
  return JSON.parse(output || "null")
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
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

function formatError(error) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
