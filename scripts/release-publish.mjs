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
      tag: createStagingTag(process.env),
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

export async function publishRelease({ packages, tag, npmView, run, log }) {
  const packageStates = await readPackageStates(packages, npmView)
  const pendingPackages = packageStates.filter((state) => state.tags[latestTag] !== state.version)

  if (pendingPackages.length === 0) {
    return { status: "already-published", packages: [] }
  }

  const missingPackages = pendingPackages.filter((state) => !state.versions.includes(state.version))

  for (const state of missingPackages) {
    log(`Staging ${state.name}@${state.version} under ${tag}`)

    try {
      // pnpm pack resolves workspace:* protocol into the tarball
      const packOutput = await run(
        "pnpm",
        ["pack", "--pack-destination", state.dir],
        { cwd: state.dir, cwdPackage: state.package, stdio: "pipe" },
      )
      const tarball = packOutput.split("\n").map((l) => l.trim()).filter(Boolean).find((l) => l.endsWith(".tgz"))

      if (!tarball) {
        throw new Error(`Could not determine tarball name from pnpm pack output`)
      }

      const tarballPath = resolve(state.dir, basename(tarball))

      // npm publish with --provenance uses OIDC for auth (no token needed)
      await run(
        "npm",
        ["publish", tarballPath, "--tag", tag, "--access", state.access, "--provenance"],
        { cwd: state.dir, cwdPackage: state.package },
      )

      await rm(tarballPath, { force: true })
    } catch (error) {
      throw new Error(`Failed to stage ${state.name}@${state.version}: ${formatError(error)}`)
    }
  }

  const verifiedStates = await readPackageStates(packages, npmView)
  const unavailablePackages = verifiedStates.filter(
    (state) => state.tags[latestTag] !== state.version && !state.versions.includes(state.version),
  )

  if (unavailablePackages.length > 0) {
    throw new Error(
      `Refusing to promote latest because these package versions are missing: ${unavailablePackages
        .map((state) => `${state.name}@${state.version}`)
        .join(", ")}`,
    )
  }

  const packagesToPromote = verifiedStates.filter(
    (state) => state.tags[latestTag] !== state.version,
  )

  const promotedStates = []

  for (const state of packagesToPromote) {
    log(`Promoting ${state.name}@${state.version} to ${latestTag}`)

    try {
      await run("npm", ["dist-tag", "add", `${state.name}@${state.version}`, latestTag], {
        cwd: repoRoot,
        cwdPackage: state.package,
      })
      promotedStates.push(state)
    } catch (error) {
      await rollbackLatestTags(promotedStates, run, log)
      throw new Error(`Failed to promote ${state.name}@${state.version}: ${formatError(error)}`)
    }
  }

  const finalStates = await readPackageStates(packages, npmView)
  const unpromotedPackages = finalStates.filter((state) => state.tags[latestTag] !== state.version)

  if (unpromotedPackages.length > 0) {
    throw new Error(
      `Latest tag verification failed for: ${unpromotedPackages
        .map((state) => `${state.name}@${state.version}`)
        .join(", ")}`,
    )
  }

  for (const state of packagesToPromote) {
    const tagName = `${state.name}@${state.version}`

    await run("git", ["tag", tagName], {
      cwd: repoRoot,
      cwdPackage: state.package,
    })
    log(`New tag: ${tagName}`)
  }

  return {
    status: "published",
    packages: packagesToPromote.map((state) => `${state.name}@${state.version}`),
  }
}

async function rollbackLatestTags(states, run, log) {
  for (const state of states.toReversed()) {
    const previousLatest = state.tags[latestTag]

    if (!previousLatest) {
      log(`Removing ${latestTag} from ${state.name}`)
      await run("npm", ["dist-tag", "rm", state.name, latestTag], {
        cwd: repoRoot,
        cwdPackage: state.package,
      })
      continue
    }

    log(`Rolling back ${state.name} ${latestTag} to ${previousLatest}`)
    await run("npm", ["dist-tag", "add", `${state.name}@${previousLatest}`, latestTag], {
      cwd: repoRoot,
      cwdPackage: state.package,
    })
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

export function createStagingTag(env) {
  const runId = env.GITHUB_RUN_ID ?? String(Date.now())
  const runAttempt = env.GITHUB_RUN_ATTEMPT ?? "1"
  return `dawn-release-${runId}-${runAttempt}`.toLowerCase()
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
  const output = await runCommand("npm", args, { cwd: repoRoot, stdio: "pipe" })
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
