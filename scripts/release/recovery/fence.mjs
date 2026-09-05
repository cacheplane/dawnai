// GET-only legacy exclusion proof. Production disable/enable remains an activation operation.

import {
  FENCE_API_VERSION,
  FENCE_FIXTURES,
  fenceCanonical,
  fenceDigest,
  fenceExact,
  fenceParse,
  fenceRequire,
  fenceSame,
  fenceTerminalRuns,
  validateRecoveryFenceEvidence,
} from "./fence-evidence.mjs"
import {
  recoveryId,
  recoveryReadBudget,
  recoverySleep,
  runRecoveryAdapterRead,
} from "./invocation.mjs"
import {
  canonicalPolicyBytes,
  parseRecoveryPolicy,
  RECOVERY_POLICY_PATH,
  recoveryMethods,
} from "./policy.mjs"
import { parseRecovery, snapshotRecoveryData } from "./schema.mjs"

const CONTRACT_ROOT = "scripts/release/recovery-fence-contracts"
const EVIDENCE_ROOT = "scripts/release/recovery-fence-evidence"
const OWNER = ".github/workflows/release-postpublication.yml"
const AUDIT = ".github/workflows/release-postpublication-audit.yml"
const REQUIRED_WRITERS = [
  ".github/workflows/published-artifact-verify.yml",
  ".github/workflows/release.yml",
]
// Finite version-one graph: service probe plus witness projector and every local import.
// Task12 must update this reviewed list atomically if its source graph grows.
export const RECOVERY_FENCE_PROBE_INPUTS = Object.freeze([
  "scripts/release/adapter-normalize.mjs",
  "scripts/release/adapters/github.mjs",
  "scripts/release/adapters/http.mjs",
  "scripts/release/adapters/npm.mjs",
  "scripts/release/limits.mjs",
  "scripts/release/recovery/fence-evidence.mjs",
  "scripts/release/recovery/invocation.mjs",
  "scripts/release/recovery/policy.mjs",
  "scripts/release/recovery/schema.mjs",
  "scripts/release/semver.mjs",
  "scripts/release/test/recovery-github.integration.mjs",
  "scripts/release/test/support/recovery-github-fence.mjs",
  "scripts/release/test/support/recovery-github-probe.mjs",
])
const PROBE_PATHS = new Set(RECOVERY_FENCE_PROBE_INPUTS)
const SHA = /^[a-f0-9]{40}$/u,
  HASH = /^[a-f0-9]{64}$/u
function path(value) {
  fenceRequire(
    typeof value === "string" &&
      value.length <= 512 &&
      /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value) &&
      !value.split("/").some((part) => part === "." || part === ".."),
    "safe manifest path required",
  )
  fenceRequire(
    value !== RECOVERY_POLICY_PATH &&
      !value.startsWith(`${CONTRACT_ROOT}/`) &&
      !value.startsWith(`${EVIDENCE_ROOT}/`) &&
      !value.startsWith("scripts/release/recovery-adoptions/") &&
      value !== "scripts/release/test/fixtures/release-script-hashes.json",
    "cyclic authority/pin manifest input forbidden",
  )
}
function manifest(entries, { probe = false } = {}) {
  fenceRequire(
    Array.isArray(entries) && entries.length <= 512 && (!probe || entries.length > 0),
    "bounded explicit manifest required",
  )
  let previous = ""
  for (const entry of entries) {
    fenceExact(entry, "path sha256")
    path(entry.path)
    fenceRequire(
      HASH.test(entry.sha256) && entry.path > previous && (!probe || PROBE_PATHS.has(entry.path)),
      "sorted unique supported manifest required",
    )
    previous = entry.path
  }
}
export function parseRecoveryFenceContract(raw) {
  const c = fenceParse(raw, 128 * 1024)
  fenceExact(
    c,
    "schemaVersion kind repository repositoryId candidateSourceSha mechanism apiVersion evidenceSha256 probeClosure fixtures topology",
  )
  fenceRequire(
    c.schemaVersion === 1 &&
      c.kind === "recovery-legacy-fence-contract" &&
      c.mechanism === "github-workflow-disable-v1" &&
      c.apiVersion === FENCE_API_VERSION,
    "supported reviewed fence contract required",
  )
  fenceRequire(
    typeof c.repository === "string" &&
      /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(c.repository) &&
      typeof c.repositoryId === "string" &&
      recoveryId(c.repositoryId) === c.repositoryId &&
      SHA.test(c.candidateSourceSha) &&
      HASH.test(c.evidenceSha256),
    "contract candidate identity required",
  )
  manifest(c.probeClosure, { probe: true })
  fenceSame(
    c.probeClosure.map((input) => input.path),
    RECOVERY_FENCE_PROBE_INPUTS,
    "complete supported probe/projector closure required",
  )
  fenceRequire(
    Array.isArray(c.fixtures) && c.fixtures.length === 2,
    "two reviewed fixture revisions required",
  )
  for (const [index, revision] of ["current", "historical"].entries()) {
    const fixture = c.fixtures[index]
    fenceExact(fixture, "revision path sha256")
    fenceRequire(
      fixture.revision === revision &&
        fixture.path === FENCE_FIXTURES[revision].path &&
        fixture.sha256 === FENCE_FIXTURES[revision].sha256,
      "fixed fixture contract required",
    )
  }
  fenceRequire(
    Array.isArray(c.topology) && c.topology.length >= 4 && c.topology.length <= 64,
    "complete bounded workflow topology required",
  )
  const ids = new Set()
  let previous = ""
  for (const entry of c.topology) {
    fenceExact(entry, "workflowId workflow disposition sources")
    fenceRequire(
      typeof entry.workflowId === "string" &&
        recoveryId(entry.workflowId) === entry.workflowId &&
        !ids.has(entry.workflowId),
      "unique canonical workflow ID required",
    )
    ids.add(entry.workflowId)
    fenceRequire(
      typeof entry.workflow === "string" &&
        /^\.github\/workflows\/[a-z0-9][a-z0-9_-]*\.ya?ml$/u.test(entry.workflow) &&
        entry.workflow > previous,
      "sorted unique workflow paths required",
    )
    previous = entry.workflow
    fenceRequire(
      ["fenced-legacy", "nonwriter", "recovery-owner", "recovery-audit"].includes(
        entry.disposition,
      ) &&
        Array.isArray(entry.sources) &&
        entry.sources.length <= 64,
      "finite reviewed disposition/sources required",
    )
    if (["recovery-owner", "recovery-audit"].includes(entry.disposition)) {
      fenceRequire(
        entry.sources.length === 0 &&
          entry.workflow === (entry.disposition === "recovery-owner" ? OWNER : AUDIT),
        "separately admitted recovery identity required",
      )
      continue
    }
    fenceRequire(
      entry.workflow !== OWNER && entry.workflow !== AUDIT && entry.sources.length > 0,
      "reviewed source bindings required",
    )
    let last = ""
    let current = false
    let candidate = false
    for (const source of entry.sources) {
      fenceExact(source, "source workflowSha256 executionInputs")
      fenceRequire(
        source.source && ["commit", "current-default"].includes(source.source.kind),
        "supported source selector required",
      )
      const key =
        source.source.kind === "commit" ? `commit:${source.source.sha}` : "current-default"
      fenceExact(source.source, source.source.kind === "commit" ? "kind sha" : "kind")
      if (source.source.kind === "commit") {
        fenceRequire(SHA.test(source.source.sha), "existing commit source required")
        candidate ||= source.source.sha === c.candidateSourceSha
      } else current = true
      fenceRequire(
        key > last && HASH.test(source.workflowSha256),
        "sorted unique source bindings required",
      )
      last = key
      manifest(source.executionInputs)
      fenceRequire(
        source.executionInputs.every((input) => input.path !== entry.workflow),
        "workflow bytes have one binding",
      )
    }
    fenceRequire(
      entry.disposition !== "nonwriter" || current,
      "nonwriter requires current-default source binding",
    )
    fenceRequire(
      entry.disposition !== "fenced-legacy" || candidate,
      "fenced workflow requires candidate source binding",
    )
  }
  for (const workflow of REQUIRED_WRITERS)
    fenceRequire(
      c.topology.some(
        (entry) => entry.workflow === workflow && entry.disposition === "fenced-legacy",
      ),
      "mandatory legacy subsystem fencing required",
    )
  for (const [workflow, disposition] of [
    [OWNER, "recovery-owner"],
    [AUDIT, "recovery-audit"],
  ])
    fenceRequire(
      c.topology.some((entry) => entry.workflow === workflow && entry.disposition === disposition),
      "recovery topology identity required",
    )
  return c
}
export function createRecoveryFenceReader({ github, git, now = Date.now, sleep = recoverySleep }) {
  const reads = recoveryMethods(github, [
    "getRepository",
    "getRef",
    "listRepositoryWorkflowsComplete",
    "getWorkflowById",
    "listWorkflowRunsAllShasComplete",
  ])
  const source = recoveryMethods(git, ["showFile"])
  return {
    async observeLegacyFence(request, options = {}) {
      const budget = recoveryReadBudget(
        { ...options, timeoutMs: Math.min(options.timeoutMs ?? 30000, 30000) },
        now,
      )
      request = snapshotRecoveryData(request, 16384)
      fenceExact(request, "candidate executor policySha256")
      const { candidate, executor, policySha256 } = request
      parseRecovery({
        schemaVersion: 2,
        kind: "recovery-adoption-intent",
        candidate,
        policySha256,
        legacyBodySha256: "0".repeat(64),
        legacyPhase: "NPM_COMPLETE",
        operations: ["adopt"],
      })
      fenceExact(executor, "controllerSha verifierClosureSha256 workflow runId runAttempt jobId")
      fenceRequire(
        SHA.test(executor.controllerSha) &&
          HASH.test(executor.verifierClosureSha256) &&
          executor.workflow === OWNER,
        "trusted owner executor required",
      )
      for (const key of ["runId", "runAttempt", "jobId"])
        fenceRequire(
          typeof executor[key] === "string" && recoveryId(executor[key]) === executor[key],
          "canonical executor identity required",
        )
      let sourceBytes = 0
      const show = async (ref, path, maximumBytes = 2 * 1024 * 1024) => {
        const raw = await source.showFile({ ref, path }, budget.options())
        budget.options()
        fenceRequire(
          typeof raw === "string" && raw.isWellFormed() && Buffer.byteLength(raw) <= maximumBytes,
          "bounded exact git bytes required",
        )
        sourceBytes += Buffer.byteLength(raw)
        fenceRequire(sourceBytes <= 16 * 1024 * 1024, "total git byte bound")
        return raw
      }
      const read = async (name, args = {}) => {
        const result = await runRecoveryAdapterRead(
          budget,
          (options) => reads[name](args, options),
          { now, sleep },
        )
        budget.options()
        fenceRequire(result.status === "PRESENT", "fresh GitHub read unavailable")
        return snapshotRecoveryData(result.value, 8 * 1024 * 1024)
      }
      const policy = parseRecoveryPolicy(
        await show(executor.controllerSha, RECOVERY_POLICY_PATH, 128 * 1024),
      )
      fenceRequire(
        policy.status === "ADMITTED" && fenceDigest(canonicalPolicyBytes(policy)) === policySha256,
        "expected-controller policy binding required",
      )
      const matches = []
      for (const digest of policy.fence.contracts) {
        const raw = await show(
          executor.controllerSha,
          `${CONTRACT_ROOT}/${digest}.json`,
          128 * 1024,
        )
        fenceRequire(fenceDigest(raw) === digest, "contract locator digest mismatch")
        const contract = parseRecoveryFenceContract(raw)
        if (
          contract.repository === candidate.repository &&
          contract.repositoryId === candidate.repositoryId &&
          contract.candidateSourceSha === candidate.candidateSha
        )
          matches.push({ contract, contractSha256: digest })
      }
      fenceRequire(matches.length === 1, "exactly one approved candidate fence contract required")
      const { contract, contractSha256 } = matches[0]
      const verifyInputs = async (ref, entries) => {
        for (const entry of entries)
          fenceRequire(
            fenceDigest(await show(ref, entry.path)) === entry.sha256,
            "reviewed input bytes changed",
          )
        return fenceDigest(canonicalPolicyBytes(entries))
      }
      const probeClosureSha256 = await verifyInputs(executor.controllerSha, contract.probeClosure)
      const fixtureBytes = {}
      for (const fixture of contract.fixtures) {
        const raw = await show(executor.controllerSha, fixture.path)
        fenceRequire(fenceDigest(raw) === fixture.sha256, "reviewed fixture bytes changed")
        fixtureBytes[fixture.revision] = raw
      }
      const evidence = await show(
        executor.controllerSha,
        `${EVIDENCE_ROOT}/${contract.evidenceSha256}.json`,
        8 * 1024 * 1024,
      )
      fenceRequire(
        fenceDigest(evidence) === contract.evidenceSha256,
        "evidence locator digest mismatch",
      )
      validateRecoveryFenceEvidence(evidence, { fixtureBytes, probeClosureSha256 })
      const repository = async () => {
        const value = await read("getRepository")
        fenceRequire(
          value.full_name === candidate.repository &&
            recoveryId(value.id) === candidate.repositoryId &&
            value.default_branch === "main",
          "fresh production repository/default branch mismatch",
        )
        const ref = await read("getRef", { ref: "heads/main" })
        fenceRequire(
          ref.ref === "refs/heads/main" &&
            ref.object?.type === "commit" &&
            SHA.test(ref.object.sha),
          "fresh default branch SHA required",
        )
        return {
          repository: value.full_name,
          repositoryId: recoveryId(value.id),
          defaultBranch: value.default_branch,
          sha: ref.object.sha,
        }
      }
      const topology = async () => {
        const workflows = await read("listRepositoryWorkflowsComplete")
        fenceRequire(
          Array.isArray(workflows) && workflows.length === contract.topology.length,
          "exhaustive workflow mapping required",
        )
        const values = workflows
          .map((w) => ({ workflowId: recoveryId(w.id), workflow: w.path, state: w.state }))
          .sort((a, b) => (a.workflow < b.workflow ? -1 : a.workflow > b.workflow ? 1 : 0))
        fenceSame(
          values.map(({ workflowId, workflow }) => ({ workflowId, workflow })),
          contract.topology.map(({ workflowId, workflow }) => ({ workflowId, workflow })),
          "unknown or renamed workflow identity",
        )
        return values
      }
      const initialRepository = await repository(),
        initialTopology = await topology()
      const writers = []
      for (const entry of contract.topology) {
        const bindings = []
        for (const source of entry.sources) {
          const ref =
            source.source.kind === "current-default" ? initialRepository.sha : source.source.sha
          fenceRequire(
            ref !== executor.controllerSha || source.source.kind === "current-default",
            "contract-owning commit self-binding forbidden",
          )
          fenceRequire(
            fenceDigest(await show(ref, entry.workflow)) === source.workflowSha256,
            "workflow source bytes changed",
          )
          const executionClosureSha256 = await verifyInputs(ref, source.executionInputs)
          bindings.push({ sourceSha: ref, executionClosureSha256 })
        }
        if (entry.disposition !== "fenced-legacy") continue
        const state = async () => {
          const value = await read("getWorkflowById", { workflowId: entry.workflowId })
          fenceRequire(
            recoveryId(value.id) === entry.workflowId &&
              value.path === entry.workflow &&
              value.state === "disabled_manually",
            "legacy mutation authority not revoked",
          )
          return { workflowId: entry.workflowId, workflow: entry.workflow, state: value.state }
        }
        const runs = async () =>
          fenceTerminalRuns(
            await read("listWorkflowRunsAllShasComplete", { workflowId: entry.workflowId }),
            { ...candidate, workflowId: entry.workflowId, workflow: entry.workflow },
          )
        const beforeState = await state(),
          beforeRuns = await runs(),
          afterState = await state(),
          afterRuns = await runs()
        fenceSame(beforeState, afterState, "workflow revocation changed")
        fenceSame(beforeRuns, afterRuns, "all-SHA drainage changed")
        for (const binding of bindings)
          writers.push({
            workflow: entry.workflow,
            sourceSha: binding.sourceSha,
            protection: "mutation-authority-revoked",
            proofSha256: fenceDigest(
              fenceCanonical({
                contractSha256,
                evidenceSha256: contract.evidenceSha256,
                binding,
                state: afterState,
                runs: afterRuns,
              }),
            ),
            activeRuns: [],
          })
      }
      const finalTopology = await topology(),
        finalRepository = await repository()
      fenceSame(initialTopology, finalTopology, "workflow topology changed during observation")
      fenceSame(
        initialRepository,
        finalRepository,
        "default branch/repository changed during observation",
      )
      budget.options()
      // Collapse identical current/default commit selectors, preserving one proof per source.
      const unique = [
        ...new Map(writers.map((w) => [`${w.workflow}:${w.sourceSha}`, w])).values(),
      ].sort((a, b) =>
        a.workflow < b.workflow
          ? -1
          : a.workflow > b.workflow
            ? 1
            : a.sourceSha < b.sourceSha
              ? -1
              : a.sourceSha > b.sourceSha
                ? 1
                : 0,
      )
      fenceRequire(unique.length > 0 && unique.length <= 64, "bounded legacy writer proof required")
      return {
        contractSha256,
        candidate,
        executor,
        observedAt: budget.started,
        expiresAt: budget.started + 30000,
        concurrencyGroup: policy.fence.concurrencyGroup,
        cancelInProgress: false,
        writers: unique,
        inventoryComplete: true,
      }
    },
  }
}
