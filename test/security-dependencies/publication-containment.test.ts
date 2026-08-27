import { describe, expect, it } from "vitest"

import {
  createEvidenceBudget,
  createGitHubReader,
} from "../../scripts/security/github-evidence.mjs"
import {
  analyzeChartLog,
  collectPublicationContainment,
  INVENTORY_PACKAGES,
  verifyPublicationSnapshot,
} from "../../scripts/security/publication-containment.mjs"

const sourceSha = "b1c0a99287740b3900ae1f0fb240f861b1c2878b"
const defaultSha = "d2404dc7b138db151ae58f0b36788dfa08e2008e"

describe("publication containment", () => {
  it("accepts only the complete exact containment receipt", () => {
    expect(
      verifyPublicationSnapshot(validSnapshot(), {
        expectedDefaultSha: defaultSha,
      }),
    ).toEqual(validSnapshot())
  })

  it.each([
    ["workflow id", (value: any) => (value.workflows.release.id = 1)],
    ["workflow path", (value: any) => (value.workflows.chart.path = ".github/workflows/x.yml")],
    ["workflow state", (value: any) => (value.workflows.release.state = "active")],
    ["non-completed run", (value: any) => (value.workflows.release.nonCompleted = 1)],
    ["source run", (value: any) => (value.workflows.chart.sourceShaRuns = 1)],
    ["incomplete run count", (value: any) => (value.workflows.release.retrievedRuns = 451)],
    ["default head", (value: any) => (value.defaultSha = "0".repeat(40))],
    ["inventory source", (value: any) => (value.inventory.sourceSha = "0".repeat(40))],
    ["missing inventory package", (value: any) => value.inventory.packages.pop()],
    ["extra inventory package", (value: any) => value.inventory.packages.push("extra")],
    [
      "one target document present",
      (value: any) => (value.npm.packages[0].targetDocumentAbsent = false),
    ],
    [
      "one attestation present",
      (value: any) => (value.npm.packages[0].targetAttestationAbsent = false),
    ],
    [
      "one packument identity drift",
      (value: any) => (value.npm.packages[0].packumentName = "other"),
    ],
    ["one latest drift", (value: any) => (value.npm.packages[0].latest = "0.8.22")],
    ["request count", (value: any) => (value.npm.requestCount = 62)],
    ["candidate tag", (value: any) => (value.candidateAbsence.tags = false)],
    ["candidate release", (value: any) => (value.candidateAbsence.releases = false)],
    ["candidate artifact", (value: any) => (value.candidateAbsence.artifacts = false)],
    ["incident head", (value: any) => (value.incidents.release[0].headSha = "0".repeat(40))],
    ["incident jobs", (value: any) => (value.incidents.release[1].jobs = 1)],
    ["incident steps", (value: any) => (value.incidents.release[2].steps = 1)],
    ["publish step", (value: any) => (value.incidents.release[0].publishStepsSkipped = false)],
    ["chart job set", (value: any) => value.incidents.chart.jobs.pop()],
    ["chart log", (value: any) => (value.incidents.chart.jobs[0].noOp = false)],
    ["chart conclusion", (value: any) => (value.incidents.chart.jobs[0].conclusion = "skipped")],
  ])("rejects %s", (_name, mutate) => {
    const snapshot = structuredClone(validSnapshot())
    mutate(snapshot)
    expect(() => verifyPublicationSnapshot(snapshot, { expectedDefaultSha: defaultSha })).toThrow(
      /UNPROVABLE/u,
    )
  })

  it("rejects duplicate package and incident identities before sorting", () => {
    const packageDuplicate = structuredClone(validSnapshot())
    packageDuplicate.npm.packages[1] = structuredClone(packageDuplicate.npm.packages[0])
    expect(() =>
      verifyPublicationSnapshot(packageDuplicate, {
        expectedDefaultSha: defaultSha,
      }),
    ).toThrow(/UNPROVABLE/u)

    const incidentDuplicate = structuredClone(validSnapshot())
    const firstIncident = incidentDuplicate.incidents.release[0]
    const secondIncident = incidentDuplicate.incidents.release[1]
    if (firstIncident === undefined || secondIncident === undefined) {
      throw new Error("missing incident fixture")
    }
    secondIncident.id = firstIncident.id
    expect(() =>
      verifyPublicationSnapshot(incidentDuplicate, {
        expectedDefaultSha: defaultSha,
      }),
    ).toThrow(/UNPROVABLE/u)
  })

  it("collects the complete normalized proof through narrow transports", async () => {
    const budget = createEvidenceBudget({
      maxBytes: 4 * 1024 * 1024,
      maxPages: 20,
      maxRecords: 1000,
      maxRequests: 86,
      timeoutMs: 30_000,
    })
    const github = createGitHubReader({
      budget,
      repo: "cacheplane/dawnai",
      transport: githubTransport(),
    })
    const npmCalls: string[] = []
    const receipt = await collectPublicationContainment({
      budget,
      currentVersion: "0.8.21",
      expectedDefaultSha: defaultSha,
      github,
      inventory: {
        packages: [...INVENTORY_PACKAGES],
        ref: "HEAD",
        sourceSha,
        version: "0.8.21",
      },
      npmRequest: npmTransport(npmCalls),
      repo: "cacheplane/dawnai",
      sourceSha,
      targetVersion: "0.8.22",
    })

    expect(receipt.workflows.release.totalRuns).toBe(3)
    expect(receipt.workflows.chart.totalRuns).toBe(1)
    expect(receipt.npm.requestCount).toBe(63)
    expect(new Set(npmCalls)).toHaveLength(63)
    expect(receipt.incidents.chart.jobs.every((job: any) => job.noOp)).toBe(true)
    expect(() =>
      verifyPublicationSnapshot(receipt, { expectedDefaultSha: defaultSha }),
    ).not.toThrow()
  })

  it("shares the request budget across GitHub and all 63 npm reads", async () => {
    const budget = createEvidenceBudget({
      maxBytes: 4 * 1024 * 1024,
      maxPages: 20,
      maxRecords: 1000,
      maxRequests: 85,
      timeoutMs: 30_000,
    })
    const github = createGitHubReader({
      budget,
      repo: "cacheplane/dawnai",
      transport: githubTransport(),
    })
    await expect(
      collectPublicationContainment({
        budget,
        currentVersion: "0.8.21",
        expectedDefaultSha: defaultSha,
        github,
        inventory: {
          packages: [...INVENTORY_PACKAGES],
          ref: "HEAD",
          sourceSha,
          version: "0.8.21",
        },
        npmRequest: npmTransport([]),
        repo: "cacheplane/dawnai",
        sourceSha,
        targetVersion: "0.8.22",
      }),
    ).rejects.toThrow(/UNPROVABLE: REQUEST_LIMIT/u)
  })

  it("projects only required fields from a live-shaped packument", async () => {
    const receipt = await collectWithGithubOptions(
      {},
      npmTransport([], {
        decoratePackument: (body) => ({
          ...body,
          versions: {
            "0.8.21": { dependencies: { "gpt-tokenizer": "^3.0.1" } },
          },
        }),
      }),
    )
    expect(receipt.npm.requestCount).toBe(63)
  })

  it("does not inspect accessors in irrelevant packument metadata", async () => {
    let accessorCalled = false
    const receipt = await collectWithGithubOptions(
      {},
      npmTransport([], {
        decoratePackument: (body) => {
          const versions = {
            "0.8.21": { dependencies: { "gpt-tokenizer": "^3.0.1" } },
          }
          Object.defineProperty(versions, "hostile", {
            enumerable: false,
            get() {
              accessorCalled = true
              throw new Error("secret_token_value")
            },
          })
          return { ...body, versions }
        },
      }),
    )
    expect(receipt.npm.requestCount).toBe(63)
    expect(accessorCalled).toBe(false)
  })

  it("rejects an accessor on a required packument field without invoking it", async () => {
    let accessorCalled = false
    await expect(
      collectWithGithubOptions(
        {},
        npmTransport([], {
          decoratePackument: (body) => {
            const hostile: any = { ...body }
            delete hostile.name
            Object.defineProperty(hostile, "name", {
              enumerable: false,
              get() {
                accessorCalled = true
                throw new Error("secret_token_value")
              },
            })
            return hostile
          },
        }),
      ),
    ).rejects.toThrow(/UNPROVABLE/u)
    expect(accessorCalled).toBe(false)
  })

  it.each([
    ["package tag", { tagRef: "refs/tags/@dawn-ai/sdk@0.8.22" }],
    [
      "package release tag",
      {
        release: {
          id: 44,
          name: "SDK 0.8.22",
          tag_name: "@dawn-ai/sdk@0.8.22",
        },
      },
    ],
    [
      "package release name",
      {
        release: { id: 44, name: "@dawn-ai/sdk@0.8.22", tag_name: "unrelated" },
      },
    ],
  ])("rejects an exact per-package candidate %s", async (_name, options) => {
    await expect(collectWithGithubOptions(options)).rejects.toThrow(/UNPROVABLE/u)
  })

  it.each([`release-v0.8.22-${sourceSha}`, "@dawn-ai/sdk@0.8.22", "create-dawn-ai-app@0.8.22"])(
    "rejects an exact candidate artifact %s",
    async (artifactName) => {
      await expect(collectWithGithubOptions({ artifactNames: [artifactName] })).rejects.toThrow(
        /UNPROVABLE/u,
      )
    },
  )

  it.each([
    `release-v0.8.21-${sourceSha}`,
    `release-v0.8.220-${sourceSha}`,
    "@dawn-ai/sdk@0.8.220",
    "create-dawn-ai-app@0.8.21",
  ])("does not confuse a near-miss artifact version %s", async (artifactName) => {
    const receipt = await collectWithGithubOptions({
      artifactNames: [artifactName],
    })
    expect(receipt.candidateAbsence.artifacts).toBe(true)
  })

  it.each([
    ["default head", { finalHead: "d".repeat(40) }],
    ["release workflow state", { finalReleaseState: "active" }],
    ["chart workflow state", { finalChartState: "active" }],
    [
      "release history",
      {
        finalReleaseRun: run(
          999,
          260503756,
          ".github/workflows/release.yml",
          "Release",
          "success",
          sourceSha,
        ),
      },
    ],
  ])("rejects closing-bracket %s drift", async (_name, options) => {
    await expect(collectWithGithubOptions(options)).rejects.toThrow(/UNPROVABLE/u)
  })
})

describe("bounded chart logs", () => {
  it("records only the exact no-op boolean and SHA-256 digest", () => {
    const result = analyzeChartLog(
      "prefix\ndawn-app 0.1.0 already published, skipping\nsuffix\n",
      "dawn-app 0.1.0 already published, skipping",
    )
    expect(result).toEqual({
      digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      noOp: true,
    })
    expect(JSON.stringify(result)).not.toContain("prefix")
  })

  it.each([
    ["missing", "prefix\nsuffix\n"],
    ["truncated", "dawn-app 0.1.0 already published, skipp"],
    [
      "duplicate",
      "dawn-app 0.1.0 already published, skipping\ndawn-app 0.1.0 already published, skipping\n",
    ],
    ["oversized", "x".repeat(1024 * 1024 + 1)],
  ])("rejects %s log", (_name, log) => {
    expect(() => analyzeChartLog(log, "dawn-app 0.1.0 already published, skipping")).toThrow(
      /UNPROVABLE/u,
    )
  })
})

function validSnapshot() {
  return {
    candidateAbsence: { artifacts: true, releases: true, tags: true },
    defaultSha,
    incidents: {
      chart: {
        headSha: "3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb",
        id: 31356780047,
        jobs: [
          {
            conclusion: "success",
            digest: "a".repeat(64),
            name: "publish (dawn-app)",
            noOp: true,
          },
          {
            conclusion: "success",
            digest: "b".repeat(64),
            name: "publish (dawn-sandbox-infra)",
            noOp: true,
          },
        ],
        status: "completed",
      },
      release: [
        {
          conclusion: "cancelled",
          headSha: "3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb",
          id: 31356780088,
          jobs: 1,
          publishStepsSkipped: true,
          status: "completed",
          steps: 20,
        },
        {
          conclusion: "cancelled",
          headSha: "b6adaa982b25adf5fac61733a13ac65320c70bcd",
          id: 31356940801,
          jobs: 0,
          publishStepsSkipped: true,
          status: "completed",
          steps: 0,
        },
        {
          conclusion: "cancelled",
          headSha: "cfa55478cf8e35dc8a00ae7041c0c12479fda2d9",
          id: 31357014583,
          jobs: 1,
          publishStepsSkipped: true,
          status: "completed",
          steps: 0,
        },
      ],
    },
    inventory: {
      currentVersion: "0.8.21",
      packages: [...INVENTORY_PACKAGES],
      ref: "HEAD",
      sourceSha,
      targetVersion: "0.8.22",
    },
    npm: {
      packages: INVENTORY_PACKAGES.map((name) => ({
        latest: "0.8.21",
        name,
        packumentName: name,
        targetAttestationAbsent: true,
        targetDocumentAbsent: true,
      })),
      requestCount: 63,
    },
    repository: "cacheplane/dawnai",
    schemaVersion: 1,
    sourceSha,
    workflows: {
      chart: {
        completeRuns: 19,
        id: 309127405,
        nonCompleted: 0,
        path: ".github/workflows/publish-chart.yml",
        retrievedRuns: 19,
        sourceShaRuns: 0,
        state: "disabled_manually",
        totalRuns: 19,
      },
      release: {
        completeRuns: 452,
        id: 260503756,
        nonCompleted: 0,
        path: ".github/workflows/release.yml",
        retrievedRuns: 452,
        sourceShaRuns: 0,
        state: "disabled_manually",
        totalRuns: 452,
      },
    },
  }
}

function githubTransport(options: any = {}) {
  const releaseRuns = [
    run(
      31356780088,
      260503756,
      ".github/workflows/release.yml",
      "Release",
      "cancelled",
      "3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb",
    ),
    run(
      31356940801,
      260503756,
      ".github/workflows/release.yml",
      "Release",
      "cancelled",
      "b6adaa982b25adf5fac61733a13ac65320c70bcd",
    ),
    run(
      31357014583,
      260503756,
      ".github/workflows/release.yml",
      "Release",
      "cancelled",
      "cfa55478cf8e35dc8a00ae7041c0c12479fda2d9",
    ),
  ]
  const chartRun = run(
    31356780047,
    309127405,
    ".github/workflows/publish-chart.yml",
    "Publish Chart",
    "success",
    "3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb",
  )
  const firstSteps = [
    [1, "Set up job", "success"],
    [2, "Checkout", "success"],
    [3, "Setup pnpm", "success"],
    [4, "Setup Node.js", "success"],
    [5, "Install", "success"],
    [6, "Validate Release Candidate", "cancelled"],
    [7, "Setup Node.js for publishing", "skipped"],
    [8, "Create Release Pull Request or Publish", "skipped"],
    [9, "Attest release tarballs", "skipped"],
    [10, "Upload signed release assets", "skipped"],
    [11, "Backfill tags/releases for bootstrapped packages", "skipped"],
    [12, "Read published version", "skipped"],
    [13, "Verify published TypeScript tooling", "skipped"],
    [14, "Smoke published TypeScript tooling", "skipped"],
    [15, "Verify published Docker sandbox", "skipped"],
    [16, "Smoke published Docker sandbox PID recovery", "skipped"],
    [30, "Post Setup Node.js", "skipped"],
    [31, "Post Setup pnpm", "success"],
    [32, "Post Checkout", "success"],
    [33, "Complete job", "success"],
  ].map(([number, name, conclusion]) => ({
    conclusion,
    name,
    number,
    status: "completed",
  }))
  const chartJobs = [
    {
      conclusion: "success",
      id: 93357835324,
      name: "publish (dawn-sandbox-infra)",
      status: "completed",
      steps: [],
    },
    {
      conclusion: "success",
      id: 93357835326,
      name: "publish (dawn-app)",
      status: "completed",
      steps: [],
    },
  ]
  let mainReads = 0
  let releaseWorkflowReads = 0
  let chartWorkflowReads = 0
  let releaseHistoryReads = 0

  return async ({ responseType, url }: { responseType: string; url: string }) => {
    const api = new URL(url)
    const path = `${api.pathname}${api.search}`
    if (responseType === "text") {
      if (path.includes("93357835324"))
        return textResponse("dawn-sandbox-infra 0.1.2 already published, skipping\n")
      if (path.includes("93357835326"))
        return textResponse("dawn-app 0.1.0 already published, skipping\n")
      throw new Error(`unexpected log ${path}`)
    }
    if (path.endsWith("/commits/main")) {
      return jsonResponse({
        sha: mainReads++ === 0 ? defaultSha : (options.finalHead ?? defaultSha),
      })
    }
    if (path.endsWith("/actions/workflows/260503756")) {
      return jsonResponse({
        id: 260503756,
        path: ".github/workflows/release.yml",
        state:
          releaseWorkflowReads++ === 0
            ? "disabled_manually"
            : (options.finalReleaseState ?? "disabled_manually"),
      })
    }
    if (path.endsWith("/actions/workflows/309127405")) {
      return jsonResponse({
        id: 309127405,
        path: ".github/workflows/publish-chart.yml",
        state:
          chartWorkflowReads++ === 0
            ? "disabled_manually"
            : (options.finalChartState ?? "disabled_manually"),
      })
    }
    if (path.includes("/actions/workflows/260503756/runs")) {
      const runs =
        releaseHistoryReads++ === 0 || options.finalReleaseRun === undefined
          ? releaseRuns
          : [...releaseRuns, options.finalReleaseRun]
      return jsonResponse({ total_count: runs.length, workflow_runs: runs })
    }
    if (path.includes("/actions/workflows/309127405/runs")) {
      return jsonResponse({ total_count: 1, workflow_runs: [chartRun] })
    }
    if (path.includes("/git/matching-refs/tags/")) {
      return jsonResponse(options.tagRef === undefined ? [] : [{ ref: options.tagRef }])
    }
    if (path.includes("/releases?")) {
      return jsonResponse(options.release === undefined ? [] : [options.release])
    }
    if (path.includes("/actions/artifacts?")) {
      const artifacts = (options.artifactNames ?? []).map((name: string, index: number) => ({
        id: index + 1,
        name,
      }))
      return jsonResponse({ artifacts, total_count: artifacts.length })
    }
    for (const item of [...releaseRuns, chartRun]) {
      if (path.endsWith(`/actions/runs/${item.id}`)) return jsonResponse(item)
    }
    if (path.includes("/actions/runs/31356780088/jobs")) {
      return jsonResponse({
        jobs: [
          {
            conclusion: "cancelled",
            id: 93357835724,
            name: "release",
            status: "completed",
            steps: firstSteps,
          },
        ],
        total_count: 1,
      })
    }
    if (path.includes("/actions/runs/31356940801/jobs"))
      return jsonResponse({ jobs: [], total_count: 0 })
    if (path.includes("/actions/runs/31357014583/jobs")) {
      return jsonResponse({
        jobs: [
          {
            conclusion: "cancelled",
            id: 93359214159,
            name: "release",
            status: "completed",
            steps: [],
          },
        ],
        total_count: 1,
      })
    }
    if (path.includes("/actions/runs/31356780047/jobs")) {
      return jsonResponse({ jobs: chartJobs, total_count: 2 })
    }
    throw new Error(`unexpected GitHub request ${path}`)
  }
}

async function collectWithGithubOptions(options: any, npmRequest = npmTransport([])) {
  const budget = createEvidenceBudget({
    maxBytes: 4 * 1024 * 1024,
    maxPages: 30,
    maxRecords: 1000,
    maxRequests: 100,
    timeoutMs: 30_000,
  })
  return collectPublicationContainment({
    budget,
    currentVersion: "0.8.21",
    expectedDefaultSha: defaultSha,
    github: createGitHubReader({
      budget,
      repo: "cacheplane/dawnai",
      transport: githubTransport(options),
    }),
    inventory: {
      packages: [...INVENTORY_PACKAGES],
      ref: "HEAD",
      sourceSha,
      version: "0.8.21",
    },
    npmRequest,
    repo: "cacheplane/dawnai",
    sourceSha,
    targetVersion: "0.8.22",
  })
}

function npmTransport(
  calls: string[],
  options: {
    decoratePackument?: (body: { "dist-tags": { latest: string }; name: string }) => any
  } = {},
) {
  return async ({ url }: { url: string }) => {
    calls.push(url)
    const parsed = new URL(url)
    if (parsed.pathname.startsWith("/-/npm/v1/attestations/")) {
      return npmResponse(404, { error: "Not found" })
    }
    const path = parsed.pathname.slice(1)
    if (path.endsWith("/0.8.22")) return npmResponse(404, "version not found: 0.8.22")
    const name = decodeURIComponent(path)
    const packument = { "dist-tags": { latest: "0.8.21" }, name }
    return npmResponse(200, options.decoratePackument?.(packument) ?? packument)
  }
}

function run(
  id: number,
  workflowId: number,
  path: string,
  name: string,
  conclusion: string,
  headSha: string,
) {
  return {
    conclusion,
    event: "push",
    head_sha: headSha,
    id,
    name,
    path,
    run_attempt: 1,
    status: "completed",
    workflow_id: workflowId,
  }
}

function jsonResponse(body: unknown) {
  return {
    body,
    bodyBytes: Buffer.byteLength(JSON.stringify(body)) + 64,
    link: null,
    status: 200,
  }
}

function textResponse(body: string) {
  return {
    body,
    bodyBytes: Buffer.byteLength(body) + 64,
    link: null,
    status: 200,
  }
}

function npmResponse(httpStatus: number, body: unknown) {
  return {
    body,
    bodyBytes: Buffer.byteLength(JSON.stringify(body)),
    code: null,
    httpStatus,
    status: httpStatus === 200 ? "OK" : "HTTP_ERROR",
  }
}
