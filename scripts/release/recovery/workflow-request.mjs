#!/usr/bin/env node
// Converts workflow strings and immutable git intent into strict request files.
import { appendFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createGitReader } from "../adapters/git.mjs"
import { writeCanonicalFileNoClobber } from "../smoke-result.mjs"
import { captureRecoveryEligibility } from "./authority.mjs"
import { recoveryFailureDetail } from "./diagnostics.mjs"
import {
  boundedRecoveryPath,
  canonicalRequestBytes,
  parseRecoveryRequest,
  RECOVERY_COMMANDS,
} from "./requests.mjs"
import {
  createRecoveryRuntime,
  observeRecoveryRequest,
  readRecoveryApi,
  resolveRecoveryAuditRequest,
} from "./runtime.mjs"
import { canonicalRecoveryBytes, parseRecovery } from "./schema.mjs"
import { planRecoveryWorkflow, RECOVERY_WORKFLOW_NEEDS } from "./workflow.mjs"

export async function prepareRecoveryWorkflowRequest(
  command,
  output,
  environment = process.env,
  root = process.cwd(),
) {
  boundedRecoveryPath(output)
  if (![...RECOVERY_COMMANDS, "admit"].includes(command))
    throw new TypeError("Exact preparation command required")
  const expectedControllerSha = environment.INPUT_EXPECTED_CONTROLLER_SHA
  if (
    environment.GITHUB_REF !== "refs/heads/main" ||
    !/^[a-f0-9]{40}$/u.test(expectedControllerSha) ||
    expectedControllerSha !== environment.GITHUB_SHA
  )
    throw new TypeError("Recovery requires exact current main controller SHA")
  let request, runtime
  if (command === "audit") {
    runtime = createRecoveryRuntime({ root, environment, command })
    request = await resolveRecoveryAuditRequest(
      {
        request_id: environment.INPUT_REQUEST_ID,
        intent_sha256: environment.INPUT_INTENT_SHA256,
        expected_controller_sha: expectedControllerSha,
        release_id: environment.INPUT_RELEASE_ID,
      },
      runtime,
      environment.GITHUB_SHA,
    )
  } else {
    const intentPath = environment.INPUT_INTENT_PATH
    if (
      !/^scripts\/release\/recovery-adoptions\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(intentPath)
    )
      throw new TypeError("Exact committed intent path required")
    const git = createGitReader({ root }),
      raw = Buffer.from(await git.showFile({ ref: expectedControllerSha, path: intentPath }))
    const intent = parseRecovery(raw, { kind: "recovery-adoption-intent" })
    if (!canonicalRecoveryBytes(intent).equals(raw))
      throw new TypeError("Canonical committed intent required")
    request = {
      candidate: intent.candidate,
      expectedControllerSha,
      intentPath,
      ...(["dispatch-audit", "reconcile-audit"].includes(command)
        ? { requestId: `owner-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}` }
        : {}),
      ...(command === "smoke" ? { lane: environment.RECOVERY_LANE } : {}),
    }
    runtime = createRecoveryRuntime({ root, environment, command, request })
  }
  parseRecoveryRequest(command === "admit" ? "adopt" : command, canonicalRequestBytes(request))
  await writeCanonicalFileNoClobber(output, canonicalRequestBytes(request))
  if (command === "report") {
    const needs = JSON.parse(environment.RECOVERY_NEEDS)
    if (
      Object.keys(needs).sort().join(" ") !== Object.keys(RECOVERY_WORKFLOW_NEEDS).sort().join(" ")
    )
      throw new TypeError("Exact owner workflow results required")
    const results = Object.fromEntries(
      Object.entries(needs).map(([job, value]) => [job, { result: value.result }]),
    )
    await writeCanonicalFileNoClobber(
      path.join(path.dirname(output), "needs.json"),
      canonicalRequestBytes(results),
    )
  }
  if (command !== "admit") return request
  const proof = await captureRecoveryEligibility(
    { candidate: request.candidate, expectedControllerSha },
    runtime.authority,
  )
  const observed = await observeRecoveryRequest(request, runtime),
    plan = planRecoveryWorkflow(observed)
  if (plan.smoke) {
    const ref = observed.facts.baseAssets.find((r) => r.assetName === "manifest.json")
    const encoded = await readRecoveryApi(runtime, "downloadReleaseAsset", {
      assetId: ref.id,
      maximumBytes: ref.size,
    })
    // The receiving parent independently re-hashes and parses these transferred bytes.
    await writeCanonicalFileNoClobber(
      path.join(path.dirname(output), "bootstrap", "manifest.json"),
      Buffer.from(encoded, "base64"),
      {},
      1024 * 1024,
    )
  }
  await appendFile(
    boundedRecoveryPath(environment.GITHUB_OUTPUT),
    `${Object.entries(plan)
      .map(([key, value]) => `${key}=${value}\n`)
      .join("")}job_id=${proof.executor.jobId}\n`,
  )
  return request
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let command,
    output,
    failure = null
  try {
    if (
      process.argv.length !== 6 ||
      process.argv[2] !== "--command" ||
      process.argv[4] !== "--output"
    )
      throw new TypeError("Exact workflow preparation arguments required")
    command = process.argv[3]
    output = boundedRecoveryPath(process.argv[5])
    await prepareRecoveryWorkflowRequest(command, output)
  } catch (error) {
    failure = recoveryFailureDetail(error, process.env)
    process.stderr.write(`Recovery request preparation blocked: ${failure}\n`)
    process.exitCode = 1
  }
  if (command === "admit" && output) {
    try {
      await writeCanonicalFileNoClobber(
        path.join(path.dirname(output), "result.json"),
        canonicalRequestBytes({
          schemaVersion: 2,
          kind: "recovery-admission-diagnostic",
          status: failure ? "blocked" : "admitted",
          errors: failure ? [failure] : [],
        }),
      )
    } catch {
      process.stderr.write("Recovery admission diagnostic unavailable\n")
      process.exitCode = 1
    }
  }
}
