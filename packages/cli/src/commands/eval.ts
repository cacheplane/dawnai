import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { siblingFixturePath } from "../lib/runtime/eval-fixture-path.js"
import { type Command, CommanderError } from "commander"
import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import { EvalLoadError, type LoadedEval, loadEvals } from "../lib/runtime/load-evals.js"

interface EvalOptions {
  readonly cwd?: string
  readonly live?: boolean
  readonly record?: boolean
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
  getRecordedFixtures(): unknown[]
  reset(): void
  close(): Promise<void>
}

interface TestingModule {
  createAgentHarness(opts: {
    appRoot: string
    route: string
    live?: boolean
    record?: boolean
    recordUpstream?: string
  }): Promise<AgentHarnessShape>
  loadFixtures(path: string): unknown
  writeFixtures(path: string, fixtures: unknown): void
}

interface EvalCaseShape {
  readonly name?: string
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
    .option("--record", "Record fixtures from the real model into sibling files (requires OPENAI_API_KEY); never use in CI")
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

  if (options.record && options.live) {
    throw new CliError("Choose one of --record or --live, not both", 2)
  }
  if (options.record && !process.env.OPENAI_API_KEY) {
    throw new CliError("dawn eval --record requires OPENAI_API_KEY (records against the real model)", 2)
  }

  const appRoot = evals[0]!.appRoot
  const { createAgentHarness, loadFixtures, writeFixtures } = await importFromApp<TestingModule>(appRoot, "@dawn-ai/testing")
  const { runEval } = await importFromApp<EvalsModule>(appRoot, "@dawn-ai/evals")

  const reports = []
  let anyFailed = false

  for (const loaded of evals) {
    const harness = await createAgentHarness({
      appRoot: loaded.appRoot,
      route: loaded.route,
      ...(options.live ? { live: true } : {}),
      ...(options.record ? { record: true } : {}),
      ...(options.record && process.env.DAWN_RECORD_UPSTREAM
        ? { recordUpstream: process.env.DAWN_RECORD_UPSTREAM }
        : {}),
    })
    try {
      let caseIndex = -1
      const report = await runEval(loaded.definition, {
        baseDir: loaded.baseDir,
        runCase: async (testCase) => {
          caseIndex += 1
          harness.reset()
          const input =
            typeof testCase.input === "string" ? testCase.input : JSON.stringify(testCase.input)

          if (!options.live && !options.record) {
            // Replay: inline fixtures win; otherwise auto-load the recorded sibling file.
            let fixtures: unknown = testCase.fixtures
            if (!fixtures) {
              const sibling = siblingFixturePath(loaded.evalFile, loaded.baseDir, testCase.name, caseIndex)
              if (existsSync(sibling)) fixtures = loadFixtures(sibling)
            }
            if (!fixtures) {
              throw new CliError(
                `Eval "${loaded.definition.name}" case "${testCase.name ?? "?"}" has no fixtures — add script()/fixtures, record with --record, or run with --live`,
                2,
              )
            }
            return harness.run({ input, fixtures })
          }

          if (options.record) {
            const label = `${loaded.definition.name} › ${testCase.name ?? `case ${caseIndex + 1}`}`
            if (testCase.fixtures) {
              writeLine(io.stdout, `· ${label}: skipped record (inline fixtures)`)
              return harness.run({ input, fixtures: testCase.fixtures })
            }
            const result = await harness.run({ input })
            const recorded = harness.getRecordedFixtures()
            if (recorded.length === 0) {
              writeLine(io.stdout, `· ${label}: recorded 0 calls — skipped write`)
              return result
            }
            const sibling = siblingFixturePath(loaded.evalFile, loaded.baseDir, testCase.name, caseIndex)
            try {
              writeFixtures(sibling, recorded)
            } catch (err) {
              throw new CliError(`Failed to write fixtures ${sibling}: ${formatErrorMessage(err)}`, 2)
            }
            writeLine(io.stdout, `· recorded ${recorded.length} fixtures → ${sibling}`)
            return result
          }

          // Live: real model, no fixtures.
          return harness.run({ input })
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
