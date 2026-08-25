import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, test } from "vitest"
import { parse } from "yaml"

import {
  type CompatibilityPolicy,
  validateCompatibilityPolicy,
} from "../../scripts/kubernetes-compat/policy.ts"

const checkoutAction = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
const nodeSetupAction = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"
const pnpmSetupAction = "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271"
const helmSetupAction = "azure/setup-helm@9bc31f4ebc9c6b171d7bfbaa5d006ae7abdb4310"
const kindAction = "helm/kind-action@ef37e7f390d99f746eb8b610417061a60e82a6cc"
const uploadArtifactAction = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
const fullActionPin = /^[^@\s]+@[0-9a-f]{40}$/

const repoRoot = process.cwd()
const compatibilityWorkflowPath = resolve(repoRoot, ".github/workflows/kubernetes-compat.yml")
const ciWorkflowPath = resolve(repoRoot, ".github/workflows/ci.yml")
const policyPath = resolve(repoRoot, ".github/kubernetes-compatibility.json")

const compatibilityWorkflowSource = existsSync(compatibilityWorkflowPath)
  ? readFileSync(compatibilityWorkflowPath, "utf8")
  : ""
const ciWorkflowSource = readFileSync(ciWorkflowPath, "utf8")
const compatibilityWorkflow = parseWorkflow(compatibilityWorkflowSource)
const ciWorkflow = parseWorkflow(ciWorkflowSource)
const policy = validateCompatibilityPolicy(JSON.parse(readFileSync(policyPath, "utf8")))

function githubExpression(expression: string): string {
  return `\${{ ${expression} }}`
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

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${label} to be a string`)
  }
  return value
}

function parseWorkflow(source: string): Record<string, unknown> {
  const parsed: unknown = parse(source)
  return isRecord(parsed) ? parsed : {}
}

function requireJobs(workflow: Record<string, unknown>, label: string): Record<string, unknown> {
  return requireRecord(workflow.jobs, `${label}.jobs`)
}

function requireJob(
  workflow: Record<string, unknown>,
  id: string,
  label = "workflow",
): Record<string, unknown> {
  return requireRecord(requireJobs(workflow, label)[id], `${label}.jobs.${id}`)
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
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`Expected exactly one workflow step named ${name}`)
  }
  return matches[0]
}

function requirePolicyTarget(
  role: CompatibilityPolicy["targets"][number]["role"],
): CompatibilityPolicy["targets"][number] {
  const target = policy.targets.find((candidate) => candidate.role === role)
  if (target === undefined) {
    throw new Error(`Compatibility policy is missing the ${role} target`)
  }
  return target
}

function normalizedExpression(value: unknown): string {
  return requireString(value, "workflow expression").replace(/\s+/g, " ").trim()
}

function actionSteps(workflow: Record<string, unknown>): Record<string, unknown>[] {
  return Object.entries(requireJobs(workflow, "workflow")).flatMap(([id, job]) =>
    requireSteps(requireRecord(job, `jobs.${id}`), `jobs.${id}`).filter(
      (step) => typeof step.uses === "string",
    ),
  )
}

function assertPolicyToolchain(
  steps: readonly Record<string, unknown>[],
  options: { readonly helm?: boolean } = {},
): void {
  const pnpm = requireNamedStep(steps, "Setup pnpm")
  const node = requireNamedStep(steps, "Setup Node.js")
  expect(pnpm.uses).toBe(pnpmSetupAction)
  expect(pnpm.with).toEqual({ version: policy.toolchain.pnpm })
  expect(node.uses).toBe(nodeSetupAction)
  expect(node.with).toEqual({
    cache: "pnpm",
    "node-version": policy.toolchain.node,
  })

  if (options.helm === true) {
    const helm = requireNamedStep(steps, "Setup Helm")
    expect(helm.uses).toBe(helmSetupAction)
    expect(helm.with).toEqual({ version: policy.toolchain.helm })
  }
}

function assertCanonicalKindStep(
  steps: readonly Record<string, unknown>[],
  clusterName: string,
  useCalicoConfig = true,
): void {
  const canonical = requirePolicyTarget("canonical")
  expect(requireNamedStep(steps, "Prime kind tool cache").run).toBe(
    `scripts/prime-kind-cache.sh ${policy.toolchain.kind} ${policy.toolchain.kubectl}`,
  )
  const kind = requireNamedStep(steps, "Create kind cluster")
  expect(kind.uses).toBe(kindAction)
  expect(kind.with).toEqual({
    version: policy.toolchain.kind,
    kubectl_version: policy.toolchain.kubectl,
    node_image: canonical.nodeImage,
    ...(useCalicoConfig ? { config: ".github/kind/kind-calico.yaml" } : {}),
    cluster_name: clusterName,
  })
}

function activeShellLines(source: string): string[] {
  return source
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
}

function assertExplicitKubernetesContexts(
  steps: readonly Record<string, unknown>[],
  label: string,
): void {
  for (const step of steps) {
    if (typeof step.run !== "string") continue
    for (const line of activeShellLines(step.run)) {
      if (/(^|[;&|()]\s*|!\s+)kubectl\s/.test(line)) {
        expect(line, `${label}: ${String(step.name)}`).toContain(
          'kubectl --context "$DAWN_TEST_K8S_CONTEXT"',
        )
      }
      if (/(^|[;&|()]\s*|!\s+)helm\s/.test(line)) {
        expect(line, `${label}: ${String(step.name)}`).toContain(
          'helm --kube-context "$DAWN_TEST_K8S_CONTEXT"',
        )
      }
    }
  }
}

function assertVerifiedCalicoSteps(steps: readonly Record<string, unknown>[]): void {
  const prepare = requireNamedStep(steps, "Prepare verified Calico manifest")
  const install = requireNamedStep(steps, "Install verified Calico")
  const expectedManifest = `${githubExpression("runner.temp")}/dawn-calico.yaml`

  expect(prepare.env).toEqual({ CALICO_MANIFEST: expectedManifest })
  expect(prepare.run).toBe(
    'pnpm exec tsx scripts/kubernetes-compat/workflow.ts prepare-calico --output "$CALICO_MANIFEST"',
  )
  expect(install.env).toEqual({ CALICO_MANIFEST: expectedManifest })
  const installRun = requireString(install.run, "Install verified Calico.run")
  expect(installRun).toContain(
    'kubectl --context "$DAWN_TEST_K8S_CONTEXT" apply --filename "$CALICO_MANIFEST"',
  )
  expect(installRun).not.toMatch(/https?:\/\//)
  expect(installRun.match(/\bapply\b/g)).toHaveLength(1)
}

function assertConcurrencyFailsClosed(workflow: Record<string, unknown>): void {
  const concurrency = requireRecord(workflow.concurrency, "workflow.concurrency")
  const group = requireString(concurrency.group, "workflow.concurrency.group")
  const cancel = normalizedExpression(concurrency["cancel-in-progress"])
  const expectedGroup = `kubernetes-compat-${githubExpression(
    "github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('{0}-{1}', github.event_name, github.run_id)",
  )}`

  if (normalizedExpression(group) !== expectedGroup) {
    throw new Error("Concurrency must separate PR numbers from invocation-unique run IDs")
  }
  if (cancel !== githubExpression("github.event_name == 'pull_request'")) {
    throw new Error("Only pull-request runs may cancel in progress")
  }
}

function splitPinnedImage(reference: string): {
  readonly repository: string
  readonly tag: string
  readonly digest: string
} {
  const match = /^(?<repository>[^\s@]+):(?<tag>[^\s:@]+)@(?<digest>sha256:[0-9a-f]{64})$/.exec(
    reference,
  )
  if (match?.groups === undefined) {
    throw new Error(`Expected a repository:tag@sha256 image, received ${reference}`)
  }
  return {
    repository: match.groups.repository ?? "",
    tag: match.groups.tag ?? "",
    digest: match.groups.digest ?? "",
  }
}

const mutableFixturePatterns = [
  /(?:docker\.io\/library\/)?node:22-slim(?!@sha256:[0-9a-f]{64})/,
  /nginxinc\/nginx-unprivileged:stable-alpine(?!@sha256:[0-9a-f]{64})/,
  /curlimages\/curl:8\.10\.1(?!@sha256:[0-9a-f]{64})/,
  /registry\.k8s\.io\/pause:3\.10(?!@sha256:[0-9a-f]{64})/,
  /kindest\/node:v\d+\.\d+\.\d+(?!@sha256:[0-9a-f]{64})/,
]

function assertNoMutableFixtureImages(source: string): void {
  for (const pattern of mutableFixturePatterns) {
    if (pattern.test(source)) {
      throw new Error(`Found mutable fixture image matching ${String(pattern)}`)
    }
  }
}

describe("dedicated Kubernetes compatibility workflow", () => {
  test("exists, parses as YAML, and has only the three required jobs", () => {
    expect(compatibilityWorkflowSource).not.toBe("")
    expect(
      Object.keys(requireJobs(compatibilityWorkflow, "compatibility workflow")).sort(),
    ).toEqual(["compat", "kubernetes-compat", "scope"])
  })

  test("uses only PR, nightly, and manual read-only triggers without path filters", () => {
    const on = requireRecord(compatibilityWorkflow.on, "workflow.on")
    expect(Object.keys(on).sort()).toEqual(["pull_request", "schedule", "workflow_dispatch"])
    expect(compatibilityWorkflow.permissions).toEqual({ contents: "read" })

    const pullRequest = on.pull_request
    expect(pullRequest === null || isRecord(pullRequest)).toBe(true)
    if (isRecord(pullRequest)) {
      expect(pullRequest.paths).toBeUndefined()
      expect(pullRequest["paths-ignore"]).toBeUndefined()
    }
    expect(on.workflow_dispatch === null || isRecord(on.workflow_dispatch)).toBe(true)
    expect(on.schedule).toEqual([{ cron: expect.stringMatching(/^\d+ \d+ \* \* \*$/) }])
  })

  test("separates pull-request cancellation from invocation-unique scheduled/manual runs", () => {
    expect(() => assertConcurrencyFailsClosed(compatibilityWorkflow)).not.toThrow()
  })

  test("rejects missing, branch-only, and over-broad concurrency contracts", () => {
    for (const concurrency of [
      undefined,
      {
        group: `kubernetes-compat-${githubExpression("github.ref")}`,
        "cancel-in-progress": githubExpression("github.event_name == 'pull_request'"),
      },
      {
        group: `kubernetes-compat-${githubExpression("github.event.pull_request.number")}-${githubExpression("github.run_id")}`,
        "cancel-in-progress": true,
      },
    ]) {
      expect(() =>
        assertConcurrencyFailsClosed({ ...compatibilityWorkflow, concurrency }),
      ).toThrow()
    }
  })

  test("pins every action reference to a full commit", () => {
    const uses = actionSteps(compatibilityWorkflow).map((step) => step.uses)
    expect(uses.length).toBeGreaterThan(0)
    for (const reference of uses) {
      expect(reference).toEqual(expect.stringMatching(fullActionPin))
    }
  })

  test("computes trusted compact scope and endpoint matrix outputs", () => {
    const scope = requireJob(compatibilityWorkflow, "scope", "compatibility workflow")
    const steps = requireSteps(scope, "jobs.scope")
    expect(scope.outputs).toEqual({
      required: githubExpression("steps.policy.outputs.required"),
      matrix: githubExpression("steps.policy.outputs.matrix"),
    })

    const checkout = requireNamedStep(steps, "Checkout")
    expect(checkout.uses).toBe(checkoutAction)
    expect(checkout.with).toEqual({ "fetch-depth": 0 })
    assertPolicyToolchain(steps)
    expect(requireNamedStep(steps, "Install").run).toBe("pnpm install --frozen-lockfile")

    const classify = requireNamedStep(steps, "Compute compatibility scope")
    expect(classify.id).toBe("policy")
    expect(classify.env).toEqual({
      EVENT_NAME: githubExpression("github.event_name"),
      BASE_SHA: githubExpression("github.event.pull_request.base.sha"),
      HEAD_SHA: githubExpression("github.event.pull_request.head.sha"),
    })
    const run = requireString(classify.run, "scope classifier run")
    expect(run).not.toContain("${{")
    expect(run).toContain('scope --event pull_request --base "$BASE_SHA" --head "$HEAD_SHA"')
    expect(run).toContain("schedule|workflow_dispatch)")
    expect(run).toContain('scope --event "$EVENT_NAME"')
    expect(run).toContain("scripts/kubernetes-compat/workflow.ts matrix")
    expect(run).toContain('>> "$GITHUB_OUTPUT"')
    expect(run).not.toMatch(/fromJSON|jq|JSON\.parse/)
  })

  test("uses the policy matrix and exact pinned compatibility setup", () => {
    const compat = requireJob(compatibilityWorkflow, "compat", "compatibility workflow")
    const steps = requireSteps(compat, "jobs.compat")
    expect(compat.needs).toBe("scope")
    expect(normalizedExpression(compat.if)).toBe(
      githubExpression("needs.scope.outputs.required == 'true'"),
    )
    const strategy = requireRecord(compat.strategy, "jobs.compat.strategy")
    expect(strategy["fail-fast"]).toBe(false)
    expect(normalizedExpression(strategy.matrix)).toBe(
      githubExpression("fromJSON(needs.scope.outputs.matrix)"),
    )
    expect(compat.env).toEqual({
      DAWN_TEST_K8S_CONTEXT: `kind-${githubExpression("matrix.clusterName")}`,
      DAWN_K8S_TARGET: githubExpression("matrix.target"),
    })

    expect(requireNamedStep(steps, "Checkout").uses).toBe(checkoutAction)
    assertPolicyToolchain(steps, { helm: true })
    expect(requireNamedStep(steps, "Install").run).toBe("pnpm install --frozen-lockfile")
    const kind = requireNamedStep(steps, "Create kind cluster")
    expect(kind.uses).toBe(kindAction)
    expect(kind.with).toEqual({
      version: policy.toolchain.kind,
      kubectl_version: policy.toolchain.kubectl,
      node_image: githubExpression("matrix.nodeImage"),
      config: ".github/kind/kind-calico.yaml",
      cluster_name: githubExpression("matrix.clusterName"),
    })
    assertVerifiedCalicoSteps(steps)

    const harness = requireNamedStep(steps, "Run Kubernetes compatibility harness")
    expect(harness.run).toBe(
      'pnpm verify:k8s:compat -- --target "$DAWN_K8S_TARGET" --context "$DAWN_TEST_K8S_CONTEXT"',
    )
    assertExplicitKubernetesContexts(steps, "compat")
  })

  test("uploads only compatibility reports with the pinned artifact action", () => {
    const steps = requireSteps(
      requireJob(compatibilityWorkflow, "compat", "compatibility workflow"),
      "jobs.compat",
    )
    const uploads = steps.filter(
      (step) => typeof step.uses === "string" && step.uses.startsWith("actions/upload-artifact@"),
    )
    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.uses).toBe(uploadArtifactAction)
    expect(uploads[0]?.if).toBe("always()")
    expect(requireRecord(uploads[0]?.with, "artifact upload inputs").path).toBe(
      "artifacts/testing/kubernetes-compat/**",
    )
  })

  test("aggregates skipped and required work with a stable fail-closed context", () => {
    const aggregate = requireJob(
      compatibilityWorkflow,
      "kubernetes-compat",
      "compatibility workflow",
    )
    expect(aggregate.name).toBe("kubernetes-compat")
    expect(aggregate.if).toBe("always()")
    expect(aggregate.needs).toEqual(["scope", "compat"])
    const steps = requireSteps(aggregate, "jobs.kubernetes-compat")
    expect(steps).toHaveLength(1)
    const step = steps[0]
    expect(step?.env).toEqual({
      SCOPE_RESULT: githubExpression("needs.scope.result"),
      COMPAT_RESULT: githubExpression("needs.compat.result"),
      REQUIRED: githubExpression("needs.scope.outputs.required"),
    })
    const run = requireString(step?.run, "aggregator run")
    expect(run).not.toContain("${{")
    expect(run.indexOf('"$SCOPE_RESULT" != "success"')).toBeGreaterThanOrEqual(0)
    expect(run.indexOf('"$SCOPE_RESULT" != "success"')).toBeLessThan(
      run.indexOf('case "$REQUIRED"'),
    )
    expect(run).toContain('"$COMPAT_RESULT" = "skipped"')
    expect(run).toContain('"$COMPAT_RESULT" = "success"')

    const result = (values: Record<string, string>) =>
      spawnSync("sh", ["-c", run], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", ...values },
      }).status
    expect(
      result({
        SCOPE_RESULT: "success",
        REQUIRED: "false",
        COMPAT_RESULT: "skipped",
      }),
    ).toBe(0)
    expect(
      result({
        SCOPE_RESULT: "success",
        REQUIRED: "true",
        COMPAT_RESULT: "success",
      }),
    ).toBe(0)
    for (const values of [
      { SCOPE_RESULT: "failure", REQUIRED: "false", COMPAT_RESULT: "skipped" },
      { SCOPE_RESULT: "cancelled", REQUIRED: "true", COMPAT_RESULT: "success" },
      { SCOPE_RESULT: "success", REQUIRED: "false", COMPAT_RESULT: "success" },
      { SCOPE_RESULT: "success", REQUIRED: "true", COMPAT_RESULT: "skipped" },
      { SCOPE_RESULT: "success", REQUIRED: "true", COMPAT_RESULT: "failure" },
      { SCOPE_RESULT: "success", REQUIRED: "", COMPAT_RESULT: "skipped" },
      { SCOPE_RESULT: "", REQUIRED: "false", COMPAT_RESULT: "skipped" },
    ]) {
      expect(result(values)).not.toBe(0)
    }
  })
})

describe("canonical Kubernetes CI evidence", () => {
  test("pins canonical sandbox setup and invokes the structured 1.35 harness", () => {
    const canonical = requirePolicyTarget("canonical")
    const job = requireJob(ciWorkflow, "sandbox-k8s", "CI workflow")
    const steps = requireSteps(job, "jobs.sandbox-k8s")
    expect(job.env).toEqual({
      DAWN_TEST_K8S_CONTEXT: "kind-dawn-k8s-canonical",
    })
    assertPolicyToolchain(steps, { helm: true })
    assertCanonicalKindStep(steps, "dawn-k8s-canonical")
    assertVerifiedCalicoSteps(steps)

    const parity = requireNamedStep(steps, "Verify chart/provider permission parity")
    expect(parity.env).toEqual({ DAWN_REQUIRE_HELM: "1" })
    expect(parity.run).toContain("chart-rbac")

    const harness = requireNamedStep(steps, "Run Kubernetes 1.35 compatibility harness")
    expect(harness.run).toBe(
      `pnpm verify:k8s:compat -- --target ${canonical.minor} --context "$DAWN_TEST_K8S_CONTEXT"`,
    )
    assertExplicitKubernetesContexts(steps, "sandbox-k8s")
  })

  test("keeps the packaged-app proof on the exact canonical cluster and local Calico", () => {
    const job = requireJob(ciWorkflow, "sandbox-k8s-e2e", "CI workflow")
    const steps = requireSteps(job, "jobs.sandbox-k8s-e2e")
    expect(requireRecord(job.env, "jobs.sandbox-k8s-e2e.env")).toMatchObject({
      DAWN_TEST_K8S_CONTEXT: "kind-dawn-smoke",
      KIND_CLUSTER: "dawn-smoke",
    })
    assertPolicyToolchain(steps, { helm: true })
    assertCanonicalKindStep(steps, "dawn-smoke")
    assertVerifiedCalicoSteps(steps)
    expect(requireNamedStep(steps, "Build and load smoke app image (Verdaccio)").run).toContain(
      "test/k8s-smoke/build-image.sh k8s",
    )
    expect(requireNamedStep(steps, "Run full-arc assertions").run).toBe(
      "sh test/k8s-smoke/assert-k8s.sh",
    )
    assertExplicitKubernetesContexts(steps, "sandbox-k8s-e2e")
  })

  test("pins chart apply and passes policy images through digest-aware inputs", () => {
    const job = requireJob(ciWorkflow, "chart-apply-smoke", "CI workflow")
    const steps = requireSteps(job, "jobs.chart-apply-smoke")
    expect(job.env).toEqual({ DAWN_TEST_K8S_CONTEXT: "kind-dawn-chart-apply" })
    const helm = requireNamedStep(steps, "Setup Helm")
    expect(helm.uses).toBe(helmSetupAction)
    expect(helm.with).toEqual({ version: policy.toolchain.helm })
    assertCanonicalKindStep(steps, "dawn-chart-apply", false)

    const apply = requireNamedStep(
      steps,
      "Install dawn-app (placeholder image) and verify it serves",
    )
    const run = requireString(apply.run, "chart apply run")
    expect(run).toContain(".images.placeholderApp")
    expect(run).toContain(".images.reachabilityProbe")
    expect(run).toContain("--set-string image.digest=")
    expect(run).not.toContain("--set image.tag=")
    expect(run).toContain('--image="$REACHABILITY_IMAGE"')
    assertExplicitKubernetesContexts(steps, "chart-apply-smoke")
  })

  test("does not constrain unrelated CI job inventory", () => {
    const jobs = requireJobs(ciWorkflow, "CI workflow")
    expect(jobs.validate).toBeDefined()
    expect(jobs["testing-windows"]).toBeDefined()
  })
})

describe("immutable Kubernetes workflow and smoke inputs", () => {
  test("uses policy sandbox images in live Docker lanes and runtime fixtures", () => {
    const dockerIntegration = readFileSync(
      resolve(repoRoot, "packages/sandbox/test/docker-sandbox.integration.test.ts"),
      "utf8",
    )
    const smokeConfig = readFileSync(resolve(repoRoot, "test/k8s-smoke/app/dawn.config.ts"), "utf8")
    const aimockDockerfile = readFileSync(
      resolve(repoRoot, "test/k8s-smoke/aimock/Dockerfile"),
      "utf8",
    )

    expect(dockerIntegration).toContain("const IMAGE =")
    expect(dockerIntegration).toContain(policy.images.sandboxWorkload)
    expect(smokeConfig.split(policy.images.sandboxWorkload)).toHaveLength(3)
    expect(aimockDockerfile).toContain(`FROM ${policy.images.sandboxWorkload}`)
  })

  test("reads and replaces the packaged-app base only in the smoke augmentation", () => {
    const buildHelper = readFileSync(resolve(repoRoot, "test/k8s-smoke/build-image.sh"), "utf8")
    expect(buildHelper).toContain(".github/kubernetes-compatibility.json")
    expect(buildHelper).toContain("images.packagedAppBase")
    expect(buildHelper).toContain("^FROM node:24-slim$")
    expect(buildHelper).toContain("must contain exactly one 'FROM node:24-slim'")
    expect(buildHelper).toContain('AUG_DOCKERFILE="$EMITTED_DOCKERFILE.smoke"')
    expect(buildHelper).not.toMatch(/sed\s+-i|perl\s+-[pi]/)
  })

  test("rejects mutable remote fixture references in active inputs", () => {
    const sources = [
      compatibilityWorkflowSource,
      ciWorkflowSource,
      readFileSync(resolve(repoRoot, "test/k8s-smoke/aimock/Dockerfile"), "utf8"),
      readFileSync(resolve(repoRoot, "test/k8s-smoke/app/dawn.config.ts"), "utf8"),
      readFileSync(resolve(repoRoot, "test/k8s-smoke/build-image.sh"), "utf8"),
      readFileSync(
        resolve(repoRoot, "packages/sandbox/test/docker-sandbox.integration.test.ts"),
        "utf8",
      ),
    ]
    for (const source of sources) {
      expect(() => assertNoMutableFixtureImages(source)).not.toThrow()
    }
    for (const mutable of [
      "docker pull node:22-slim",
      "FROM nginxinc/nginx-unprivileged:stable-alpine",
      "kubectl run probe --image=curlimages/curl:8.10.1",
      "image: registry.k8s.io/pause:3.10",
      "node_image: kindest/node:v1.35.5",
    ]) {
      expect(() => assertNoMutableFixtureImages(mutable)).toThrow(/mutable fixture image/)
    }
  })

  test("reconstructs the exact policy reaper image from chart repository, tag, and digest", () => {
    const values = requireRecord(
      parse(readFileSync(resolve(repoRoot, "charts/dawn-sandbox-infra/values.yaml"), "utf8")),
      "sandbox-infra values",
    )
    const reaper = requireRecord(values.reaper, "sandbox-infra values.reaper")
    const parts = splitPinnedImage(requireString(reaper.image, "reaper.image"))
    expect(`${parts.repository}:${parts.tag}@${parts.digest}`).toBe(policy.images.reaper)
  })

  test("routes every smoke assertion kubectl command through the context wrapper", () => {
    const source = readFileSync(resolve(repoRoot, "test/k8s-smoke/assert-k8s.sh"), "utf8")
    expect(source).toContain('DAWN_TEST_K8S_CONTEXT="${DAWN_TEST_K8S_CONTEXT:?')
    expect(source).toContain('command kubectl --context "$DAWN_TEST_K8S_CONTEXT" "$@"')
    const ambientCalls = activeShellLines(source).filter(
      (line) => /(^|[;&|()]\s*|!\s+)kubectl\s/.test(line) && !line.startsWith("command kubectl"),
    )
    expect(ambientCalls).toEqual([])
  })

  test("removes the superseded shell entrypoints and audited workflow references", () => {
    const retired = ["setup-network-policy-control.sh", "assert-reaper.sh"]
    for (const file of retired) {
      expect(existsSync(resolve(repoRoot, "test/k8s-smoke", file))).toBe(false)
    }
    const auditedSources = [
      compatibilityWorkflowSource,
      ciWorkflowSource,
      readFileSync(
        resolve(repoRoot, "scripts/release/test/fixtures/workflow-entrypoints.json"),
        "utf8",
      ),
      readFileSync(
        resolve(repoRoot, "scripts/release/test/fixtures/workflow-safe-executables.json"),
        "utf8",
      ),
    ]
    for (const source of auditedSources) {
      for (const file of retired) expect(source).not.toContain(file)
    }
  })
})
