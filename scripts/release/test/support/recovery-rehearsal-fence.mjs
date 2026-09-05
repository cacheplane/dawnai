// Synthetic admission and service witness for the HTTP model. The actual fence
// parser, source binding, topology checks and all-SHA reads remain executable.
import { RECOVERY_FENCE_PROBE_INPUTS } from "../../recovery/fence.mjs"
import {
  canonical,
  currentFixturePath,
  digest,
  fenceEvidenceFixture,
  historicalFixturePath,
} from "./recovery-fence-fixture.mjs"

export async function configureRehearsalFence({ candidate, executor, policy, source }) {
  const f = await fenceEvidenceFixture()
  const files = new Map()
  const put = (ref, path, bytes) => files.set(`${ref}:${path}`, String(bytes))
  const probeClosure = RECOVERY_FENCE_PROBE_INPUTS.map((path) => ({ path, sha256: digest(source) }))
  f.evidence.probeClosureSha256 = digest(canonical(probeClosure))
  const evidenceBytes = canonical(f.evidence)
  const evidenceSha256 = digest(evidenceBytes)
  put(executor.controllerSha, historicalFixturePath, f.fixtureBytes.historical)
  put(executor.controllerSha, currentFixturePath, f.fixtureBytes.current)
  const sources = () => [
    {
      source: { kind: "commit", sha: candidate.candidateSha },
      workflowSha256: digest(source),
      executionInputs: [],
    },
    { source: { kind: "current-default" }, workflowSha256: digest(source), executionInputs: [] },
  ]
  const topology = [
    {
      workflowId: "803",
      workflow: ".github/workflows/published-artifact-verify.yml",
      disposition: "fenced-legacy",
      sources: sources(),
    },
    {
      workflowId: "804",
      workflow: ".github/workflows/release.yml",
      disposition: "fenced-legacy",
      sources: sources(),
    },
    {
      workflowId: "801",
      workflow: ".github/workflows/release-postpublication.yml",
      disposition: "recovery-owner",
      sources: [],
    },
    {
      workflowId: "802",
      workflow: ".github/workflows/release-postpublication-audit.yml",
      disposition: "recovery-audit",
      sources: [],
    },
    {
      workflowId: "800",
      workflow: ".github/workflows/ci.yml",
      disposition: "nonwriter",
      sources: sources().slice(1),
    },
  ].sort((a, b) => a.workflow.localeCompare(b.workflow))
  const contract = {
    schemaVersion: 1,
    kind: "recovery-legacy-fence-contract",
    repository: candidate.repository,
    repositoryId: candidate.repositoryId,
    candidateSourceSha: candidate.candidateSha,
    mechanism: "github-workflow-disable-v1",
    apiVersion: "2026-03-10",
    evidenceSha256,
    probeClosure,
    fixtures: [
      { revision: "current", path: currentFixturePath, sha256: digest(f.fixtureBytes.current) },
      {
        revision: "historical",
        path: historicalFixturePath,
        sha256: digest(f.fixtureBytes.historical),
      },
    ],
    topology,
  }
  const contractBytes = canonical(contract),
    contractSha256 = digest(contractBytes)
  put(
    executor.controllerSha,
    `scripts/release/recovery-fence-contracts/${contractSha256}.json`,
    contractBytes,
  )
  put(
    executor.controllerSha,
    `scripts/release/recovery-fence-evidence/${evidenceSha256}.json`,
    evidenceBytes,
  )
  policy.fence.contracts = [contractSha256]
  const workflows = topology.map((t) => ({
    id: Number(t.workflowId),
    path: t.workflow,
    state: t.disposition === "fenced-legacy" ? "disabled_manually" : "active",
  }))
  const histories = new Map(
    topology
      .filter((t) => t.disposition === "fenced-legacy")
      .map((t) => [
        t.workflowId,
        Array.from({ length: t.workflowId === "804" ? 514 : 16 }, (_, i) => ({
          id: Number(t.workflowId) * 10000 + i,
          run_attempt: 1,
          workflow_id: Number(t.workflowId),
          path: t.workflow,
          repository: { id: Number(candidate.repositoryId), full_name: candidate.repository },
          head_sha: i % 2 ? candidate.candidateSha : "7".repeat(40),
          metadata: Object.fromEntries(
            Array.from({ length: 220 }, (_, j) => [`field${j}`, `value${j}`]),
          ),
          description: "x".repeat(8000),
          status: "completed",
          conclusion: i % 2 ? "success" : "failure",
        })),
      ]),
  )
  return { files, workflows, histories, contractSha256 }
}
