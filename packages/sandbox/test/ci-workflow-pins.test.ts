import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { parse } from "yaml"

const checkoutAction = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
const pnpmSetupAction = "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271"
const nodeSetupAction = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"
const helmSetupAction = "azure/setup-helm@9bc31f4ebc9c6b171d7bfbaa5d006ae7abdb4310"
const kindAction = "helm/kind-action@ef37e7f390d99f746eb8b610417061a60e82a6cc"
const uploadArtifactAction = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"

function githubExpression(expression: string): string {
  return `\${{ ${expression} }}`
}

const vercelArtifactDirectory = `${githubExpression("runner.temp")}/vercel-native`
const protectedVercelEnvironment = {
  DAWN_VERCEL_DATABASE_URL: githubExpression("secrets.DAWN_VERCEL_DATABASE_URL"),
  DAWN_VERCEL_ORG_ID: githubExpression("secrets.DAWN_VERCEL_ORG_ID"),
  DAWN_VERCEL_PROJECT_ID: githubExpression("secrets.DAWN_VERCEL_PROJECT_ID"),
  DAWN_VERCEL_TOKEN: githubExpression("secrets.DAWN_VERCEL_TOKEN"),
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`)
  }
  return value
}

function requireSteps(job: Record<string, unknown>, label: string): Record<string, unknown>[] {
  if (!Array.isArray(job.steps) || job.steps.some((step) => !isRecord(step))) {
    throw new Error(`Expected ${label}.steps to be an array of objects`)
  }
  return job.steps
}

function requireNamedStep(
  steps: readonly Record<string, unknown>[],
  name: string,
): Record<string, unknown> {
  const matches = steps.filter((step) => step.name === name)
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(`Expected exactly one ${name} step`)
  }
  return matches[0]
}

function normalizedExpression(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Expected workflow expression to be a string")
  }
  return value.replace(/\s+/g, " ").trim()
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings)
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap(collectStrings)
  }
  return []
}

const ciWorkflow = readFileSync(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
)
const policy = requireRecord(
  JSON.parse(
    readFileSync(
      new URL("../../../.github/kubernetes-compatibility.json", import.meta.url),
      "utf8",
    ),
  ),
  "Kubernetes compatibility policy",
)
const toolchain = requireRecord(policy.toolchain, "policy.toolchain")
const images = requireRecord(policy.images, "policy.images")
if (!Array.isArray(policy.targets)) {
  throw new Error("Expected policy.targets to be an array")
}
const canonicalTarget = policy.targets.find(
  (target): target is Record<string, unknown> => isRecord(target) && target.role === "canonical",
)
if (canonicalTarget === undefined) {
  throw new Error("Expected one canonical Kubernetes target")
}
const chartValues = readFileSync(
  new URL("../../../charts/dawn-sandbox-infra/values.yaml", import.meta.url),
  "utf8",
)

describe("Kubernetes CI dependency pins", () => {
  test("runs the canonical sandbox harness with policy-pinned tools", () => {
    const workflow = requireRecord(parse(ciWorkflow), "CI workflow")
    const jobs = requireRecord(workflow.jobs, "CI workflow jobs")
    const sandboxJob = requireRecord(jobs["sandbox-k8s"], "jobs.sandbox-k8s")
    const steps = requireSteps(sandboxJob, "jobs.sandbox-k8s")

    expect(requireNamedStep(steps, "Setup pnpm").with).toEqual({ version: toolchain.pnpm })
    expect(requireNamedStep(steps, "Setup Node.js").with).toEqual({
      "node-version": toolchain.node,
      cache: "pnpm",
    })
    expect(requireNamedStep(steps, "Setup Helm").with).toEqual({ version: toolchain.helm })
    expect(requireNamedStep(steps, "Run Kubernetes 1.35 compatibility harness").run).toBe(
      `pnpm verify:k8s:compat -- --target ${String(canonicalTarget.minor)} --context "$DAWN_TEST_K8S_CONTEXT"`,
    )
  })

  test("uses the exact canonical Kind action, clients, node image, and contexts", () => {
    const workflow = requireRecord(parse(ciWorkflow), "CI workflow")
    const jobs = requireRecord(workflow.jobs, "CI workflow jobs")
    const expected = [
      ["sandbox-k8s", "dawn-k8s-canonical", true],
      ["sandbox-k8s-e2e", "dawn-smoke", true],
      ["chart-apply-smoke", "dawn-chart-apply", false],
    ] as const

    for (const [jobId, clusterName, useCalicoConfig] of expected) {
      const job = requireRecord(jobs[jobId], `jobs.${jobId}`)
      const steps = requireSteps(job, `jobs.${jobId}`)
      const kind = requireNamedStep(steps, "Create kind cluster")
      const helm = requireNamedStep(steps, "Setup Helm")
      expect(kind.uses).toBe(kindAction)
      expect(kind.with).toEqual({
        version: toolchain.kind,
        kubectl_version: toolchain.kubectl,
        node_image: canonicalTarget.nodeImage,
        ...(useCalicoConfig ? { config: ".github/kind/kind-calico.yaml" } : {}),
        cluster_name: clusterName,
      })
      expect(helm.uses).toBe(helmSetupAction)
      expect(helm.with).toEqual({ version: toolchain.helm })
      expect(requireRecord(job.env, `jobs.${jobId}.env`).DAWN_TEST_K8S_CONTEXT).toBe(
        `kind-${clusterName}`,
      )
    }
  })

  test("prepares Calico through the checked-in checksum and rewrite helper", () => {
    const workflow = requireRecord(parse(ciWorkflow), "CI workflow")
    const jobs = requireRecord(workflow.jobs, "CI workflow jobs")
    for (const jobId of ["sandbox-k8s", "sandbox-k8s-e2e"]) {
      const steps = requireSteps(requireRecord(jobs[jobId], `jobs.${jobId}`), `jobs.${jobId}`)
      const prepare = requireNamedStep(steps, "Prepare verified Calico manifest")
      const install = requireNamedStep(steps, "Install verified Calico")
      expect(prepare.run).toContain("scripts/kubernetes-compat/workflow.ts prepare-calico")
      expect(install.run).not.toMatch(/https?:\/\//)
      expect(install.run).toContain('--filename "$CALICO_MANIFEST"')
    }
  })

  test("reconstructs the chart reaper image exactly from the policy pin", () => {
    const values = requireRecord(parse(chartValues), "chart values")
    const reaper = requireRecord(values.reaper, "chart values.reaper")
    const reaperImage = String(reaper.image)
    const match = /^(?<repository>[^\s@]+):(?<tag>[^\s:@]+)@(?<digest>sha256:[0-9a-f]{64})$/.exec(
      reaperImage,
    )
    expect(match?.groups).toBeDefined()
    expect(
      `${String(match?.groups?.repository)}:${String(match?.groups?.tag)}@${String(match?.groups?.digest)}`,
    ).toBe(images.reaper)
  })

  test("loads the sandbox workload policy image in both Docker-gated lanes", () => {
    const workflow = requireRecord(parse(ciWorkflow), "CI workflow")
    const jobs = requireRecord(workflow.jobs, "CI workflow jobs")
    for (const jobId of ["sandbox-docker", "sandbox-docker-e2e"]) {
      const steps = requireSteps(requireRecord(jobs[jobId], `jobs.${jobId}`), `jobs.${jobId}`)
      const pull = requireNamedStep(steps, "Pull sandbox workload image")
      expect(pull.run).toContain("loadCompatibilityPolicy")
      expect(pull.run).toContain("policy.images.sandboxWorkload")
      expect(pull.run).not.toContain("node:22-slim")
    }
  })

  test("preloads the Kubernetes sandbox image through the node CRI", () => {
    const workflow = requireRecord(parse(ciWorkflow), "CI workflow")
    const jobs = requireRecord(workflow.jobs, "CI workflow jobs")
    const steps = requireSteps(
      requireRecord(jobs["sandbox-k8s-e2e"], "jobs.sandbox-k8s-e2e"),
      "jobs.sandbox-k8s-e2e",
    )
    const preload = requireNamedStep(steps, "Preload sandbox workload image into kind")
    const run = String(preload.run)

    expect(run).toContain("policy.images.sandboxWorkload")
    expect(run).toContain('crictl pull "$SANDBOX_IMAGE"')
    expect(run).toContain('crictl inspecti "$SANDBOX_IMAGE"')
    expect(run).not.toContain("kind load docker-image")
    expect(run).not.toContain('docker pull "$SANDBOX_IMAGE"')
  })

  test("describes sandbox Pods before full-arc e2e teardown", () => {
    const workflow = requireRecord(parse(ciWorkflow), "CI workflow")
    const jobs = requireRecord(workflow.jobs, "CI workflow jobs")
    const steps = requireSteps(
      requireRecord(jobs["sandbox-k8s-e2e"], "jobs.sandbox-k8s-e2e"),
      "jobs.sandbox-k8s-e2e",
    )
    const diagnostics = requireNamedStep(steps, "Diagnostics + cleanup")
    const run = String(diagnostics.run)
    const describeIndex = run.indexOf(
      "-n dawn-sandboxes describe pods -l app.kubernetes.io/managed-by=dawn",
    )
    const teardownIndex = run.indexOf('echo "----- teardown -----"')

    expect(describeIndex).toBeGreaterThan(-1)
    expect(teardownIndex).toBeGreaterThan(describeIndex)
  })
})

describe("native Vercel job", () => {
  test("keeps credentials protected while testing source and prebuilt previews", () => {
    const workflow = requireRecord(parse(ciWorkflow), "CI workflow")
    const jobs = requireRecord(workflow.jobs, "CI workflow jobs")
    const nativeJob = requireRecord(jobs["vercel-native"], "jobs.vercel-native")
    const steps = requireSteps(nativeJob, "jobs.vercel-native")

    expect(workflow.permissions).toEqual({ contents: "read" })
    expect(normalizedExpression(nativeJob.if)).toBe(
      "(github.event_name == 'push' && github.ref == 'refs/heads/main') || " +
        "(github.event_name == 'pull_request' && " +
        "github.event.pull_request.head.repo.full_name == github.repository)",
    )
    expect(nativeJob["runs-on"]).toBe("ubuntu-latest")
    expect(nativeJob["timeout-minutes"]).toBe(45)
    expect(nativeJob.environment).toBe("vercel-preview")
    expect(nativeJob.env).toBeUndefined()
    expect(nativeJob.permissions).toBeUndefined()

    const checkout = requireNamedStep(steps, "Checkout")
    const setupPnpm = requireNamedStep(steps, "Setup pnpm")
    const setupNode = requireNamedStep(steps, "Setup Node.js")
    const install = requireNamedStep(steps, "Install")
    const build = requireNamedStep(steps, "Build packages")
    const prepareDirectory = requireNamedStep(steps, "Prepare native Vercel artifact directory")
    const nativeTest = requireNamedStep(steps, "Run native Vercel previews")
    const cleanup = requireNamedStep(steps, "Reconcile and remove native Vercel resources")
    const receiptAssertion = requireNamedStep(steps, "Assert closed native Vercel receipt")
    const diagnostics = requireNamedStep(steps, "Prepare native Vercel diagnostics")
    const upload = requireNamedStep(steps, "Upload native Vercel diagnostics")

    expect(steps.map((step) => step.name)).toEqual([
      "Checkout",
      "Setup pnpm",
      "Setup Node.js",
      "Install",
      "Build packages",
      "Prepare native Vercel artifact directory",
      "Run native Vercel previews",
      "Reconcile and remove native Vercel resources",
      "Assert closed native Vercel receipt",
      "Prepare native Vercel diagnostics",
      "Upload native Vercel diagnostics",
    ])
    expect(steps.filter((step) => step.uses !== undefined).map((step) => step.uses)).toEqual([
      checkoutAction,
      pnpmSetupAction,
      nodeSetupAction,
      uploadArtifactAction,
    ])
    expect(checkout.uses).toBe(checkoutAction)
    expect(checkout.with).toBeUndefined()
    expect(setupPnpm.uses).toBe(pnpmSetupAction)
    expect(setupPnpm.with).toEqual({ version: "10.33.0" })
    expect(setupNode.uses).toBe(nodeSetupAction)
    expect(setupNode.with).toEqual({
      cache: "pnpm",
      "node-version": "24.17.0",
    })
    expect(install.run).toBe("pnpm install --frozen-lockfile")
    expect(build.run).toBe("pnpm build")
    expect(prepareDirectory.run).toBe(`install -d -m 0700 -- "${vercelArtifactDirectory}"`)

    const indexes = [
      checkout,
      setupPnpm,
      setupNode,
      install,
      build,
      prepareDirectory,
      nativeTest,
      cleanup,
      receiptAssertion,
      diagnostics,
      upload,
    ].map((step) => steps.indexOf(step))
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right))
    expect(steps.indexOf(cleanup)).toBe(steps.indexOf(nativeTest) + 1)

    const nativeTestEnvironment = {
      ...protectedVercelEnvironment,
      DAWN_TEST_VERCEL: "1",
      DAWN_VERCEL_ARTIFACT_DIR: vercelArtifactDirectory,
    }
    const cleanupEnvironment = {
      ...protectedVercelEnvironment,
      DAWN_VERCEL_ARTIFACT_DIR: vercelArtifactDirectory,
    }
    const receiptEnvironment = {
      DAWN_VERCEL_ARTIFACT_DIR: vercelArtifactDirectory,
    }

    expect(nativeTest.id).toBe("native-vercel")
    expect(nativeTest.env).toEqual(nativeTestEnvironment)
    expect(normalizedExpression(nativeTest.run)).toBe(
      "pnpm --filter @dawn-ai/cli test vercel-native-lane.test.ts " +
        "--reporter=json " +
        `--outputFile.json="${vercelArtifactDirectory}/vitest.json"`,
    )
    expect(nativeTest.if).toBeUndefined()

    expect(cleanup.id).toBe("native-vercel-cleanup")
    expect(cleanup.if).toBe("always()")
    expect(cleanup.env).toEqual(cleanupEnvironment)
    expect(cleanup.run).toBe("node packages/cli/test/helpers/vercel-native-cleanup.mjs --cleanup")

    expect(receiptAssertion.env).toEqual(receiptEnvironment)
    expect(receiptAssertion.if).toBeUndefined()
    expect(receiptAssertion.run).toBe(
      "node packages/cli/test/helpers/vercel-native-cleanup.mjs --assert-receipt",
    )

    expect(diagnostics.id).toBe("native_vercel_diagnostics")
    expect(diagnostics.if).toBe("always()")
    expect(diagnostics.env).toEqual(cleanupEnvironment)
    expect(diagnostics.run).toBe(
      "node packages/cli/test/helpers/vercel-native-cleanup.mjs --prepare-artifacts",
    )

    expect(upload.uses).toBe(uploadArtifactAction)
    expect(normalizedExpression(upload.if)).toBe(
      "failure() && steps.native_vercel_diagnostics.outcome == 'success'",
    )
    expect(upload.env).toBeUndefined()
    expect(upload.with).toEqual({
      "if-no-files-found": "error",
      name: "vercel-native-diagnostics",
      path: `${vercelArtifactDirectory}/upload/`,
      "retention-days": 3,
    })

    for (const step of steps) {
      expect(step["continue-on-error"]).toBeUndefined()
    }
    const secretContextReference = /\bsecrets\s*(?:\.|\[)/
    for (const [stepIndex, step] of steps.entries()) {
      for (const field of ["run", "with", "argv"] as const) {
        expect(
          collectStrings(step[field]).filter((value) => secretContextReference.test(value)),
          `jobs.vercel-native.steps[${stepIndex}].${field} must not receive secrets`,
        ).toEqual([])
      }
    }

    const permittedStepEnvironment = new Map<Record<string, unknown>, Record<string, unknown>>([
      [nativeTest, nativeTestEnvironment],
      [cleanup, cleanupEnvironment],
      [receiptAssertion, receiptEnvironment],
      [diagnostics, cleanupEnvironment],
    ])
    const relevantEnvironment = (env: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(env).filter(
          ([name, value]) =>
            name === "DAWN_TEST_VERCEL" ||
            name.startsWith("DAWN_VERCEL_") ||
            (typeof value === "string" && secretContextReference.test(value)),
        ),
      )

    expect(relevantEnvironment(requireRecord(workflow.env ?? {}, "workflow env"))).toEqual({})
    for (const [jobName, value] of Object.entries(jobs)) {
      const job = requireRecord(value, `jobs.${jobName}`)
      expect(relevantEnvironment(requireRecord(job.env ?? {}, `jobs.${jobName}.env`))).toEqual({})
      for (const [stepIndex, step] of requireSteps(job, `jobs.${jobName}`).entries()) {
        const actual = relevantEnvironment(
          requireRecord(step.env ?? {}, `jobs.${jobName}.steps[${stepIndex}].env`),
        )
        expect(actual).toEqual(permittedStepEnvironment.get(step) ?? {})
      }
    }

    const allowedSecretReferences = new Set(Object.values(protectedVercelEnvironment))
    const allSecretReferences = collectStrings(workflow).filter((value) =>
      secretContextReference.test(value),
    )
    expect(allSecretReferences.every((value) => allowedSecretReferences.has(value))).toBe(true)
    expect(
      Object.fromEntries(
        [...allowedSecretReferences].map((reference) => [
          reference,
          allSecretReferences.filter((value) => value === reference).length,
        ]),
      ),
    ).toEqual(Object.fromEntries([...allowedSecretReferences].map((reference) => [reference, 3])))
  })
})
