import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, posix, relative, resolve } from "node:path"
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

// `dawn build` writes the app bundle here. Without it a cache hit reports
// success and restores nothing — a green `pnpm build` with no server bundle.
if (!buildOutputs.includes(".dawn/build/**")) {
  errors.push('turbo.json build task must include ".dawn/build/**" in outputs')
}

// Tests import their workspace dependencies through `exports`, which resolve to
// `dist/`. Without a build edge the test graph produces no `dist/` at all and
// runs against whatever happens to be on disk.
//
// `typecheck` needs the same edge for the same reason, plus one of its own: a
// package's typecheck compiles files that may import its OWN `dist/`
// (packages/memory's benches do), and `tsc --noEmit` writes
// `dist/tsconfig.tsbuildinfo` — the very file `build` writes. Without a self
// edge those two tasks are unordered, so a clean-tree `turbo run typecheck`
// passes or fails on scheduling luck and the two can write one incremental-state
// file concurrently. `"build"` subsumes `"^build"`, since `build` already
// declares `dependsOn: ["^build"]`.
for (const [taskName, task] of Object.entries(turboConfig.tasks ?? {})) {
  const bareName = taskName.includes("#") ? taskName.slice(taskName.indexOf("#") + 1) : taskName

  if (bareName !== "test" && bareName !== "typecheck") {
    continue
  }

  if (!(task.dependsOn ?? []).includes("build")) {
    errors.push(
      `turbo.json ${taskName} must include "build" in dependsOn (package-scoped task configs replace the generic one rather than merging)`,
    )
  }
}

/** Every task Turbo would run, keyed by task id, with inputs made repo-relative. */
const taskIndex = new Map()
let dryRunFailure

for (const taskName of ["build", "test", "lint"]) {
  try {
    const output = execFileSync(process.execPath, [turboPath, "run", taskName, "--dry=json"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    })

    for (const task of JSON.parse(output.slice(output.indexOf("{"))).tasks ?? []) {
      const directory = join(repoRoot, task.directory)

      taskIndex.set(task.taskId, {
        directory,
        dependencies: task.dependencies ?? [],
        outputs: task.outputs ?? [],
        packageName: task.package,
        inputs: new Set(
          Object.keys(task.inputs ?? {}).map((input) =>
            toRepoRelativePath(resolve(directory, input)),
          ),
        ),
      })
    }
  } catch (error) {
    dryRunFailure = error instanceof Error ? error.message : String(error)
    errors.push(
      `Unable to inspect the ${taskName} task graph; run \`${process.execPath} ${turboPath} run ${taskName} --dry=json\` from the repository root. (${dryRunFailure})`,
    )
  }
}

const cliBuildTask = taskIndex.get("@dawn-ai/cli#build")

if (cliBuildTask === undefined) {
  if (dryRunFailure === undefined) {
    errors.push("Turbo dry run did not include the @dawn-ai/cli#build task")
  }
} else {
  const requiredInputs = [
    ...listMdxFiles(docsSourceRoot),
    docsNavPath,
    join(cliRoot, "src/index.ts"),
  ].map(toRepoRelativePath)

  for (const input of requiredInputs) {
    if (!cliBuildTask.inputs.has(input)) {
      errors.push(`@dawn-ai/cli#build is missing cache input: ${input}`)
    }
  }

  for (const output of ["dist/**", "docs/**"]) {
    if (!cliBuildTask.outputs.includes(output)) {
      errors.push(`@dawn-ai/cli#build is missing cache output: ${output}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Reachability: a task must declare everything it actually reads
// ---------------------------------------------------------------------------

// `--others` so a brand-new test file is scanned before it is ever staged.
const trackedFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\n")
  .filter(Boolean)

/** Workspace package directories, longest first so nested packages win. */
const workspaceDirectories = [...taskIndex.values()]
  .map((task) => ({ directory: task.directory, packageName: task.packageName }))
  .sort((left, right) => right.directory.length - left.directory.length)

const declaredDependencies = new Map()

const dependenciesOf = (packageDirectory) => {
  if (!declaredDependencies.has(packageDirectory)) {
    const manifest = readJson(join(packageDirectory, "package.json"))

    declaredDependencies.set(
      packageDirectory,
      new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]),
    )
  }

  return declaredDependencies.get(packageDirectory)
}

/** Relative-path string literals: `"../../foo"`, `'./bar'`, `` `../baz` ``. */
const relativeLiteralPattern = /["'`](\.\.?\/[^"'`\n]*)["'`]/g
/** `test/` reads belong to the package's test task, `scripts/` to its build. */
const scannedDirectories = [
  ["test", "test"],
  ["scripts", "build"],
]

let scannedFileCount = 0

for (const { directory, packageName } of workspaceDirectories) {
  const packageRelativeRoot = toRepoRelativePath(directory)

  for (const [subdirectory, taskName] of scannedDirectories) {
    const task = taskIndex.get(`${packageName}#${taskName}`)

    if (task === undefined) {
      continue
    }

    const prefix = `${packageRelativeRoot}/${subdirectory}/`
    const sources = trackedFiles.filter(
      (file) => file.startsWith(prefix) && /\.(ts|tsx|mts|mjs|js)$/.test(file),
    )

    for (const file of sources) {
      scannedFileCount += 1
      const contents = readFileSync(join(repoRoot, file), "utf8")

      for (const [, literal] of contents.matchAll(relativeLiteralPattern)) {
        const absolute = resolve(dirname(join(repoRoot, file)), literal)

        // Outside the repository, the package itself or an ancestor of it (a
        // base path for later joins, not a read), or built at runtime rather
        // than read from the tree: nothing to declare.
        if (absolute === repoRoot || relative(repoRoot, absolute).startsWith("..")) continue
        if (absolute === directory || directory.startsWith(`${absolute}${posix.sep}`)) continue
        if (absolute.startsWith(`${directory}${posix.sep}`)) continue
        if (!existsSync(absolute)) continue

        const repoRelative = toRepoRelativePath(absolute)

        if (repoRelative.split("/").includes("node_modules")) continue

        const owner = workspaceDirectories.find(
          (candidate) =>
            absolute === candidate.directory ||
            absolute.startsWith(`${candidate.directory}${posix.sep}`),
        )

        // A declared workspace dependency is already covered: `^test` hashes its
        // sources and `build` -> `^build` orders its output.
        if (owner !== undefined && dependenciesOf(directory).has(owner.packageName)) continue

        // Reaching into another package's build output. That package cannot
        // always be declared as a dependency — `@dawn-ai/testing` peer-depends
        // on `@dawn-ai/cli`, so the reverse edge would be a cycle — and `dist/`
        // is gitignored, so it can never be a cache input. An explicit
        // task-level edge is the only thing that both orders and hashes it.
        if (
          owner !== undefined &&
          repoRelative.startsWith(`${toRepoRelativePath(owner.directory)}/dist/`)
        ) {
          if (!task.dependencies.includes(`${owner.packageName}#build`)) {
            errors.push(
              `${packageName}#${taskName} reads ${repoRelative} but does not depend on ${owner.packageName}#build — add it to that task's dependsOn in turbo.json (${file})`,
            )
          }

          continue
        }

        const declared = statSync(absolute).isDirectory()
          ? [...task.inputs].some(
              (input) => input === repoRelative || input.startsWith(`${repoRelative}/`),
            )
          : task.inputs.has(repoRelative)

        if (!declared) {
          errors.push(
            `${packageName}#${taskName} reads ${repoRelative} but does not declare it as a cache input — add "$TURBO_ROOT$/${repoRelative}" to that task's inputs in turbo.json (${file})`,
          )
        }
      }
    }
  }
}

// A shared Biome config is read by every lint task and belongs to none of them.
for (const [taskId, task] of taskIndex) {
  if (!taskId.endsWith("#lint")) {
    continue
  }

  const lintScript = readJson(join(task.directory, "package.json")).scripts?.lint ?? ""
  const configPath = /--config-path[= ]([^\s]+)/.exec(lintScript)?.[1]

  if (configPath === undefined) {
    continue
  }

  const absolute = resolve(task.directory, configPath)

  if (absolute.startsWith(`${task.directory}${posix.sep}`) || !existsSync(absolute)) {
    continue
  }

  const repoRelative = toRepoRelativePath(absolute)

  if (!task.inputs.has(repoRelative)) {
    errors.push(
      `${taskId} lints with ${repoRelative} but does not declare it as a cache input — add "$TURBO_ROOT$/${repoRelative}" to the lint task's inputs in turbo.json`,
    )
  }
}

// One undeclared path is usually read from several files; report it once.
const uniqueErrors = [...new Set(errors)]

if (uniqueErrors.length > 0) {
  console.error("Build cache config check failed.")
  console.error("")

  for (const error of uniqueErrors) {
    console.error(`- ${error}`)
  }

  process.exit(1)
}

console.log(
  `Build cache config check passed (${checkedConfigs.length} emitting tsconfig file(s), ${taskIndex.size} task(s) across build/test/lint, ${scannedFileCount} scanned source file(s); generic dist/** and .dawn/build/** caches, the test->build edge, the CLI bundled-docs contract, and every cross-package read declared).`,
)
