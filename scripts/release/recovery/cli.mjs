#!/usr/bin/env node
import { appendFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { readBoundedRegularFile } from "../../lib/published-artifacts.mjs"
import { writeCanonicalFileNoClobber } from "../smoke-result.mjs"
import { recoveryDiagnosticContext, recoveryFailureDetail } from "./diagnostics.mjs"
import {
  boundedRecoveryPath,
  canonicalRequestBytes,
  parseRecoveryRequest,
  RECOVERY_COMMANDS,
} from "./requests.mjs"
import {
  createRecoveryRuntime,
  executeRecoveryCommand,
  writeRecoveryAuditArtifact,
} from "./runtime.mjs"
import { validateRecoveryNeeds } from "./workflow.mjs"

export function parseRecoveryArgs(argv) {
  if (!Array.isArray(argv) || !RECOVERY_COMMANDS.includes(argv[0]))
    throw new TypeError("Exact recovery subcommand required")
  const command = argv[0],
    result = { command }
  for (let i = 1; i < argv.length; i += 2) {
    const allowed = {
      "--request": "request",
      "--output": "output",
      ...(command === "smoke" ? { "--manifest": "manifest" } : {}),
      ...(command === "report" ? { "--needs": "needs" } : {}),
    }
    const key = Object.hasOwn(allowed, argv[i]) ? allowed[argv[i]] : null
    if (!key || Object.hasOwn(result, key) || typeof argv[i + 1] !== "string")
      throw new TypeError("Exact named recovery paths required")
    result[key] = boundedRecoveryPath(argv[i + 1])
  }
  if (
    !result.request ||
    !result.output ||
    result.request === result.output ||
    (command === "report" && !result.needs) ||
    (command === "smoke" && !result.manifest)
  )
    throw new TypeError("Recovery request, output, and report needs paths required")
  return result
}
export function recoveryCommandExitCode(command, result, needs = null) {
  if (
    !result ||
    result.outcome === "blocked" ||
    result.status === "blocked" ||
    result.errors?.length ||
    result.conclusion === "failure" ||
    result.receipt?.conclusion === "failure"
  )
    return 1
  if (command === "report") {
    if (!validateRecoveryNeeds(needs)) return 1
    return result.phase === "COMPLETE" &&
      result.outcome === "complete" &&
      result.terminal === true &&
      result.facts?.finalization &&
      result.facts?.publication?.immutable === true
      ? 0
      : 1
  }
  if (command === "inspect")
    return result.status === "unreserved" ||
      result.outcome === "recovery-required" ||
      result.outcome === "complete"
      ? 0
      : 1
  if (command === "audit") return result.conclusion === "success" ? 0 : 1
  if (command === "smoke") return result.receipt?.conclusion === "success" ? 0 : 1
  const after = {
    adopt: [
      "RECOVERY_ADOPTED",
      "VERIFICATION_COMPLETE",
      "AUDIT_PENDING",
      "AUDIT_VERIFIED",
      "PUBLICATION_READY",
      "COMPLETE",
    ],
    "reconcile-verification": [
      "VERIFICATION_COMPLETE",
      "AUDIT_PENDING",
      "AUDIT_VERIFIED",
      "PUBLICATION_READY",
      "COMPLETE",
    ],
    "dispatch-audit": ["AUDIT_PENDING", "AUDIT_VERIFIED", "PUBLICATION_READY", "COMPLETE"],
    "reconcile-audit": ["AUDIT_VERIFIED", "PUBLICATION_READY", "COMPLETE"],
    finalize: ["PUBLICATION_READY", "COMPLETE"],
    publish: ["COMPLETE"],
  }[command]
  return after?.includes(result.phase) ||
    (result.facts?.finalization &&
      ["adopt", "reconcile-verification", "dispatch-audit", "reconcile-audit"].includes(command))
    ? 0
    : 1
}
export async function emitRecoveryArtifactOutputs(
  environment,
  { artifactName, evidenceDirectory },
) {
  if (!environment.GITHUB_OUTPUT) return
  if (
    !/^recovery-v2-(?:lane-[a-z-]+|audit-result)-[1-9][0-9]*-[1-9][0-9]*-[1-9][0-9]*$/u.test(
      artifactName,
    )
  )
    throw new TypeError("Exact artifact name required")
  boundedRecoveryPath(evidenceDirectory)
  await appendFile(
    boundedRecoveryPath(environment.GITHUB_OUTPUT),
    `artifact_name=${artifactName}\nevidence_directory=${evidenceDirectory}\n`,
  )
}
function diagnosticResult(result, environment) {
  if (!result) return null
  if (result.kind === "recovery-inspection")
    return {
      ...result,
      errors: result.errors
        .slice(0, 8)
        .map((message) => recoveryFailureDetail({ message }, environment)),
    }
  if (result.kind === "recovery-audit-result" || result.receipt) return result
  return {
    phase: result.phase,
    outcome: result.outcome,
    terminal: result.terminal,
    displayDrift: result.displayDrift,
    finalization: result.facts?.finalization?.ref ?? null,
    publication: result.facts?.publication?.state ?? null,
    errors: (result.errors ?? [])
      .slice(0, 8)
      .map((message) => recoveryFailureDetail({ message }, environment)),
  }
}
export async function runRecoveryCli(
  argv,
  { root = process.cwd(), environment = process.env, createRuntime = createRecoveryRuntime } = {},
) {
  let args,
    request = null,
    result = null,
    needs = null,
    exitCode = 1,
    errors = [],
    boundary = "arguments"
  try {
    args = parseRecoveryArgs(argv)
    boundary = "request"
    request = parseRecoveryRequest(
      args.command,
      await readBoundedRegularFile(args.request, 16384, "Recovery request"),
    )
    if (args.needs) {
      try {
        const bytes = await readBoundedRegularFile(args.needs, 65536, "Workflow results")
        needs = JSON.parse(bytes.toString("utf8"))
        if (
          !canonicalRequestBytes(needs).equals(bytes) ||
          !needs ||
          Array.isArray(needs) ||
          typeof needs !== "object"
        )
          throw new TypeError("Canonical workflow results required")
      } catch (error) {
        needs = null
        errors = [`RECOVERY_NEEDS_FAILED: ${recoveryFailureDetail(error, environment)}`]
      }
    }
    boundary = "runtime"
    const runtime = await createRuntime({ root, environment, command: args.command, request })
    boundary = args.command
    result = await executeRecoveryCommand(args.command, request, runtime, {
      output: args.output,
      environment,
      manifest: args.manifest,
      emitArtifact: (artifact) => emitRecoveryArtifactOutputs(environment, artifact),
    })
    if (args.command === "audit")
      await emitRecoveryArtifactOutputs(
        environment,
        await writeRecoveryAuditArtifact(result, args.output),
      )
    exitCode = recoveryCommandExitCode(args.command, result, needs)
  } catch (error) {
    errors = [
      `RECOVERY_${boundary.toUpperCase().replaceAll("-", "_")}_FAILED: ${recoveryFailureDetail(error, environment)}`,
    ]
    if (
      !args &&
      Array.isArray(argv) &&
      argv.length <= 32 &&
      argv.filter((value) => value === "--output").length === 1
    ) {
      try {
        const output = boundedRecoveryPath(argv[argv.indexOf("--output") + 1])
        if (argv.filter((value) => value === output).length === 1)
          args = { command: RECOVERY_COMMANDS.includes(argv[0]) ? argv[0] : "invalid", output }
      } catch {
        /* An ambiguous or invalid destination cannot receive diagnostics. */
      }
    }
  }
  if (args?.output) {
    try {
      await writeCanonicalFileNoClobber(
        args.output,
        canonicalRequestBytes({
          schemaVersion: 2,
          kind: "recovery-command-diagnostic",
          command: args.command,
          context: recoveryDiagnosticContext(request, result),
          status: exitCode === 0 ? "success" : "blocked",
          result: diagnosticResult(result, environment),
          workflowResults: needs,
          errors,
        }),
        {},
        1024 * 1024,
      )
    } catch {
      exitCode = 1
      errors = ["RECOVERY_OUTPUT_UNAVAILABLE"]
    }
  }
  return { exitCode, errors }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runRecoveryCli(process.argv.slice(2))
  if (result.exitCode)
    process.stderr.write(
      `${result.errors[0] ?? "Recovery remains blocked or incomplete; inspect the diagnostic output"}\n`,
    )
  process.exitCode = result.exitCode
}
