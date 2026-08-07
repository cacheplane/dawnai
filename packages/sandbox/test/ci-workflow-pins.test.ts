import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { parse } from "yaml"

const kindActionPrefix = "helm/kind-action@"
const approvedKindNodeImage =
  "kindest/node:v1.35.0@sha256:4613778f3cfcd10e615029370f5786704559103cf27bef934597ba562b269661"
const approvedReaperImage =
  "docker.io/alpine/k8s:1.35.6@sha256:b7a12c5ddf261994c33d2eaaa06fd69a0803ff6b38683bfa3d30a76dcdf92807"
const calicoManifestUrl =
  /https:\/\/raw\.githubusercontent\.com\/projectcalico\/calico\/(v[^/]+)\/manifests\/calico\.yaml/g

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
