import { digest } from "./recovery-fixture.mjs"
import { recoveryRemote } from "./recovery-observe-fixture.mjs"

export async function recoveryWriteRemote(options = {}) {
  const r = await recoveryRemote(options)
  const effects = []
  const events = []
  let assets = [...r.baseAssets]
  let fenceValid = true
  let interrupt = 0
  let changedBody = false
  const execution = { ...r.e }
  const github = r.args.github
  const originalRun = github.getActionsRunAttempt
  const originalJobs = github.listActionsRunJobs
  const originalWorkflow = github.getWorkflow
  const present = (value) => ({ status: "PRESENT", value })
  github.getActionsRunAttempt = async (args) =>
    String(args.runId) === execution.runId
      ? present({
          id: Number(execution.runId),
          run_attempt: Number(execution.runAttempt),
          head_sha: execution.controllerSha,
          head_branch: "main",
          event: "workflow_dispatch",
          path: execution.workflow,
          workflow_id: 801,
          status: "in_progress",
          repository: { id: 901, full_name: r.c.repository },
        })
      : originalRun(args)
  github.listActionsRunJobs = async (args) =>
    String(args.runId) === execution.runId
      ? present([
          ...(await originalJobs(args)).value.filter((job) => String(job.id) !== execution.jobId),
          {
            id: Number(execution.jobId),
            runAttempt: Number(execution.runAttempt),
            status: "in_progress",
            name: "recovery-evidence",
            startedAt: "2026-09-04T10:03:30.000Z",
            completedAt: null,
          },
        ])
      : originalJobs(args)
  github.getWorkflow = async (args) =>
    args.workflow === execution.workflow.split("/").at(-1)
      ? present({ id: 801, path: execution.workflow, state: "active" })
      : originalWorkflow(args)
  const transport = async (url, options) => {
    events.push(options.method)
    const parsed = new URL(url)
    if (options.method === "POST") {
      if (
        parsed.origin !== "https://uploads.github.com" ||
        parsed.pathname !== "/repos/cacheplane/dawnai/releases/902/assets"
      )
        throw new Error("unbounded write")
      const name = parsed.searchParams.get("name")
      if (assets.some((a) => a.assetName === name)) return response(422, {})
      const bytes = Buffer.from(options.body)
      const ref = r.add(name, bytes.toString())
      assets.push(ref)
      r.setAssets(assets)
    } else if (options.method === "PATCH") {
      if (parsed.href !== "https://api.github.com/repos/cacheplane/dawnai/releases/902")
        throw new Error("unbounded write")
      const body = JSON.parse(options.body)
      if (Object.keys(body).sort().join() === "draft,tag_name") {
        r.release.draft = false
        r.release.immutable = true
        r.release.tag_name = body.tag_name
      } else {
        if (Object.keys(body).sort().join() !== "body,name")
          throw new Error("unexpected patch fields")
        r.release.body = body.body
        r.release.name = body.name
      }
    } else throw new Error("unexpected mutation")
    effects.push({ url, method: options.method, bytes: Buffer.from(options.body) })
    if (effects.length === interrupt) throw new Error("response lost after write")
    if (changedBody) r.release.body += "external edit"
    return response(options.method === "POST" ? 201 : 200, {})
  }
  const dependencies = {
    observation: r.args,
    authority: {
      git: r.args.git,
      github,
      readInvocation: async () => ({
        sha: execution.controllerSha,
        ref: "refs/heads/main",
        workflow: execution.workflow,
        runId: execution.runId,
        runAttempt: execution.runAttempt,
        jobId: execution.jobId,
        repository: r.c.repository,
        repositoryId: r.c.repositoryId,
        defaultBranch: "main",
      }),
      observeLegacyFence: async () => {
        events.push("fence")
        return {
          contractSha256: digest("fence"),
          candidate: r.c,
          executor: { ...execution },
          observedAt: 1000,
          expiresAt: 31000,
          concurrencyGroup: "dawn-release-controller",
          cancelInProgress: false,
          inventoryComplete: fenceValid,
          writers: [
            {
              workflow: ".github/workflows/release.yml",
              sourceSha: r.c.candidateSha,
              protection: "rejects-v2-before-mutation",
              proofSha256: digest("fence"),
              activeRuns: [],
            },
          ],
        }
      },
      now: () => 1000,
      sleep: async () => {},
    },
    observeImmutableReleasePolicy: async () => ({ repository: r.c.repository, enabled: true }),
    fetchImpl: transport,
  }
  return {
    ...r,
    effects,
    events,
    execution,
    dependencies,
    config: { repository: r.c.repository, token: "fixture-token" },
    request: {
      candidate: r.c,
      expectedControllerSha: execution.controllerSha,
      intentPath: r.intentPath,
    },
    setFence: (value) => {
      fenceValid = value
    },
    interruptAfter: (count) => {
      interrupt = count
    },
    mutateAfter: () => {
      changedBody = true
    },
    activate: (refs) => {
      assets = [...refs]
      r.setAssets(assets)
    },
    assets: () => assets,
  }
}
function response(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}
