import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { parse } from "yaml"

const kindActionPrefix = "helm/kind-action@"
const approvedKindNodeImage =
  "kindest/node:v1.35.0@sha256:4613778f3cfcd10e615029370f5786704559103cf27bef934597ba562b269661"
const approvedReaperImage =
  "docker.io/alpine/k8s:1.35.6@sha256:b7a12c5ddf261994c33d2eaaa06fd69a0803ff6b38683bfa3d30a76dcdf92807"
const checkoutAction = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
const pnpmSetupAction = "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271"
const nodeSetupAction = "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e"
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
const calicoManifestUrl =
  /https:\/\/raw\.githubusercontent\.com\/projectcalico\/calico\/(v[^/]+)\/manifests\/calico\.yaml/g

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

function isKubectlApplyCommand(command: string): boolean {
  const [executable, ...args] = command.split(/\s+/)
  return executable === "kubectl" && args.includes("apply")
}

function kubernetesMinor(reference: string): number {
  const digestSeparator = "@sha256:"
  const digestIndex = reference.indexOf(digestSeparator)
  if (digestIndex <= 0 || digestIndex !== reference.lastIndexOf(digestSeparator)) {
    throw new Error(`Invalid Kubernetes image reference: ${reference}`)
  }

  const digest = reference.slice(digestIndex + digestSeparator.length)
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`Invalid Kubernetes image digest: ${reference}`)
  }

  const image = reference.slice(0, digestIndex)
  const tagIndex = image.lastIndexOf(":")
  if (tagIndex <= image.lastIndexOf("/")) {
    throw new Error(`Missing Kubernetes image version: ${reference}`)
  }

  const rawVersion = image.slice(tagIndex + 1)
  const version = rawVersion.startsWith("v") ? rawVersion.slice(1) : rawVersion
  const parts = version.split(".")
  if (parts.length !== 3 || parts.some((part) => part.length === 0 || !/^[0-9]+$/.test(part))) {
    throw new Error(`Invalid Kubernetes image version: ${reference}`)
  }

  const minor = Number(parts[1])
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`Invalid Kubernetes image minor version: ${reference}`)
  }
  return minor
}

function collectReaperImage(valuesSource: string): string {
  const values: unknown = parse(valuesSource)
  if (!isRecord(values) || !isRecord(values.reaper) || typeof values.reaper.image !== "string") {
    throw new Error("Expected charts/dawn-sandbox-infra reaper.image to be a string")
  }
  return values.reaper.image
}

function collectKubernetesPins(workflowSource: string) {
  const workflow: unknown = parse(workflowSource)
  const kindCommits: string[] = []
  const kindNodeImages: string[] = []
  const calicoVersions: string[] = []

  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    return { calicoVersions, kindCommits, kindNodeImages }
  }

  for (const job of Object.values(workflow.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) {
      continue
    }

    for (const step of job.steps) {
      if (!isRecord(step)) {
        continue
      }

      if (typeof step.uses === "string" && step.uses.startsWith(kindActionPrefix)) {
        kindCommits.push(step.uses.slice(kindActionPrefix.length))
        if (isRecord(step.with) && typeof step.with.node_image === "string") {
          kindNodeImages.push(step.with.node_image)
        }
      }

      if (typeof step.run !== "string") {
        continue
      }

      const commands = step.run.replace(/\\\r?\n/g, " ").split(/\r?\n/)
      for (const command of commands) {
        const executable = command.trim().replace(/\s+#.*$/, "")
        if (!isKubectlApplyCommand(executable)) {
          continue
        }

        for (const match of executable.matchAll(calicoManifestUrl)) {
          const version = match[1]
          if (version !== undefined) {
            calicoVersions.push(version)
          }
        }
      }
    }
  }

  return { calicoVersions, kindCommits, kindNodeImages }
}

const ciWorkflow = readFileSync(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
)
const ciPins = collectKubernetesPins(ciWorkflow)
const chartValues = readFileSync(
  new URL("../../../charts/dawn-sandbox-infra/values.yaml", import.meta.url),
  "utf8",
)
const reaperImage = collectReaperImage(chartValues)

describe("Kubernetes CI dependency pins", () => {
  test("uses the approved Node 24 Kind action in every active lane", () => {
    expect(ciPins.kindCommits).toEqual(
      Array.from({ length: 3 }, () => "ef37e7f390d99f746eb8b610417061a60e82a6cc"),
    )
  })

  test("uses the approved Kubernetes node image in every active Kind lane", () => {
    expect(ciPins.kindNodeImages).toEqual(Array.from({ length: 3 }, () => approvedKindNodeImage))
  })

  test("uses the approved Kubernetes client image for the reaper", () => {
    expect(reaperImage).toBe(approvedReaperImage)
  })

  test("keeps Kind and reaper Kubernetes minors within one release", () => {
    const reaperMinor = kubernetesMinor(reaperImage)
    for (const nodeImage of ciPins.kindNodeImages) {
      expect(Math.abs(kubernetesMinor(nodeImage) - reaperMinor)).toBeLessThanOrEqual(1)
    }
  })

  test("uses the Kubernetes 1.35-compatible Calico release in every active lane", () => {
    expect(ciPins.calicoVersions).toEqual(["v3.32.1", "v3.32.1"])
  })

  test("detects quoted action pins and Calico URLs with alternate kubectl flags", () => {
    const pins = collectKubernetesPins(`
jobs:
  synthetic:
    steps:
      - uses: "helm/kind-action@quoted-commit"
        with:
          node_image: "kindest/node:v9.9.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      - run: |
          kubectl apply \\
            --filename \\
            "https://raw.githubusercontent.com/projectcalico/calico/v9.9.9/manifests/calico.yaml"
`)

    expect(pins).toEqual({
      calicoVersions: ["v9.9.9"],
      kindCommits: ["quoted-commit"],
      kindNodeImages: [
        "kindest/node:v9.9.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
    })
  })

  test("extracts Kubernetes minors from versioned digest references", () => {
    expect(kubernetesMinor(approvedKindNodeImage)).toBe(35)
    expect(
      kubernetesMinor(
        "example.invalid/kubectl:1.34.7@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toBe(34)
  })

  test.each([
    "kindest/node:v1.35.0",
    "kindest/node:v1.35.0@sha256:abc",
    "kindest/node:v1.35.0@sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "kindest/node:v1.35@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "kindest/node:latest@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ])("rejects malformed or non-digest Kubernetes reference %s", (reference) => {
    expect(() => kubernetesMinor(reference)).toThrow()
  })

  test("ignores commented and echoed Calico install commands", () => {
    const pins = collectKubernetesPins(`
jobs:
  synthetic:
    steps:
      - run: |
          # kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v8.8.8/manifests/calico.yaml
          echo "kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v7.7.7/manifests/calico.yaml"
`)

    expect(pins.calicoVersions).toEqual([])
  })

  test("detects Calico installs after kubectl global options", () => {
    const pins = collectKubernetesPins(`
jobs:
  synthetic:
    steps:
      - run: |
          kubectl --context kind apply --filename "https://raw.githubusercontent.com/projectcalico/calico/v6.6.6/manifests/calico.yaml"
`)

    expect(pins.calicoVersions).toEqual(["v6.6.6"])
  })

  test("ignores Calico URLs after inline shell comments", () => {
    const pins = collectKubernetesPins(`
jobs:
  synthetic:
    steps:
      - run: |
          kubectl apply --filename manifest.yaml  # https://raw.githubusercontent.com/projectcalico/calico/v5.5.5/manifests/calico.yaml
`)

    expect(pins.calicoVersions).toEqual([])
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
