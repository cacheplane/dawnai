import { spawn } from "node:child_process"
import { readdir, readFile, rm } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const latestTag = "latest"

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

export async function publishRelease({ packages, npmView, run, log }) {
  const packageStates = await readPackageStates(packages, npmView)
  const pendingPackages = packageStates.filter((state) => state.tags[latestTag] !== state.version)

  if (pendingPackages.length === 0) {
    return { status: "already-published", packages: [] }
  }

  const missingPackages = pendingPackages.filter((state) => !state.versions.includes(state.version))
  const stagedPackages = pendingPackages.filter((state) => state.versions.includes(state.version))

  for (const state of missingPackages) {
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

      // npm publish with --provenance uses OIDC for auth (no token needed)
      await run(
        "npm",
        ["publish", tarballPath, "--tag", latestTag, "--access", state.access, "--provenance"],
        { cwd: state.dir, cwdPackage: state.package },
      )

      await rm(tarballPath, { force: true })
    } catch (error) {
      throw new Error(`Failed to publish ${state.name}@${state.version}: ${formatError(error)}`)
    }
  }

  // Promote packages that were published in a prior run but latest wasn't updated
  for (const state of stagedPackages) {
    log(`Promoting ${state.name}@${state.version} to ${latestTag}`)

    try {
      await run("npm", ["dist-tag", "add", `${state.name}@${state.version}`, latestTag], {
        cwd: repoRoot,
        cwdPackage: state.package,
      })
    } catch (error) {
      throw new Error(`Failed to promote ${state.name}@${state.version}: ${formatError(error)}`)
    }
  }

  const verifiedStates = await verifyPublishedWithRetry(packages, npmView, log)
  const unverifiedPackages = verifiedStates.filter(
    (state) => state.tags[latestTag] !== state.version,
  )

  if (unverifiedPackages.length > 0) {
    throw new Error(
      `Latest tag verification failed for: ${unverifiedPackages
        .map((state) => `${state.name}@${state.version}`)
        .join(", ")}`,
    )
  }

  for (const state of verifiedStates.filter((state) => state.tags[latestTag] === state.version)) {
    const tagName = `${state.name}@${state.version}`

    await run("git", ["tag", tagName], {
      cwd: repoRoot,
      cwdPackage: state.package,
    })
    log(`New tag: ${tagName}`)
  }

  return {
    status: "published",
    packages: pendingPackages.map((state) => `${state.name}@${state.version}`),
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

async function verifyPublishedWithRetry(packages, npmViewPackage, log, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const states = await readPackageStates(packages, npmViewPackage)
    const unavailable = states.filter((state) => state.tags[latestTag] !== state.version)

    if (unavailable.length === 0) {
      return states
    }

    if (attempt === maxAttempts) {
      return states
    }

    const delayMs = attempt * 5000
    log(
      `Waiting ${delayMs / 1000}s for registry propagation (${unavailable.length} package(s) pending, attempt ${attempt}/${maxAttempts})`,
    )
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
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
