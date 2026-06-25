import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, posix, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const packageRoot = join(repoRoot, "packages")

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"))
const toPosix = (path) => path.split(/[/\\]+/).join(posix.sep)

const errors = []
const checkedConfigs = []

for (const packageDirName of readdirSync(packageRoot).sort()) {
  const packageDir = join(packageRoot, packageDirName)

  if (!statSync(packageDir).isDirectory()) {
    continue
  }

  for (const fileName of readdirSync(packageDir).sort()) {
    if (!/^tsconfig(?:\..+)?\.json$/.test(fileName)) {
      continue
    }

    const configPath = join(packageDir, fileName)
    const relativeConfigPath = toPosix(configPath.slice(repoRoot.length + 1))
    const config = readJson(configPath)
    const compilerOptions = config.compilerOptions ?? {}
    const outDir = compilerOptions.outDir
    const tsBuildInfoFile = compilerOptions.tsBuildInfoFile

    if (typeof outDir === "string" && compilerOptions.noEmit !== true) {
      const expectedBuildInfoFile = `${outDir.replace(/\/+$/, "")}/tsconfig.tsbuildinfo`

      checkedConfigs.push(relativeConfigPath)

      if (tsBuildInfoFile !== expectedBuildInfoFile) {
        errors.push(
          `${relativeConfigPath} must set compilerOptions.tsBuildInfoFile to ${expectedBuildInfoFile}`,
        )
      }
    }

    if (
      typeof tsBuildInfoFile === "string" &&
      !toPosix(tsBuildInfoFile).startsWith(`${toPosix(outDir ?? "dist")}/`)
    ) {
      errors.push(
        `${relativeConfigPath} writes compilerOptions.tsBuildInfoFile outside its build output: ${tsBuildInfoFile}`,
      )
    }
  }
}

const turboConfig = readJson(join(repoRoot, "turbo.json"))
const buildOutputs = turboConfig.tasks?.build?.outputs ?? []

if (!buildOutputs.includes("dist/**")) {
  errors.push('turbo.json build task must include "dist/**" in outputs')
}

if (errors.length > 0) {
  console.error("Build cache config check failed.")
  console.error("")

  for (const error of errors) {
    console.error(`- ${error}`)
  }

  process.exit(1)
}

console.log(
  `Build cache config check passed (${checkedConfigs.length} emitting tsconfig file(s), dist/** cached).`,
)
