import { mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { type Command, CommanderError } from "commander"
import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import { EvalLoadError, type LoadedEval, loadEvals } from "../lib/runtime/load-evals.js"

interface EvalOptions {
  readonly cwd?: string
  readonly live?: boolean
  readonly json?: string | boolean
}

/**
 * Structural shapes for the dynamically imported `@dawn-ai/testing` and
 * `@dawn-ai/evals` packages. Declared locally (rather than `typeof import(...)`)
 * because the CLI must NOT statically depend on either package: `@dawn-ai/testing`
 * peer-depends on `@dawn-ai/cli`, so a build-time module reference would create a
 * dependency cycle. The packages are resolved from the *app* at runtime via
 * `importFromApp`, so the genuine implementations are exercised; these types only
 * describe the slice the command consumes.
 */
interface AgentRunResultShape {
  readonly finalMessage: string
}

interface AgentHarnessShape {
  run(opts: { input: string; fixtures?: unknown }): Promise<AgentRunResultShape>
  reset(): void
  close(): Promise<void>
}

interface TestingModule {
  createAgentHarness(opts: {
    appRoot: string
    route: string
    live?: boolean
  }): Promise<AgentHarnessShape>
}

interface EvalCaseShape {
  readonly input: unknown
  readonly fixtures?: unknown
}

interface CaseScoreShape {
  readonly scorer: string
  readonly score: number
}

interface CaseResultShape {
  readonly name: string
  readonly scores: readonly CaseScoreShape[]
  readonly mean: number
  readonly passed: boolean
}

interface EvalReportShape {
  readonly name: string
  readonly cases: readonly CaseResultShape[]
  readonly mean: number
  readonly gated: boolean
  readonly passed: boolean
  readonly reason?: string
}

interface EvalsModule {
  runEval(
    definition: unknown,
    options: {
      baseDir?: string
      runCase: (testCase: EvalCaseShape) => Promise<AgentRunResultShape>
    },
  ): Promise<EvalReportShape>
}

export function registerEvalCommand(program: Command, io: CommandIo): void {
  program
    .command("eval [path]")
    .description("Run Dawn agent evals over their datasets")
    .option("--cwd <path>", "Path to the Dawn app root or a child directory within it")
    .option("--live", "Run against the real model (requires OPENAI_API_KEY); never use in CI")
    .option("--json [file]", "Write a JSON report (default .dawn/eval-report.json)")
    .action(async (path: string | undefined, options: EvalOptions) => {
      await runEvalCommand(path, options, io)
    })
}

export async function runEvalCommand(
  narrowingPath: string | undefined,
  options: EvalOptions,
  io: CommandIo,
): Promise<void> {
  let evals: LoadedEval[]
  try {
    evals = await loadEvals({
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(narrowingPath ? { narrowingPath } : {}),
    })
  } catch (error) {
    if (error instanceof EvalLoadError) throw new CliError(`Eval-load failure: ${error.message}`, 2)
    throw new CliError(`Eval-load failure: ${formatErrorMessage(error)}`, 2)
  }
  if (evals.length === 0) throw new CliError("No *.eval.ts files found", 1)

  const appRoot = evals[0]!.appRoot
  const { createAgentHarness } = await importFromApp<TestingModule>(appRoot, "@dawn-ai/testing")
  const { runEval } = await importFromApp<EvalsModule>(appRoot, "@dawn-ai/evals")

  const reports = []
  let anyFailed = false

  for (const loaded of evals) {
    const harness = await createAgentHarness({
      appRoot: loaded.appRoot,
      route: loaded.route,
      ...(options.live ? { live: true } : {}),
    })
    try {
      const report = await runEval(loaded.definition, {
        baseDir: loaded.baseDir,
        runCase: async (testCase) => {
          harness.reset()
          const input =
            typeof testCase.input === "string" ? testCase.input : JSON.stringify(testCase.input)
          return harness.run({
            input,
            ...(!options.live && testCase.fixtures ? { fixtures: testCase.fixtures } : {}),
          })
        },
      })
      reports.push(report)
      printReport(report, io)
      if (report.gated && !report.passed) anyFailed = true
    } finally {
      await harness.close()
    }
  }

  if (options.json !== undefined) {
    const target =
      typeof options.json === "string" ? options.json : join(appRoot, ".dawn", "eval-report.json")
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(reports, null, 2)}\n`, "utf8")
    writeLine(io.stdout, `Wrote report: ${target}`)
  }

  if (anyFailed) throw new CommanderError(1, "dawn.eval.failed", "")
}

function printReport(report: EvalReportShape, io: CommandIo): void {
  for (const c of report.cases) {
    const detail = c.scores.map((s) => `${s.scorer}=${s.score.toFixed(2)}`).join(" ")
    writeLine(
      io.stdout,
      `${c.passed ? "PASS" : "FAIL"} ${report.name} › ${c.name} mean=${c.mean.toFixed(2)} [${detail}]`,
    )
  }
  const verdict = !report.gated ? "INFO" : report.passed ? "PASS" : "FAIL"
  writeLine(
    io.stdout,
    `${verdict} ${report.name} mean=${report.mean.toFixed(2)}${report.reason ? ` (${report.reason})` : ""}`,
  )
}

async function importFromApp<T>(appRoot: string, specifier: string): Promise<T> {
  const require = createRequire(`${appRoot}/package.json`)
  let resolved: string
  try {
    resolved = require.resolve(specifier)
  } catch {
    throw new CliError(
      `dawn eval requires "${specifier}" — add it as a devDependency in your app`,
      2,
    )
  }
  return (await import(pathToFileURL(resolved).href)) as T
}
