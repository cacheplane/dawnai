import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tempRoot = mkdtempSync(join(tmpdir(), "dawn-publish-smoke-"))

try {
  run("pnpm", ["--filter", "create-dawn-app", "build"], repoRoot)

  const packsDir = join(tempRoot, "packs")
  const installerDir = join(tempRoot, "installer")
  const appDir = join(tempRoot, "hello-dawn")
  mkdirSync(packsDir, { recursive: true })
  mkdirSync(installerDir, { recursive: true })

  const tarballs = {
    cli: packPackage("@dawn/cli", packsDir),
    configTypescript: packPackage("@dawn/config-typescript", packsDir),
    core: packPackage("@dawn/core", packsDir),
    createApp: packPackage("create-dawn-app", packsDir),
    devkit: packPackage("@dawn/devkit", packsDir),
    langgraph: packPackage("@dawn/langgraph", packsDir),
  }

  writeFileSync(
    join(installerDir, "package.json"),
    JSON.stringify(
      {
        name: "installer",
        private: true,
        pnpm: {
          overrides: {
            "@dawn/devkit": tarballs.devkit,
          },
        },
      },
      null,
      2,
    ),
  )

  run("pnpm", ["add", tarballs.devkit], installerDir)
  run("pnpm", ["add", tarballs.createApp], installerDir)
  run("pnpm", ["exec", "create-dawn-app", appDir], installerDir)

  const packageJsonPath = join(appDir, "package.json")
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"))

  for (const field of ["dependencies", "devDependencies"]) {
    const deps = packageJson[field]

    if (!deps) {
      continue
    }

    for (const [name, value] of Object.entries(deps)) {
      if (!name.startsWith("@dawn/")) {
        continue
      }

      if (String(value).startsWith("file:")) {
        throw new Error(
          `Default scaffold still emitted repo-local file dependency for ${name}: ${value}`,
        )
      }
    }
  }

  packageJson.dependencies["@dawn/cli"] = tarballs.cli
  packageJson.dependencies["@dawn/core"] = tarballs.core
  packageJson.dependencies["@dawn/langgraph"] = tarballs.langgraph
  packageJson.devDependencies["@dawn/config-typescript"] = tarballs.configTypescript
  packageJson.pnpm = {
    overrides: {
      "@dawn/cli": tarballs.cli,
      "@dawn/core": tarballs.core,
      "@dawn/langgraph": tarballs.langgraph,
      "@dawn/config-typescript": tarballs.configTypescript,
    },
  }
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)

  run("pnpm", ["install"], appDir)
  run("pnpm", ["typecheck"], appDir)
  run("pnpm", ["check"], appDir)

  console.log("Publish smoke passed.")
} finally {
  rmSync(tempRoot, { force: true, recursive: true })
}

function packPackage(packageName, outputDir) {
  const result = run(
    "pnpm",
    ["--filter", packageName, "pack", "--pack-destination", outputDir],
    repoRoot,
  )
  const tarballName = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => line.endsWith(".tgz"))

  if (!tarballName) {
    throw new Error(`Could not find tarball name for ${packageName}`)
  }

  return join(outputDir, basename(tarballName))
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
