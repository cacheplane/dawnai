import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const maxBuffer = 20 * 1024 * 1024

const defaultLaneDefinitions = new Map([
  [
    "generated",
    {
      id: "generated",
      name: "Generated verification",
      phaseName: "vitest",
      execute: (context) =>
        executeVitestLane(context, {
          configPath: "test/generated/vitest.config.ts",
          reportFileName: "vitest-report.json",
        }),
    },
  ],
  [
    "smoke",
    {
      id: "smoke",
      name: "Runtime smoke",
      phaseName: "vitest",
      execute: (context) =>
        executeVitestLane(context, {
          configPath: "test/smoke/vitest.config.ts",
          reportFileName: "vitest-report.json",
        }),
    },
  ],
  [
    "publish-smoke",
    {
      id: "publish-smoke",
      name: "Publish smoke",
      phaseName: "publish-smoke",
      execute: (context) =>
        executeCommandLane(context, {
          args: ["scripts/publish-smoke.mjs"],
          command: "node",
        }),
    },
  ],
])

main()

function main() {
  try {
    const options = parseArgs(process.argv.slice(2))

    if (options.selfTest) {
      process.exit(runSelfTest())
    }

    const runId = createRunId()
    const artifactRoot = options.artifactRoot ?? resolve(repoRoot, "artifacts", "testing", runId)
    const { exitCode, result } = runHarness({
      artifactRoot,
      laneDefinitions: defaultLaneDefinitions,
      requestedLanes: options.requestedLanes,
      runId,
    })

    const renderer = options.json ? renderJsonSummary : renderTextSummary
    process.stdout.write(`${renderer(result)}\n`)
    process.exit(exitCode)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exit(2)
  }
}

function parseArgs(argv) {
  const options = {
    artifactRoot: undefined,
    json: false,
    requestedLanes: [],
    selfTest: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === "--") {
      options.requestedLanes.push(...argv.slice(index + 1))
      break
    }

    if (arg === "--json") {
      options.json = true
      continue
    }

    if (arg === "--self-test") {
      options.selfTest = true
      continue
    }

    if (arg === "--artifact-root") {
      const value = argv[index + 1]

      if (!value) {
        throw new Error("Missing value for --artifact-root.")
      }

      options.artifactRoot = resolve(repoRoot, value)
      index += 1
      continue
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`)
    }

    options.requestedLanes.push(arg)
  }

  return options
}

function createRunId() {
  const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-")
  return `harness-${timestamp}-${process.pid}`
}

function runHarness(options) {
  const requestedLanes = dedupe(
    options.requestedLanes.length > 0
      ? options.requestedLanes
      : [...options.laneDefinitions.keys()],
  )
  const startedAt = new Date().toISOString()

  mkdirSync(options.artifactRoot, { recursive: true })

  const results = requestedLanes.map((laneId) =>
    runLane({
      artifactRoot: options.artifactRoot,
      laneDefinition: options.laneDefinitions.get(laneId),
      laneId,
    }),
  )
  const finishedAt = new Date().toISOString()
  const counts = countStatuses(results)
  const status = summarizeRunStatus(counts)
  const result = {
    artifactRoot: options.artifactRoot,
    counts,
    executedLanes: results.map((laneResult) => laneResult.lane),
    finishedAt,
    requestedLanes,
    results,
    runId: options.runId,
    startedAt,
    status,
  }
  const runResultPath = join(options.artifactRoot, "run-result.json")

  writeJsonFile(runResultPath, result)

  return {
    exitCode: exitCodeForStatus(status),
    result,
  }
}

function runLane(options) {
  const laneRoot = join(options.artifactRoot, options.laneId)
  const transcriptPath = join(laneRoot, "transcript.log")
  const laneResultPath = join(laneRoot, "lane-result.json")
  const startedAt = Date.now()

  mkdirSync(laneRoot, { recursive: true })

  if (!options.laneDefinition) {
    const laneResult = {
      artifacts: [laneResultPath],
      durationMs: Date.now() - startedAt,
      failureReason: `Unknown harness lane: ${options.laneId}`,
      lane: options.laneId,
      name: options.laneId,
      phases: [
        {
          durationMs: Date.now() - startedAt,
          name: "resolve",
          status: "errored",
        },
      ],
      status: "errored",
      transcriptPath,
    }

    writeFileSync(transcriptPath, `Unknown harness lane: ${options.laneId}\n`, "utf8")
    writeJsonFile(laneResultPath, laneResult)

    return laneResult
  }

  const execution = options.laneDefinition.execute({
    laneId: options.laneDefinition.id,
    laneName: options.laneDefinition.name,
    laneRoot,
  })
  const durationMs = Date.now() - startedAt
  const laneResult = {
    artifacts: dedupe([...execution.artifacts, laneResultPath]),
    durationMs,
    failureReason: execution.failureReason,
    lane: options.laneDefinition.id,
    name: options.laneDefinition.name,
    phases: [
      {
        durationMs,
        name: execution.phaseName ?? options.laneDefinition.phaseName ?? "command",
        status: execution.status,
      },
    ],
    status: execution.status,
    transcriptPath,
  }

  writeFileSync(transcriptPath, execution.transcript, "utf8")
  writeJsonFile(laneResultPath, laneResult)

  return laneResult
}

function executeVitestLane(context, options) {
  const reportPath = join(context.laneRoot, options.reportFileName)
  const result = runProcess({
    args: [
      "exec",
      "vitest",
      "--run",
      "--config",
      options.configPath,
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    command: "pnpm",
  })
  const report = readJsonFileIfPresent(reportPath)
  const artifacts = existsSync(reportPath) ? [reportPath] : []

  if (result.kind === "errored") {
    return {
      artifacts,
      failureReason: result.failureReason,
      phaseName: "vitest",
      status: "errored",
      transcript: result.transcript,
    }
  }

  if (report) {
    return {
      artifacts,
      failureReason: report.success ? null : formatVitestFailure(report),
      phaseName: "vitest",
      status: report.success ? "passed" : "failed",
      transcript: result.transcript,
    }
  }

  if (result.exitCode === 0) {
    return {
      artifacts,
      failureReason: null,
      phaseName: "vitest",
      status: "passed",
      transcript: result.transcript,
    }
  }

  return {
    artifacts,
    failureReason: `Vitest exited with code ${result.exitCode} without a JSON report.`,
    phaseName: "vitest",
    status: "errored",
    transcript: result.transcript,
  }
}

function executeCommandLane(context, options) {
  const result = runProcess(options)

  if (result.kind === "errored") {
    return {
      artifacts: [],
      failureReason: result.failureReason,
      phaseName: context.laneId,
      status: "errored",
      transcript: result.transcript,
    }
  }

  if (result.exitCode === 0) {
    return {
      artifacts: [],
      failureReason: null,
      phaseName: context.laneId,
      status: "passed",
      transcript: result.transcript,
    }
  }

  if (result.exitCode === 1) {
    return {
      artifacts: [],
      failureReason: `${context.laneName} exited with code 1.`,
      phaseName: context.laneId,
      status: "failed",
      transcript: result.transcript,
    }
  }

  return {
    artifacts: [],
    failureReason: `${context.laneName} exited with code ${result.exitCode}.`,
    phaseName: context.laneId,
    status: "errored",
    transcript: result.transcript,
  }
}

function runProcess(options) {
  const result = spawnSync(options.command, options.args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer,
    shell: process.platform === "win32",
  })
  const transcript = buildTranscript({
    args: options.args,
    command: options.command,
    stderr: result.stderr,
    stdout: result.stdout,
  })

  if (result.error) {
    return {
      failureReason: result.error.message,
      kind: "errored",
      transcript,
    }
  }

  if (result.signal) {
    return {
      failureReason: `Command terminated by signal ${result.signal}.`,
      kind: "errored",
      transcript,
    }
  }

  return {
    exitCode: result.status ?? 1,
    kind: "completed",
    transcript,
  }
}

function buildTranscript(options) {
  const sections = [`$ ${options.command} ${options.args.join(" ")}`]

  if (options.stdout) {
    sections.push("--- stdout ---", options.stdout.trimEnd())
  }

  if (options.stderr) {
    sections.push("--- stderr ---", options.stderr.trimEnd())
  }

  return `${sections.join("\n")}\n`
}

function renderJsonSummary(result) {
  return JSON.stringify(result, null, 2)
}

function renderTextSummary(result) {
  const lines = [
    `run: ${result.runId}`,
    `status: ${result.status}`,
    `started: ${result.startedAt}`,
    `finished: ${result.finishedAt}`,
    `requested lanes: ${result.requestedLanes.join(", ")}`,
    `executed lanes: ${result.executedLanes.join(", ")}`,
    `lane names: ${result.results.map((laneResult) => `${laneResult.lane}=${laneResult.name}`).join(", ")}`,
    `passed=${result.counts.passed} failed=${result.counts.failed} skipped=${result.counts.skipped} errored=${result.counts.errored}`,
    `artifact root: ${result.artifactRoot}`,
  ]

  for (const laneResult of result.results) {
    lines.push(
      `[${laneResult.lane}] ${laneResult.name}: ${laneResult.status} (${laneResult.durationMs}ms)`,
    )

    for (const phase of laneResult.phases) {
      lines.push(`phase ${phase.name}: ${phase.status} (${phase.durationMs}ms)`)
    }

    if (laneResult.failureReason) {
      lines.push(`failure: ${laneResult.failureReason}`)
    }

    lines.push(`transcript: ${laneResult.transcriptPath}`)

    if (laneResult.artifacts.length > 0) {
      lines.push(`artifacts: ${laneResult.artifacts.join(", ")}`)
    }
  }

  return lines.join("\n")
}

function countStatuses(results) {
  const counts = {
    errored: 0,
    failed: 0,
    passed: 0,
    skipped: 0,
  }

  for (const result of results) {
    counts[result.status] += 1
  }

  return counts
}

function summarizeRunStatus(counts) {
  if (counts.errored > 0) {
    return "errored"
  }

  if (counts.failed > 0) {
    return "failed"
  }

  if (counts.passed === 0 && counts.skipped > 0) {
    return "skipped"
  }

  return "passed"
}

function exitCodeForStatus(status) {
  if (status === "errored") {
    return 2
  }

  if (status === "failed") {
    return 1
  }

  return 0
}

function formatVitestFailure(report) {
  const failedSuites =
    typeof report.numFailedTestSuites === "number" ? report.numFailedTestSuites : 0
  const failedTests = typeof report.numFailedTests === "number" ? report.numFailedTests : 0

  if (failedTests > 0 || failedSuites > 0) {
    return `${failedTests} test(s) failed across ${failedSuites} suite(s).`
  }

  return "Vitest reported a failing lane."
}

function readJsonFileIfPresent(filePath) {
  if (!existsSync(filePath)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function writeJsonFile(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function dedupe(values) {
  return [...new Set(values)]
}

function runSelfTest() {
  const tempRoot = mkdtempSync(join(tmpdir(), "dawn-harness-report-"))

  try {
    const passRun = runHarness({
      artifactRoot: join(tempRoot, "pass"),
      laneDefinitions: new Map([
        [
          "pass",
          {
            id: "pass",
            name: "Passing lane",
            phaseName: "mock",
            execute: ({ laneRoot }) => {
              const artifactPath = join(laneRoot, "artifact.txt")
              writeFileSync(artifactPath, "ok\n", "utf8")

              return {
                artifacts: [artifactPath],
                failureReason: null,
                phaseName: "mock",
                status: "passed",
                transcript: "pass transcript\n",
              }
            },
          },
        ],
      ]),
      requestedLanes: ["pass"],
      runId: "self-test-pass",
    })

    assert.equal(passRun.exitCode, 0)
    assert.equal(passRun.result.status, "passed")
    assert.deepEqual(passRun.result.requestedLanes, ["pass"])
    assert.equal(passRun.result.results[0].name, "Passing lane")
    assert.equal(passRun.result.results[0].phases[0].name, "mock")
    assert.deepEqual(JSON.parse(renderJsonSummary(passRun.result)), passRun.result)
    const textSummary = renderTextSummary(passRun.result)
    assert.match(textSummary, /requested lanes: pass/u)
    assert.match(textSummary, /lane names: pass=Passing lane/u)
    assert.match(textSummary, /phase mock: passed/u)

    const failedRun = runHarness({
      artifactRoot: join(tempRoot, "failed"),
      laneDefinitions: new Map([
        [
          "fail",
          {
            id: "fail",
            name: "Failing lane",
            phaseName: "mock",
            execute: () => ({
              artifacts: [],
              failureReason: "assertion failed",
              phaseName: "mock",
              status: "failed",
              transcript: "fail transcript\n",
            }),
          },
        ],
      ]),
      requestedLanes: ["fail"],
      runId: "self-test-failed",
    })

    assert.equal(failedRun.exitCode, 1)
    assert.equal(failedRun.result.status, "failed")

    const erroredRun = runHarness({
      artifactRoot: join(tempRoot, "errored"),
      laneDefinitions: new Map([
        [
          "error",
          {
            id: "error",
            name: "Errored lane",
            phaseName: "mock",
            execute: () => ({
              artifacts: [],
              failureReason: "spawn failed",
              phaseName: "mock",
              status: "errored",
              transcript: "error transcript\n",
            }),
          },
        ],
      ]),
      requestedLanes: ["error"],
      runId: "self-test-errored",
    })

    assert.equal(erroredRun.exitCode, 2)
    assert.equal(erroredRun.result.status, "errored")

    process.stdout.write("harness-report self-test passed\n")
    return 0
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    process.stderr.write(`${message}\n`)
    return 2
  } finally {
    rmSync(tempRoot, { force: true, recursive: true })
  }
}
