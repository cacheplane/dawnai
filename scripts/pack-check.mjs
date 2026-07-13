import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  expectedExportFailures,
  missingExportTargets,
  packages,
  validatePackManifest,
} from "./lib/pack-check.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
validatePackManifest(repoRoot, packages)

const tempRoot = mkdtempSync(join(tmpdir(), "dawn-pack-check-"))
const failures = []

try {
  for (const packageConfig of packages) {
    const packageDir = resolve(repoRoot, packageConfig.dir)
    const sourcePackageJson = readJson(join(packageDir, "package.json"))

    if (sourcePackageJson.scripts?.build) {
      run("pnpm", ["--filter", sourcePackageJson.name, "build"], repoRoot)
    }

    const packDir = join(tempRoot, packageConfig.dir.replaceAll("/", "-"))
    mkdirSync(packDir, { recursive: true })

    run("pnpm", ["pack", "--pack-destination", packDir], packageDir)

    const tarballName = readTarballName(packDir)
    const extractDir = join(packDir, "extract")
    mkdirSync(extractDir, { recursive: true })
    run("tar", ["-xzf", join(packDir, tarballName), "-C", extractDir], repoRoot)

    const packedRoot = join(extractDir, "package")
    const packedPackageJson = readJson(join(packedRoot, "package.json"))

    for (const relativePath of packageConfig.expectedFiles) {
      if (!existsSync(join(packedRoot, relativePath))) {
        failures.push(`${sourcePackageJson.name}: packed tarball is missing ${relativePath}`)
      }
    }

    for (const fieldName of packageConfig.requiredFields) {
      if (readField(packedPackageJson, fieldName) === undefined) {
        failures.push(`${sourcePackageJson.name}: packed package.json is missing ${fieldName}`)
      }
    }

    for (const exportTarget of missingExportTargets(packedRoot, packedPackageJson.exports)) {
      failures.push(
        `${sourcePackageJson.name}: packed package.json exports missing file ${exportTarget}`,
      )
    }

    for (const exportFailure of expectedExportFailures(
      packedPackageJson.exports,
      packageConfig.expectedExports,
    )) {
      failures.push(`${sourcePackageJson.name}: packed package.json ${exportFailure}`)
    }

    for (const [dependencyField, dependencies] of Object.entries({
      dependencies: packedPackageJson.dependencies,
      devDependencies: packedPackageJson.devDependencies,
      peerDependencies: packedPackageJson.peerDependencies,
      optionalDependencies: packedPackageJson.optionalDependencies,
    })) {
      if (!dependencies) {
        continue
      }

      for (const [dependencyName, version] of Object.entries(dependencies)) {
        if (String(version).startsWith("file:")) {
          failures.push(
            `${sourcePackageJson.name}: packed ${dependencyField} contains repo-local file dependency ${dependencyName}@${version}`,
          )
        }
      }
    }

    const publintResult = spawnSync("pnpm", ["exec", "publint", packedRoot], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    })

    if (publintResult.status !== 0) {
      failures.push(
        `${sourcePackageJson.name}: publint failed for packed artifact\n${[publintResult.stdout, publintResult.stderr].filter(Boolean).join("\n")}`.trim(),
      )
    }
  }
} finally {
  rmSync(tempRoot, { force: true, recursive: true })
}

if (failures.length > 0) {
  console.error("Pack check failed:\n")
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log("Pack check passed.")

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function readTarballName(packDir) {
  const result = spawnSync("sh", ["-lc", "ls *.tgz"], {
    cwd: packDir,
    encoding: "utf8",
  })

  if (result.status !== 0) {
    throw new Error(result.stderr || "Could not find packed tarball")
  }

  return result.stdout.trim()
}

function readField(object, path) {
  return path.split(".").reduce((current, segment) => current?.[segment], object)
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  })

  if (result.status !== 0) {
    throw new Error(
      [`Command failed: ${command} ${args.join(" ")}`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    )
  }

  return result
}
