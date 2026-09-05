// Test-only service store. All GitHub/npm HTTP normalization and recovery writes
// use production adapters. Synthetic signatures, lane receipts and admission
// callbacks are explicit fixture seams, never production verification bypasses.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { createGitHubReader } from "../../adapters/github.mjs"
import { createNpmReader } from "../../adapters/npm.mjs"
import { planCandidateArbitration } from "../../planner.mjs"
import { adoptRecoveryCandidate } from "../../recovery/adopt.mjs"
import {
  dispatchRecoveryAudit,
  reconcileRecoveryAudit,
  runRecoveryAudit,
} from "../../recovery/audit.mjs"
import { collectRecoveryEvidence } from "../../recovery/evidence.mjs"
import { finalizeRecoveryCandidate, publishRecoveryCandidate } from "../../recovery/finalize.mjs"
import { routeRecoveryCandidate } from "../../recovery/observe.mjs"
import { canonicalRecoveryBytes } from "../../recovery/schema.mjs"
import { evidenceRemote, zip } from "./recovery-evidence-fixture.mjs"

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const TEST_SEAMS = Object.freeze([
  "synthetic npm and attestation trust",
  "fixture git policy, invocation and legacy fence",
  "five synthetic lane artifacts",
  "fixture immutable-release policy",
  "canonical-host mapping to owned loopback HTTP",
])

export async function createRecoveryHttpRehearsal({ fault = null } = {}) {
  assert.ok(
    fault === null ||
      (Number.isInteger(fault.at) &&
        fault.at >= 1 &&
        fault.at <= 128 &&
        ["before", "after"].includes(fault.when)),
    "bounded fixture fault",
  )
  let mutationAttempts = 0,
    faultTriggered = false,
    retryAvailable = false
  const resumes = []
  const r = await evidenceRemote()
  r.activate(r.baseAssets)
  r.release.body = r.legacyBody
  const backend = r.args.github
  const originalBytes = new Map(
    r.baseAssets.map((a) => [a.assetName, Buffer.from(r.raws.get(a.assetName))]),
  )
  const requests = [],
    errors = [],
    auditRuns = new Map()
  let stage = "initial",
    currentAudit = null,
    auditArtifact = null,
    auditBytes = null
  const base = `/repos/${r.c.repository}`
  const raw = async (method, args = {}) => {
    const value = await backend[method](args)
    assert.equal(value.status, "PRESENT", `fixture store ${method}`)
    return value.value
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://owned.invalid")
    const pathname = decodeURIComponent(url.pathname)
    requests.push({
      stage,
      method: request.method,
      origin: request.headers["x-rehearsal-origin"],
      path: url.pathname,
      search: url.search,
    })
    const json = (value, status = 200) => {
      response.statusCode = status
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify(value))
    }
    const binary = (bytes) => {
      response.setHeader("Content-Type", "application/octet-stream")
      response.end(bytes)
    }
    const page = (values, key = null) => {
      const number = Number(url.searchParams.get("page") ?? 1)
      assert.ok(Number.isInteger(number) && number >= 1 && number <= 100)
      const items = values.slice((number - 1) * 25, number * 25)
      if (number * 25 < values.length) {
        const next = new URL(`https://api.github.com${url.pathname}${url.search}`)
        next.searchParams.set("page", String(number + 1))
        response.setHeader("Link", `<${next.href}>; rel="next"`)
      }
      json(key ? { total_count: values.length, [key]: items } : items)
    }
    try {
      if (request.method !== "GET") {
        assert.ok(["POST", "PATCH"].includes(request.method), "bounded fixture method")
        const chunks = []
        let length = 0
        for await (const chunk of request) {
          length += chunk.length
          assert.ok(length <= 4 * 1024 * 1024)
          chunks.push(chunk)
        }
        const bytes = Buffer.concat(chunks)
        mutationAttempts++
        const interrupt = (when) => {
          if (!faultTriggered && fault?.at === mutationAttempts && fault.when === when) {
            faultTriggered = true
            retryAvailable = true
            response.destroy()
            return true
          }
          return false
        }
        if (interrupt("before")) return
        if (pathname === `${base}/actions/workflows/release-postpublication-audit.yml/dispatches`) {
          assert.equal(request.method, "POST")
          assert.equal(request.headers["x-github-api-version"], "2026-03-10")
          const input = JSON.parse(bytes)
          assert.equal(input.ref, "main")
          const runId = String(905 + auditRuns.size * 1000)
          currentAudit = {
            id: Number(runId),
            run_attempt: 1,
            head_sha: r.e.controllerSha,
            head_branch: "main",
            path: ".github/workflows/release-postpublication-audit.yml",
            workflow_id: 802,
            event: "workflow_dispatch",
            status: "in_progress",
            conclusion: null,
            repository: { id: 901, full_name: r.c.repository },
            jobId: String(Number(runId) + 1),
          }
          auditRuns.set(runId, currentAudit)
          r.effects.push({
            url: `https://api.github.com${url.pathname}`,
            method: "POST",
            bytes,
            stage,
          })
          if (interrupt("after")) return
          return json({
            workflow_run_id: Number(runId),
            run_url: `https://api.github.com${base}/actions/runs/${runId}`,
            html_url: `https://github.com/${r.c.repository}/actions/runs/${runId}`,
          })
        }
        const origin = pathname.endsWith("/assets")
          ? "https://uploads.github.com"
          : "https://api.github.com"
        const result = await r.dependencies.fetchImpl(`${origin}${url.pathname}${url.search}`, {
          method: request.method,
          body: bytes,
          headers: { "X-GitHub-Api-Version": "2022-11-28" },
        })
        r.effects.at(-1).stage = stage
        if (interrupt("after")) return
        return json(
          request.method === "PATCH" ? r.release : { id: Number(r.assets().at(-1).id) },
          result.status,
        )
      }
      if (pathname === `${base}/releases`) return page(await raw("listReleases"))
      if (
        pathname === `${base}/releases/${r.c.releaseId}` ||
        pathname.startsWith(`${base}/releases/tags/`)
      )
        return json(r.release)
      if (pathname === `${base}/releases/${r.c.releaseId}/assets`)
        return page(await raw("listReleaseAssets", { releaseId: r.c.releaseId }))
      let match = pathname.match(/\/releases\/assets\/(\d+)$/u)
      if (match) {
        const ref = r.assets().find((a) => a.id === match[1])
        assert.ok(ref, "active release asset required")
        return binary(r.raws.get(ref.assetName))
      }
      if (pathname.startsWith(`${base}/git/ref/`))
        return json(await raw("getRef", { ref: pathname.slice(`${base}/git/ref/`.length) }))
      if (pathname.startsWith(`${base}/git/tags/`)) return json(await raw("getGitTag"))
      match = pathname.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)$/u)
      if (match) {
        const run =
          auditRuns.get(match[1]) ??
          (await raw("getActionsRunAttempt", { runId: match[1], attempt: match[2] }))
        const { jobId: _jobId, ...record } = run
        return json(record)
      }
      match = pathname.match(/\/actions\/runs\/(\d+)\/jobs$/u)
      if (match) {
        const audit = auditRuns.get(match[1])
        const jobs = audit
          ? [
              {
                id: Number(audit.jobId),
                runAttempt: 1,
                name: "recovery-audit",
                status: audit.status,
                conclusion: audit.conclusion,
                startedAt: "2026-09-04T10:03:40.000Z",
                completedAt: audit.status === "completed" ? "2026-09-04T10:03:45.000Z" : null,
              },
            ]
          : await raw("listActionsRunJobs", { runId: match[1] })
        return page(
          jobs.map((j) => ({
            id: j.id,
            run_attempt: j.runAttempt,
            name: j.id === 907 ? "recovery-audit-evidence" : j.name,
            status: j.status,
            conclusion: j.conclusion ?? null,
            started_at: j.id === 907 ? "2026-09-04T10:03:50.000Z" : (j.startedAt ?? null),
            completed_at: j.completedAt ?? null,
          })),
          "jobs",
        )
      }
      match = pathname.match(/\/actions\/workflows\/([^/]+)\/runs$/u)
      if (match)
        return page(
          await raw("listWorkflowRuns", {
            workflow: match[1],
            commitSha: url.searchParams.get("head_sha"),
          }),
          "workflow_runs",
        )
      match = pathname.match(/\/actions\/workflows\/([^/]+)$/u)
      if (match) return json(await raw("getWorkflow", { workflow: match[1] }))
      if (pathname.endsWith("/check-runs"))
        return page(await raw("getCommitCheckRuns"), "check_runs")
      match = pathname.match(/\/actions\/runs\/(\d+)\/artifacts$/u)
      if (match)
        return page(
          auditRuns.has(match[1])
            ? auditArtifact && String(auditArtifact.workflow_run.id) === match[1]
              ? [auditArtifact]
              : []
            : r.artifacts,
          "artifacts",
        )
      match = pathname.match(/\/actions\/artifacts\/(\d+)(\/zip)?$/u)
      if (match) {
        const artifact =
          auditArtifact && String(auditArtifact.id) === match[1]
            ? auditArtifact
            : r.artifacts.find((a) => String(a.id) === match[1])
        assert.ok(artifact, "owned artifact required")
        return match[2]
          ? binary(artifact === auditArtifact ? auditBytes : r.archives.get(match[1]).bytes)
          : json(artifact)
      }
      const entry = r.base.manifest.packages.find(
        (p) =>
          pathname === `/${p.name}` ||
          pathname === `/${p.name}/${p.version}` ||
          pathname ===
            new URL(
              `https://registry.npmjs.org/${p.name}/-/${p.name.split("/").at(-1)}-${p.version}.tgz`,
            ).pathname,
      )
      if (entry) {
        const pkg = (
          await r.args.npm.observePackageVersion({ name: entry.name, version: entry.version })
        ).package
        if (pathname.endsWith(".tgz")) return binary(r.raws.get(entry.filename))
        const document = {
          name: entry.name,
          version: entry.version,
          dist: { integrity: entry.npmIntegrity, shasum: pkg.shasum, tarball: pkg.tarballUrl },
        }
        return json(
          pathname === `/${entry.name}`
            ? {
                name: entry.name,
                versions: { [entry.version]: document },
                "dist-tags": { latest: entry.version },
              }
            : document,
        )
      }
      throw new Error(`Unmodeled fixture request ${request.method} ${pathname}`)
    } catch (error) {
      errors.push(error.message)
      json({ message: error.message }, 500)
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = server.address().port
  let closed = false
  const mappedFetch = (value, options) => {
    assert.equal(closed, false, "closed rehearsal")
    const url = new URL(value)
    assert.ok(
      [
        "https://api.github.com",
        "https://uploads.github.com",
        "https://registry.npmjs.org",
      ].includes(url.origin),
      "fixture network escape",
    )
    const headers = new Headers(options?.headers)
    headers.set("X-Rehearsal-Origin", url.origin)
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { ...options, headers })
  }
  const readers = () => ({
    github: createGitHubReader({
      owner: "cacheplane",
      repo: "dawnai",
      repositoryId: r.c.repositoryId,
      token: "fixture-token",
      fetchImpl: mappedFetch,
    }),
    npm: createNpmReader({ fetchImpl: mappedFetch }),
    git: r.args.git,
    npmAuditFactory: r.args.npmAuditFactory,
    attestations: r.args.attestations,
  })
  const observation = readers()
  const dependencies = {
    ...r.dependencies,
    observation,
    authority: { ...r.dependencies.authority, github: observation.github },
    fetchImpl: mappedFetch,
  }
  const request = r.request
  const legacy = {
    version: r.c.version,
    commitSha: r.c.candidateSha,
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  }
  const resume = async (operation) => {
    try {
      return await operation()
    } catch (error) {
      if (!retryAvailable || !/uncertain|stopped/.test(error.message)) throw error
      retryAvailable = false
      resumes.push({ stage, reason: error.message })
      return operation()
    }
  }
  async function drive() {
    try {
      stage = "adopt"
      assert.equal(
        (await resume(() => adoptRecoveryCandidate(request, r.config, dependencies))).phase,
        "RECOVERY_ADOPTED",
      )
      stage = "five-lanes"
      const verified = await resume(() => collectRecoveryEvidence(request, r.config, dependencies))
      assert.equal(verified.phase, "VERIFICATION_COMPLETE")
      stage = "audit-dispatch"
      let auditRequest
      for (let attempt = 1; attempt <= 2; attempt++) {
        auditRequest = { ...request, requestId: `http-audit-${attempt}` }
        const dispatched = await resume(() =>
          dispatchRecoveryAudit(auditRequest, r.config, dependencies),
        )
        if (dispatched.phase === "AUDIT_PENDING") break
        assert.equal(dispatched.phase, "VERIFICATION_COMPLETE")
        assert.ok(
          dispatched.facts.auditBookkeeping.some(
            (entry) =>
              entry.receipt.requestId === auditRequest.requestId &&
              entry.receipt.classification === "uncorrelated",
          ),
          "only a durably classified uncorrelated intent permits a new request",
        )
        assert.equal(attempt, 1, "bounded independent replacement intent")
      }
      stage = "independent-audit"
      const auditObservation = readers()
      const auditor = {
        observation: auditObservation,
        authority: {
          ...dependencies.authority,
          github: auditObservation.github,
          readInvocation: async () => ({
            ...(await r.dependencies.authority.readInvocation()),
            workflow: currentAudit.path,
            runId: String(currentAudit.id),
            runAttempt: "1",
            jobId: currentAudit.jobId,
          }),
        },
      }
      const result = await runRecoveryAudit(auditRequest, auditor)
      assert.equal(result.conclusion, "success")
      currentAudit.status = "completed"
      currentAudit.conclusion = "success"
      const name = `recovery-v2-audit-result-${currentAudit.id}-1-${currentAudit.jobId}`
      auditBytes = zip([{ name: `${name}.json`, bytes: canonicalRecoveryBytes(result) }])
      auditArtifact = {
        id: 999,
        name,
        size_in_bytes: auditBytes.length,
        digest: `sha256:${hash(auditBytes)}`,
        expired: false,
        created_at: "2026-09-04T10:03:41.000Z",
        updated_at: "2026-09-04T10:03:44.000Z",
        workflow_run: {
          id: currentAudit.id,
          repository_id: 901,
          head_repository_id: 901,
          head_sha: r.e.controllerSha,
          head_branch: "main",
        },
      }
      stage = "audit-escrow"
      r.execution.jobId = "907"
      assert.equal(
        (await resume(() => reconcileRecoveryAudit(auditRequest, r.config, dependencies))).phase,
        "AUDIT_VERIFIED",
      )
      stage = "finalize"
      assert.equal(
        (await resume(() => finalizeRecoveryCandidate(request, r.config, dependencies))).phase,
        "PUBLICATION_READY",
      )
      stage = "publish"
      const complete = await resume(() => publishRecoveryCandidate(request, r.config, dependencies))
      assert.equal(complete.phase, "COMPLETE")
      for (const [name, bytes] of originalBytes) assert.deepEqual(r.raws.get(name), bytes)
      const finalization = complete.facts.finalization
      assert.deepEqual(
        r
          .assets()
          .map((a) => a.assetName)
          .sort(),
        [...finalization.receipt.assets.map((a) => a.assetName), finalization.ref.assetName].sort(),
      )
      for (const ref of r.assets()) {
        assert.equal(hash(r.raws.get(ref.assetName)), ref.sha256)
        assert.equal(r.raws.get(ref.assetName).length, ref.size)
      }
      const before = r.effects.length
      stage = "published-noop"
      assert.equal(
        (await resume(() => publishRecoveryCandidate(request, r.config, dependencies))).phase,
        "COMPLETE",
      )
      stage = "next-version"
      const terminal = await routeRecoveryCandidate({
        ...readers(),
        candidate: legacy,
        terminalRecordRef: r.e.controllerSha,
      })
      const newer = {
        candidate: { ...legacy, version: "0.8.25", commitSha: "e".repeat(40) },
        state: "CANDIDATE_VALIDATED",
        disposition: "selected",
        tag: null,
        conflicts: [],
      }
      const next = planCandidateArbitration({ candidate: newer, managedReleases: [terminal] })
      assert.equal(errors.length, 0, JSON.stringify(errors))
      const uploads = r.effects.filter(
        (e) => e.method === "POST" && new URL(e.url).origin === "https://uploads.github.com",
      )
      const auditRequests = r.effects
        .filter((e) => e.method === "POST" && new URL(e.url).pathname.endsWith("/dispatches"))
        .map((e) => JSON.parse(e.bytes).inputs.request_id)
      return {
        faultTriggered,
        mutationAttempts,
        resumes,
        duplicateUploads: uploads.length - new Set(uploads.map((e) => e.url)).size,
        duplicateAuditRequests: auditRequests.length - new Set(auditRequests).size,
        phase: complete.phase,
        noopWrites: r.effects.length - before,
        nextVersionDisposition: next.disposition,
        originalAssetsVerified: originalBytes.size,
        lanesVerified: verified.facts.verification.set.lanes.length,
        npmPublishAttempts: requests.filter(
          (q) => q.origin === "https://registry.npmjs.org" && q.method !== "GET",
        ).length,
        duplicateDrafts: requests.filter(
          (q) => q.path === `${base}/releases` && q.method === "POST",
        ).length,
        httpRequests: requests.length,
        httpRequestsByStage: Object.fromEntries(
          [...new Set(requests.map((q) => q.stage))].map((name) => [
            name,
            requests.filter((q) => q.stage === name).length,
          ]),
        ),
        effects: r.effects.map((e) => ({ method: e.method, url: e.url, stage: e.stage })),
        testSeams: TEST_SEAMS,
      }
    } catch (error) {
      throw new Error(
        `HTTP recovery rehearsal failed in ${stage}; service errors: ${JSON.stringify(errors)}; ${error.message}`,
        { cause: error },
      )
    }
  }
  return {
    drive,
    requests,
    async close() {
      closed = true
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
