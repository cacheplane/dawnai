import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tempRoot = mkdtempSync(join(tmpdir(), "dawn-pack-check-"))

const packages = [
  {
    dir: "packages/core",
    expectedFiles: ["dist/index.js", "dist/index.d.ts", "README.md"],
    requiredFields: [
      "publishConfig.access",
      "repository",
      "homepage",
      "bugs",
      "license",
      "engines.node",
      "exports",
    ],
  },
  {
    dir: "packages/langgraph",
    expectedFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/define-entry.js",
      "dist/route-module.js",
      "README.md",
    ],
    requiredFields: [
      "publishConfig.access",
      "repository",
      "homepage",
      "bugs",
      "license",
      "engines.node",
      "exports",
      "types",
    ],
  },
  {
    dir: "packages/sdk",
    expectedFiles: [
      "dist/agent.js",
      "dist/agent.d.ts",
      "dist/index.js",
      "dist/index.d.ts",
      "package.json",
    ],
    requiredFields: [
      "publishConfig.access",
      "repository",
      "homepage",
      "bugs",
      "license",
      "engines.node",
      "exports",
      "types",
    ],
  },
  {
    dir: "packages/cli",
    expectedFiles: ["dist/index.js", "README.md"],
    requiredFields: [
      "publishConfig.access",
      "repository",
      "homepage",
      "bugs",
      "license",
      "engines.node",
      "bin",
    ],
  },
  {
    dir: "packages/devkit",
    expectedFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "templates/app-basic/npmrc.template",
      "templates/app-basic/package.json.template",
      "README.md",
    ],
    requiredFields: [
      "publishConfig.access",
      "repository",
      "homepage",
      "bugs",
      "license",
      "engines.node",
      "exports",
      "types",
    ],
  },
  {
    dir: "packages/create-dawn-app",
    expectedFiles: ["dist/index.js", "README.md"],
    requiredFields: [
      "publishConfig.access",
      "repository",
      "homepage",
      "bugs",
      "license",
      "engines.node",
      "bin",
    ],
  },
  {
    dir: "packages/config-biome",
    expectedFiles: ["biome.json", "README.md"],
    requiredFields: [
      "publishConfig.access",
      "repository",
      "homepage",
      "bugs",
      "license",
      "engines.node",
      "exports",
    ],
  },
  {
    dir: "packages/config-typescript",
    expectedFiles: ["base.json", "library.json", "node.json", "nextjs.json", "README.md"],
    requiredFields: [
      "publishConfig.access",
      "repository",
      "homepage",
      "bugs",
      "license",
      "engines.node",
      "exports",
    ],
  },
]

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
