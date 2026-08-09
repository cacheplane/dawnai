import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, posix, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const packageRoot = join(repoRoot, "packages")
const cliRoot = join(repoRoot, "packages/cli")
const docsSourceRoot = join(repoRoot, "apps/web/content/docs")
const docsNavPath = join(repoRoot, "apps/web/app/components/docs/nav.ts")
const turboPath = join(repoRoot, "node_modules/turbo/bin/turbo")

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"))
const toPosix = (path) => path.split(/[/\\]+/).join(posix.sep)
const toRepoRelativePath = (path) => toPosix(path.slice(repoRoot.length + 1))

const listMdxFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name)

      if (entry.isDirectory()) {
        return listMdxFiles(path)
      }

      return entry.isFile() && entry.name.endsWith(".mdx") ? [path] : []
    })

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
    const relativeConfigPath = toRepoRelativePath(configPath)
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

try {
  const dryRun = JSON.parse(
    execFileSync(
      process.execPath,
      [turboPath, "run", "build", "--filter=@dawn-ai/cli", "--dry=json"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    ),
  )
  const cliBuildTask = dryRun.tasks?.find((task) => task.taskId === "@dawn-ai/cli#build")

  if (cliBuildTask === undefined) {
    errors.push("Turbo dry run did not include the @dawn-ai/cli#build task")
  } else {
    const taskInputs = new Set(
      Object.keys(cliBuildTask.inputs ?? {}).map((input) =>
        toRepoRelativePath(resolve(cliRoot, input)),
      ),
    )
    const requiredInputs = [
      ...listMdxFiles(docsSourceRoot),
      docsNavPath,
      join(cliRoot, "src/index.ts"),
    ].map(toRepoRelativePath)

    for (const input of requiredInputs) {
      if (!taskInputs.has(input)) {
        errors.push(`@dawn-ai/cli#build is missing cache input: ${input}`)
      }
    }

    for (const output of ["dist/**", "docs/**"]) {
      if (!(cliBuildTask.outputs ?? []).includes(output)) {
        errors.push(`@dawn-ai/cli#build is missing cache output: ${output}`)
      }
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  errors.push(
    `Unable to inspect @dawn-ai/cli#build with Turbo dry run; run \`${process.execPath} ${turboPath} run build --filter=@dawn-ai/cli --dry=json\` from the repository root. (${message})`,
  )
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
  `Build cache config check passed (${checkedConfigs.length} emitting tsconfig file(s), generic dist/** cache and CLI bundled-docs contract checked).`,
)
