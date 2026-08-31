import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, test } from "vitest"
import {
  type CompatibilityPolicy,
  loadCompatibilityPolicy,
} from "../../scripts/kubernetes-compat/policy.ts"
import {
  classifyKubernetesCompatibilityScope,
  GIT_COMMAND_DEFAULTS,
  type GitCommandRunner,
  isKubernetesCompatibilityPath,
  KUBERNETES_COMPATIBILITY_PATHS,
  parseNulDelimitedGitPaths,
} from "../../scripts/kubernetes-compat/scope.ts"
import {
  aggregateCompatibility,
  createCompatibilityMatrix,
  runWorkflowCli,
} from "../../scripts/kubernetes-compat/workflow.ts"

const REPO_ROOT = resolve(__dirname, "../..")
const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)
const expectedOwnership = {
  exact: [
    ".npmrc",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "turbo.json",
    ".github/workflows/ci.yml",
    ".github/workflows/kubernetes-compat.yml",
    ".github/kubernetes-compatibility.json",
    "scripts/kubernetes-compat.ts",
    "packages/workspace/src/sandbox-types.ts",
  ],
  prefixes: [
    ".github/kind/",
    "scripts/kubernetes-compat/",
    "test/k8s-compat/",
    "test/k8s-smoke/",
    "packages/sandbox/",
    "charts/dawn-app/",
    "charts/dawn-sandbox-infra/",
  ],
} as const

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function commandResult(stdout: Buffer = Buffer.alloc(0)): { readonly stdout: Buffer } {
  return { stdout }
}

function git(repository: string, args: readonly string[]): Buffer {
  return execFileSync("git", args, { cwd: repository })
}

function targetByRole(
  policy: CompatibilityPolicy,
  role: CompatibilityPolicy["targets"][number]["role"],
): CompatibilityPolicy["targets"][number] {
  const target = policy.targets.find((candidate) => candidate.role === role)
  if (target === undefined) {
    throw new Error(`Missing ${role} target in test policy`)
  }
  return target
}

describe("Kubernetes compatibility path ownership", () => {
  test("exports the exact ownership list in one inspectable form", () => {
    expect(KUBERNETES_COMPATIBILITY_PATHS).toEqual(expectedOwnership)
  })

  test.each(expectedOwnership.exact)("classifies exact path %s as relevant", (path) => {
    expect(isKubernetesCompatibilityPath(path)).toBe(true)
  })

  test.each(expectedOwnership.prefixes)("classifies prefix %s as relevant", (prefix) => {
    expect(isKubernetesCompatibilityPath(`${prefix}nested/file with spaces.ts`)).toBe(true)
  })

  test.each([
    ".npmrc.local",
    "package-lock.json",
    ".github/workflows/ci.yaml",
    ".github/workflows/kubernetes-compat.yml.bak",
    ".github/kinds/kind-calico.yaml",
    ".github/kindred/config.yaml",
    "scripts/kubernetes-compatibility/run.ts",
    "test/k8s-compatible/scope.test.ts",
    "packages/sandboxed/src/index.ts",
    "packages/workspace/src/other-sandbox-types.ts",
    "charts/dawn-application/values.yaml",
    "charts/dawn-sandbox-infrastructure/values.yaml",
    "docs/kubernetes-compatibility.md",
    "./packages/sandbox/src/index.ts",
    "packages\\sandbox\\src\\index.ts",
  ])("does not classify near miss %s as relevant", (path) => {
    expect(isKubernetesCompatibilityPath(path)).toBe(false)
  })

  test.each(expectedOwnership.prefixes)("does not classify bare prefix root %s", (prefix) => {
    expect(isKubernetesCompatibilityPath(prefix.slice(0, -1))).toBe(false)
  })
})

describe("Kubernetes compatibility cache inputs", () => {
  test("invalidates the sandbox test cache when the compatibility policy changes", async () => {
    const turbo = JSON.parse(await readFile(join(REPO_ROOT, "turbo.json"), "utf8")) as {
      tasks?: Record<string, { inputs?: string[] }>
    }

    expect(turbo.tasks?.["@dawn-ai/sandbox#test"]?.inputs).toContain(
      "$TURBO_ROOT$/.github/kubernetes-compatibility.json",
    )
  })
})

describe("NUL-delimited Git path parsing", () => {
  test("preserves filenames containing spaces and newlines", () => {
    const paths = [
      "packages/sandbox/src/file with spaces.ts",
      "packages/sandbox/src/file\nwith-newline.ts",
    ]
    const output = Buffer.from(`${paths[0]}\0${paths[1]}\0`)

    expect(parseNulDelimitedGitPaths(output)).toEqual(paths)
  })

  test("preserves a leading byte-order mark as filename data", () => {
    const path = `${String.fromCodePoint(0xfeff)}package.json`
    const [parsed] = parseNulDelimitedGitPaths(Buffer.from(`${path}\0`))

    expect(parsed).toBe(path)
    expect(isKubernetesCompatibilityPath(parsed ?? "")).toBe(false)
  })

  test("treats an empty diff as no changed paths", () => {
    expect(parseNulDelimitedGitPaths(Buffer.alloc(0))).toEqual([])
  })

  test.each([
    Buffer.from("README.md"),
    Buffer.from("\0"),
    Buffer.from("README.md\0\0"),
    Buffer.from([0xff, 0x00]),
  ])("rejects malformed nonempty output %#", (output) => {
    expect(() => parseNulDelimitedGitPaths(output)).toThrow(/malformed|UTF-8/i)
  })
})

describe("Git command adapter", () => {
  test("publishes production timeout and independent byte bounds", () => {
    expect(GIT_COMMAND_DEFAULTS).toEqual({
      timeoutMs: 30_000,
      stdoutLimitBytes: 32 * 1_024 * 1_024,
      stderrLimitBytes: 64 * 1_024,
    })
    expect(Object.isFrozen(GIT_COMMAND_DEFAULTS)).toBe(true)
  })
})

describe("pull-request scope", () => {
  test("validates both commit objects before running the exact NUL diff command", async () => {
    const calls: { readonly file: string; readonly args: readonly string[] }[] = []
    const runCommand: GitCommandRunner = async (file, args) => {
      calls.push({ file, args })
      if (args[0] === "diff") {
        return commandResult(Buffer.from("docs/unrelated.md\0"))
      }
      return commandResult()
    }

    await expect(
      classifyKubernetesCompatibilityScope(
        { event: "pull_request", base: BASE_SHA, head: HEAD_SHA },
        runCommand,
      ),
    ).resolves.toBe(false)
    expect(calls).toEqual([
      { file: "git", args: ["cat-file", "-e", `${BASE_SHA}^{commit}`] },
      { file: "git", args: ["cat-file", "-e", `${HEAD_SHA}^{commit}`] },
      {
        file: "git",
        args: ["diff", "--no-renames", "--name-only", "-z", BASE_SHA, HEAD_SHA],
      },
    ])
  })

  test("classifies any relevant changed path", async () => {
    const runCommand: GitCommandRunner = async (_file, args) =>
      commandResult(
        args[0] === "diff"
          ? Buffer.from("docs/unrelated.md\0packages/sandbox/file\nwith-newline.ts\0")
          : undefined,
      )

    await expect(
      classifyKubernetesCompatibilityScope(
        { event: "pull_request", base: BASE_SHA, head: HEAD_SHA },
        runCommand,
      ),
    ).resolves.toBe(true)
  })

  test("requires compatibility when an owned path is renamed out of scope", async () => {
    const repository = await mkdtemp(join(tmpdir(), "dawn-k8s-scope-rename-"))
    temporaryDirectories.push(repository)
    git(repository, ["init", "--quiet"])
    git(repository, ["config", "user.name", "Dawn Scope Test"])
    git(repository, ["config", "user.email", "scope-test@dawn.invalid"])
    git(repository, ["config", "commit.gpgSign", "false"])
    git(repository, ["config", "diff.renames", "true"])

    const ownedPath = join(repository, "test/k8s-smoke/renamed-control.sh")
    const unrelatedDirectory = join(repository, "docs")
    await mkdir(join(repository, "test/k8s-smoke"), { recursive: true })
    await writeFile(ownedPath, "locked compatibility behavior\n")
    git(repository, ["add", "--all"])
    git(repository, ["commit", "--quiet", "--message", "base"])
    const base = git(repository, ["rev-parse", "HEAD"]).toString("utf8").trim()

    await mkdir(unrelatedDirectory)
    await rename(ownedPath, join(unrelatedDirectory, "renamed-control.sh"))
    git(repository, ["add", "--all"])
    git(repository, ["commit", "--quiet", "--message", "rename out of compatibility scope"])
    const head = git(repository, ["rev-parse", "HEAD"]).toString("utf8").trim()
    const collapsedRename = git(repository, ["diff", "--name-only", "-z", base, head])
    expect(parseNulDelimitedGitPaths(collapsedRename)).toEqual(["docs/renamed-control.sh"])

    const runCommand: GitCommandRunner = async (file, args) => {
      if (file !== "git") throw new Error(`Unexpected command: ${file}`)
      return commandResult(git(repository, args))
    }

    await expect(
      classifyKubernetesCompatibilityScope({ event: "pull_request", base, head }, runCommand),
    ).resolves.toBe(true)
  })

  test("classifies an empty pull-request diff as unrelated", async () => {
    const runCommand: GitCommandRunner = async () => commandResult()

    await expect(
      classifyKubernetesCompatibilityScope(
        { event: "pull_request", base: BASE_SHA, head: HEAD_SHA },
        runCommand,
      ),
    ).resolves.toBe(false)
  })

  test.each([
    "",
    "a".repeat(39),
    "a".repeat(41),
    "A".repeat(40),
    "g".repeat(40),
    `${"a".repeat(39)}\n`,
  ])("rejects invalid pull-request SHA %# before invoking Git", async (sha) => {
    const calls: unknown[] = []
    const runCommand: GitCommandRunner = async (file, args) => {
      calls.push({ file, args })
      return commandResult()
    }

    await expect(
      classifyKubernetesCompatibilityScope(
        { event: "pull_request", base: sha, head: HEAD_SHA },
        runCommand,
      ),
    ).rejects.toThrow(/SHA/i)
    expect(calls).toEqual([])
  })

  test.each([
    { event: "pull_request", head: HEAD_SHA },
    { event: "pull_request", base: BASE_SHA },
  ])("rejects a missing pull-request SHA before invoking Git", async (request) => {
    const calls: unknown[] = []
    const runCommand: GitCommandRunner = async (file, args) => {
      calls.push({ file, args })
      return commandResult()
    }

    await expect(classifyKubernetesCompatibilityScope(request, runCommand)).rejects.toThrow(/SHA/i)
    expect(calls).toEqual([])
  })

  test.each(["schedule", "workflow_dispatch"])(
    "%s forces compatibility without invoking Git",
    async (event) => {
      const runCommand: GitCommandRunner = async () => {
        throw new Error("Git must not run")
      }

      await expect(classifyKubernetesCompatibilityScope({ event }, runCommand)).resolves.toBe(true)
    },
  )

  test("rejects unknown event modes without invoking Git", async () => {
    const calls: unknown[] = []
    const runCommand: GitCommandRunner = async (file, args) => {
      calls.push({ file, args })
      return commandResult()
    }

    await expect(
      classifyKubernetesCompatibilityScope({ event: "push" }, runCommand),
    ).rejects.toThrow(/event/i)
    expect(calls).toEqual([])
  })

  test.each([0, 1])("propagates cat-file failure for commit index %i", async (failureIndex) => {
    let callIndex = 0
    const runCommand: GitCommandRunner = async () => {
      const currentIndex = callIndex
      callIndex += 1
      if (currentIndex === failureIndex) {
        throw new Error("cat-file failed")
      }
      return commandResult()
    }

    await expect(
      classifyKubernetesCompatibilityScope(
        { event: "pull_request", base: BASE_SHA, head: HEAD_SHA },
        runCommand,
      ),
    ).rejects.toThrow("cat-file failed")
  })

  test("propagates diff command failure", async () => {
    let callIndex = 0
    const runCommand: GitCommandRunner = async () => {
      callIndex += 1
      if (callIndex === 3) {
        throw new Error("diff failed")
      }
      return commandResult()
    }

    await expect(
      classifyKubernetesCompatibilityScope(
        { event: "pull_request", base: BASE_SHA, head: HEAD_SHA },
        runCommand,
      ),
    ).rejects.toThrow("diff failed")
  })

  test("rejects malformed diff output", async () => {
    const runCommand: GitCommandRunner = async (_file, args) =>
      commandResult(args[0] === "diff" ? Buffer.from("unterminated") : undefined)

    await expect(
      classifyKubernetesCompatibilityScope(
        { event: "pull_request", base: BASE_SHA, head: HEAD_SHA },
        runCommand,
      ),
    ).rejects.toThrow(/malformed/i)
  })
})

describe("compatibility aggregation", () => {
  test("accepts the unrelated pull-request result", () => {
    expect(aggregateCompatibility({ required: false, scope: "success", compat: "skipped" })).toBe(
      true,
    )
  })

  test("accepts successful required compatibility", () => {
    expect(aggregateCompatibility({ required: true, scope: "success", compat: "success" })).toBe(
      true,
    )
  })

  test.each(["failure", "cancelled", "skipped", undefined])(
    "rejects required compatibility status %#",
    (compat) => {
      expect(aggregateCompatibility({ required: true, scope: "success", compat })).toBe(false)
    },
  )

  test.each(["failure", "cancelled", "skipped", undefined])(
    "rejects failed or missing scope status %#",
    (scope) => {
      expect(aggregateCompatibility({ required: false, scope, compat: "skipped" })).toBe(false)
    },
  )

  test.each(["true", 1, null, undefined])(
    "fails closed for malformed required value %#",
    (required) => {
      expect(aggregateCompatibility({ required, scope: "success", compat: "success" })).toBe(false)
    },
  )

  test.each(["SUCCESS", "timed_out", true, null])(
    "fails closed for malformed scope status %#",
    (scope) => {
      expect(aggregateCompatibility({ required: true, scope, compat: "success" })).toBe(false)
    },
  )

  test.each(["SUCCESS", "timed_out", true, null, undefined])(
    "fails closed for malformed compatibility status %#",
    (compat) => {
      expect(aggregateCompatibility({ required: false, scope: "success", compat })).toBe(false)
    },
  )
})

describe("workflow matrix", () => {
  test("contains only deterministic lower and upper entries", async () => {
    const policy = await loadCompatibilityPolicy()
    const lower = targetByRole(policy, "lower")
    const upper = targetByRole(policy, "upper")

    expect(createCompatibilityMatrix(policy)).toEqual({
      include: [
        {
          target: lower.minor,
          version: lower.version,
          nodeImage: lower.nodeImage,
          clusterName: "dawn-k8s-lower",
        },
        {
          target: upper.minor,
          version: upper.version,
          nodeImage: upper.nodeImage,
          clusterName: "dawn-k8s-upper",
        },
      ],
    })
  })

  test("rejects malformed policies", () => {
    expect(() => createCompatibilityMatrix({ schemaVersion: 1 })).toThrow(/policy/i)
  })

  test("rejects unknown target roles", async () => {
    const policy = await loadCompatibilityPolicy()
    const unknownRolePolicy = {
      ...policy,
      targets: policy.targets.map((target, index) =>
        index === 0 ? { ...target, role: "unexpected" } : target,
      ),
    }

    expect(() => createCompatibilityMatrix(unknownRolePolicy)).toThrow(/role/i)
  })
})

describe("workflow CLI", () => {
  test("writes only the pull-request scope boolean to stdout", async () => {
    let stdout = ""
    const runCommand: GitCommandRunner = async (_file, args) =>
      commandResult(args[0] === "diff" ? Buffer.from("packages/sandbox/src/index.ts\0") : undefined)

    await runWorkflowCli(
      ["scope", "--event", "pull_request", "--base", BASE_SHA, "--head", HEAD_SHA],
      {
        runCommand,
        writeStdout: (chunk) => {
          stdout += chunk
        },
      },
    )

    expect(stdout).toBe("true\n")
  })

  test.each(["schedule", "workflow_dispatch"])(
    "writes true for %s without invoking Git",
    async (event) => {
      let stdout = ""
      const runCommand: GitCommandRunner = async () => {
        throw new Error("Git must not run")
      }

      await runWorkflowCli(["scope", "--event", event], {
        runCommand,
        writeStdout: (chunk) => {
          stdout += chunk
        },
      })

      expect(stdout).toBe("true\n")
    },
  )

  test("writes compact lower and upper matrix JSON to stdout", async () => {
    const policy = await loadCompatibilityPolicy()
    let stdout = ""

    await runWorkflowCli(["matrix"], {
      loadPolicy: async () => policy,
      writeStdout: (chunk) => {
        stdout += chunk
      },
    })

    expect(stdout).toBe(`${JSON.stringify(createCompatibilityMatrix(policy))}\n`)
    expect(stdout.trim()).not.toMatch(/\n|\s{2}/)
  })

  test("prepares Calico through the validated policy dependency", async () => {
    const policy = await loadCompatibilityPolicy()
    const calls: { readonly outputPath: string; readonly policy: unknown }[] = []
    let stdout = ""

    await runWorkflowCli(["prepare-calico", "--output", "/tmp/calico local.yaml"], {
      loadPolicy: async () => policy,
      prepareCalico: async (outputPath, calicoPolicy) => {
        calls.push({ outputPath, policy: calicoPolicy })
      },
      writeStdout: (chunk) => {
        stdout += chunk
      },
    })

    expect(calls).toEqual([{ outputPath: "/tmp/calico local.yaml", policy: policy.calico }])
    expect(stdout).toBe("")
  })

  test.each([
    ["scope", "--event", "schedule", "--event", "schedule"],
    ["scope", "--unknown", "value"],
    ["scope", "--event"],
    ["scope", "schedule"],
    ["scope", "--event", "schedule", "extra"],
    ["scope", "--event", "schedule", "--base", BASE_SHA],
    ["matrix", "extra"],
    ["matrix", "--event", "schedule"],
    ["prepare-calico", "--output"],
    ["prepare-calico", "--output", "one", "two"],
    ["unknown-operation"],
    [],
  ])("rejects malformed arguments %#", async (...args) => {
    await expect(runWorkflowCli(args)).rejects.toThrow()
  })

  test("rejects missing pull-request SHAs", async () => {
    await expect(
      runWorkflowCli(["scope", "--event", "pull_request", "--base", BASE_SHA]),
    ).rejects.toThrow(/SHA|head/i)
  })

  test("rejects unknown event modes", async () => {
    await expect(runWorkflowCli(["scope", "--event", "push"])).rejects.toThrow(/event/i)
  })

  test("rejects malformed loaded policies without writing stdout", async () => {
    let stdout = ""

    await expect(
      runWorkflowCli(["matrix"], {
        loadPolicy: async () => ({ schemaVersion: 1 }),
        writeStdout: (chunk) => {
          stdout += chunk
        },
      }),
    ).rejects.toThrow(/policy/i)
    expect(stdout).toBe("")
  })

  test("rejects unknown loaded target roles", async () => {
    const policy = await loadCompatibilityPolicy()
    const unknownRolePolicy = {
      ...policy,
      targets: policy.targets.map((target, index) =>
        index === 2 ? { ...target, role: "future" } : target,
      ),
    }

    await expect(
      runWorkflowCli(["matrix"], { loadPolicy: async () => unknownRolePolicy }),
    ).rejects.toThrow(/role/i)
  })

  test("does not access or write a GitHub output file for stdout operations", async () => {
    const workflowSource = await readFile(
      join(REPO_ROOT, "scripts/kubernetes-compat/workflow.ts"),
      "utf8",
    )
    expect(workflowSource).not.toContain("GITHUB_OUTPUT")

    const directory = await mkdtemp(join(tmpdir(), "dawn-k8s-workflow-output-"))
    temporaryDirectories.push(directory)
    const githubOutputPath = join(directory, "output with spaces")
    await writeFile(githubOutputPath, "sentinel\n")
    const outputEnvironmentKey = ["GITHUB", "OUTPUT"].join("_")
    const original = Reflect.get(process.env, outputEnvironmentKey) as string | undefined
    Reflect.set(process.env, outputEnvironmentKey, githubOutputPath)

    try {
      let stdout = ""
      await runWorkflowCli(["scope", "--event", "schedule"], {
        writeStdout: (chunk) => {
          stdout += chunk
        },
      })
      await runWorkflowCli(["matrix"], {
        writeStdout: (chunk) => {
          stdout += chunk
        },
      })
      expect(stdout.startsWith("true\n{")).toBe(true)
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(process.env, outputEnvironmentKey)
      } else {
        Reflect.set(process.env, outputEnvironmentKey, original)
      }
    }

    await expect(readFile(githubOutputPath, "utf8")).resolves.toBe("sentinel\n")
  })
})
