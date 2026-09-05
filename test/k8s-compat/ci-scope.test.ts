import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { describe, expect, test } from "vitest"
import { parse } from "yaml"

import {
  classifyMetadataOnlyScope,
  type GitCommandRunner,
  METADATA_ONLY_PATHS,
} from "../../scripts/ci-scope.mjs"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)
const repoRoot = resolve(__dirname, "../..")
const ciWorkflow = parse(readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8"))

function commandResult(paths: readonly string[] = []): { readonly stdout: Buffer } {
  return { stdout: Buffer.from(paths.length === 0 ? "" : `${paths.join("\0")}\0`) }
}

function githubExpression(expression: string): string {
  return `\${{ ${expression} }}`
}

describe("metadata-only CI scope", () => {
  test("publishes a single exact generated-metadata allowlist", () => {
    expect(METADATA_ONLY_PATHS).toEqual(["apps/web/app/seo/lastmod.generated.json"])
    expect(Object.isFrozen(METADATA_ONLY_PATHS)).toBe(true)
  })

  test("skips infrastructure only when every changed path is generated metadata", async () => {
    const calls: { readonly file: string; readonly args: readonly string[] }[] = []
    const runCommand: GitCommandRunner = async (file, args) => {
      calls.push({ file, args })
      return args[0] === "diff" ? commandResult(METADATA_ONLY_PATHS) : commandResult()
    }

    await expect(
      classifyMetadataOnlyScope(
        { event: "pull_request", base: BASE_SHA, head: HEAD_SHA },
        runCommand,
      ),
    ).resolves.toBe(true)
    expect(calls).toEqual([
      { file: "git", args: ["cat-file", "-e", `${BASE_SHA}^{commit}`] },
      { file: "git", args: ["cat-file", "-e", `${HEAD_SHA}^{commit}`] },
      {
        file: "git",
        args: ["diff", "--merge-base", "--no-renames", "--name-only", "-z", BASE_SHA, HEAD_SHA],
      },
    ])
  })

  test("includes feature changes already present at the base endpoint", async () => {
    const temporary = mkdtempSync(resolve(tmpdir(), "dawn-ci-scope-"))
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: temporary, encoding: "utf8" }).trim()
    try {
      git("init", "--initial-branch=main")
      git("config", "user.name", "CI Scope Test")
      git("config", "user.email", "ci-scope@example.invalid")
      writeFileSync(resolve(temporary, "README.md"), "fixture\n")
      git("add", "README.md")
      git("commit", "-m", "initial")

      git("checkout", "-b", "feature")
      mkdirSync(resolve(temporary, "apps/web/app/seo"), { recursive: true })
      mkdirSync(resolve(temporary, "packages/example"), { recursive: true })
      writeFileSync(resolve(temporary, METADATA_ONLY_PATHS[0] as string), "{}\n")
      writeFileSync(resolve(temporary, "packages/example/index.ts"), "export const value = 1\n")
      git("add", ".")
      git("commit", "-m", "feature changes")
      const head = git("rev-parse", "HEAD")

      git("checkout", "main")
      mkdirSync(resolve(temporary, "packages/example"), { recursive: true })
      writeFileSync(resolve(temporary, "packages/example/index.ts"), "export const value = 1\n")
      git("add", ".")
      git("commit", "-m", "base receives same source change")
      const base = git("rev-parse", "HEAD")

      const runCommand: GitCommandRunner = async (file, args) => ({
        stdout: execFileSync(file, [...args], { cwd: temporary, encoding: "buffer" }),
      })
      await expect(
        classifyMetadataOnlyScope({ event: "pull_request", base, head }, runCommand),
      ).resolves.toBe(false)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })

  test.each([
    [[]],
    [["apps/web/app/seo/lastmod.generated.json", "apps/web/app/seo/lastmod.ts"]],
    [["apps/web/app/seo/lastmod.generated.ts"]],
    [["./apps/web/app/seo/lastmod.generated.json"]],
    [["apps\\web\\app\\seo\\lastmod.generated.json"]],
  ])("runs infrastructure for an empty, mixed, or near-miss diff: %#", async (paths) => {
    const runCommand: GitCommandRunner = async (_file, args) =>
      args[0] === "diff" ? commandResult(paths) : commandResult()

    await expect(
      classifyMetadataOnlyScope(
        { event: "pull_request", base: BASE_SHA, head: HEAD_SHA },
        runCommand,
      ),
    ).resolves.toBe(false)
  })

  test("always runs infrastructure for push events without invoking Git", async () => {
    const calls: unknown[] = []
    const runCommand: GitCommandRunner = async (file, args) => {
      calls.push({ file, args })
      return commandResult()
    }

    await expect(classifyMetadataOnlyScope({ event: "push" }, runCommand)).resolves.toBe(false)
    expect(calls).toEqual([])
  })

  test.each(["", "a".repeat(39), "A".repeat(40), "g".repeat(40)])(
    "rejects invalid pull-request SHAs before invoking Git: %#",
    async (base) => {
      const calls: unknown[] = []
      const runCommand: GitCommandRunner = async (file, args) => {
        calls.push({ file, args })
        return commandResult()
      }

      await expect(
        classifyMetadataOnlyScope({ event: "pull_request", base, head: HEAD_SHA }, runCommand),
      ).rejects.toThrow(/base SHA/)
      expect(calls).toEqual([])
    },
  )

  test("rejects unsupported events without invoking Git", async () => {
    const calls: unknown[] = []
    const runCommand: GitCommandRunner = async (file, args) => {
      calls.push({ file, args })
      return commandResult()
    }

    await expect(classifyMetadataOnlyScope({ event: "schedule" }, runCommand)).rejects.toThrow(
      "Unknown CI scope event mode",
    )
    expect(calls).toEqual([])
  })

  test.each([
    Buffer.from("apps/web/app/seo/lastmod.generated.json"),
    Buffer.from("\0"),
    Buffer.from("apps/web/app/seo/lastmod.generated.json\0\0"),
    Buffer.from([0xff, 0x00]),
  ])("rejects malformed Git diff bytes: %#", async (stdout) => {
    const runCommand: GitCommandRunner = async (_file, args) =>
      args[0] === "diff" ? { stdout } : commandResult()

    await expect(
      classifyMetadataOnlyScope(
        { event: "pull_request", base: BASE_SHA, head: HEAD_SHA },
        runCommand,
      ),
    ).rejects.toThrow(/malformed|UTF-8/i)
  })

  test("rejects non-buffer diff output and propagates Git failures", async () => {
    const nonBuffer: GitCommandRunner = async (_file, args) =>
      args[0] === "diff"
        ? ({ stdout: "not-a-buffer" } as unknown as { readonly stdout: Buffer })
        : commandResult()
    await expect(
      classifyMetadataOnlyScope(
        { event: "pull_request", base: BASE_SHA, head: HEAD_SHA },
        nonBuffer,
      ),
    ).rejects.toThrow("expected a Buffer")

    const failure = new Error("git timed out")
    const rejecting: GitCommandRunner = async () => Promise.reject(failure)
    await expect(
      classifyMetadataOnlyScope(
        { event: "pull_request", base: BASE_SHA, head: HEAD_SHA },
        rejecting,
      ),
    ).rejects.toBe(failure)
  })
})

describe("CI workflow metadata scope", () => {
  test("uses one scope output to skip only the expensive Kubernetes and full-arc jobs", () => {
    const jobs = ciWorkflow.jobs as Record<string, Record<string, unknown>>
    const scope = jobs.metadata_scope
    expect(scope).toBeDefined()
    expect(scope?.name).toBe("metadata-scope")
    expect(scope?.if).toBe("github.event_name == 'pull_request'")
    expect(scope?.outputs).toEqual({
      metadata_only: githubExpression("steps.classify.outputs.metadata_only"),
    })

    const steps = scope?.steps as Record<string, unknown>[]
    expect(steps).toContainEqual({
      name: "Checkout",
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: { "fetch-depth": 0 },
    })
    expect(steps).toContainEqual({
      name: "Setup Node.js",
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: { "node-version": "24.17.0" },
    })
    const classify = steps.find((step) => step.name === "Classify metadata-only change")
    expect(classify?.id).toBe("classify")
    expect(classify?.env).toEqual({
      BASE_SHA: githubExpression("github.event.pull_request.base.sha"),
      HEAD_SHA: githubExpression("github.event.pull_request.head.sha"),
    })
    expect(classify?.run).toContain("node scripts/ci-scope.mjs")
    expect(classify?.run).toContain("Malformed metadata-only scope output")

    const scopedJobs = ["sandbox-k8s", "sandbox-k8s-e2e", "sandbox-docker-e2e", "chart-apply-smoke"]
    const failOpenCondition = githubExpression(
      "always() && (github.event_name != 'pull_request' || needs.metadata_scope.result != 'success' || needs.metadata_scope.outputs.metadata_only != 'true')",
    )
    for (const id of scopedJobs) {
      expect(jobs[id]?.needs).toBe("metadata_scope")
      expect(jobs[id]?.if).toBe(failOpenCondition)
    }

    expect(
      Object.entries(jobs)
        .filter(([, job]) => job.needs === "metadata_scope")
        .map(([id]) => id)
        .sort(),
    ).toEqual([...scopedJobs].sort())

    for (const id of [
      "source-validate",
      "release-controller",
      "sandbox-docker",
      "chart-validate",
      "vercel-native",
    ]) {
      expect(jobs[id]?.needs).toBeUndefined()
    }
    for (const id of ["source-validate", "release-controller"]) {
      expect(jobs[id]?.if).toBeUndefined()
    }
    expect(jobs.validate?.needs).toEqual([
      "source-validate",
      "release-controller",
      "pack-smoke",
      "harness-verify",
    ])
    expect(jobs.validate?.if).toBe("always()")
  })
})
