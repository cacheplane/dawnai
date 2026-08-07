import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { parse } from "yaml"

const kindActionPrefix = "helm/kind-action@"
const calicoManifestUrl =
  /https:\/\/raw\.githubusercontent\.com\/projectcalico\/calico\/(v[^/]+)\/manifests\/calico\.yaml/g
const kubectlApplyCommand = /^kubectl(?:\s+--?\S+(?:\s+(?!-|apply(?:\s|$))\S+)?)*\s+apply(?:\s|$)/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function collectKubernetesPins(workflowSource: string) {
  const workflow: unknown = parse(workflowSource)
  const kindCommits: string[] = []
  const calicoVersions: string[] = []

  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    return { calicoVersions, kindCommits }
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
      }

      if (typeof step.run !== "string") {
        continue
      }

      const commands = step.run.replace(/\\\r?\n/g, " ").split(/\r?\n/)
      for (const command of commands) {
        const executable = command.trim().replace(/\s+#.*$/, "")
        if (!kubectlApplyCommand.test(executable)) {
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

  return { calicoVersions, kindCommits }
}

const ciWorkflow = readFileSync(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
)
const ciPins = collectKubernetesPins(ciWorkflow)

describe("Kubernetes CI dependency pins", () => {
  test("uses the approved Node 24 Kind action in every active lane", () => {
    expect(ciPins.kindCommits).toEqual(
      Array.from({ length: 3 }, () => "ef37e7f390d99f746eb8b610417061a60e82a6cc"),
    )
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
      - run: |
          kubectl apply \\
            --filename \\
            "https://raw.githubusercontent.com/projectcalico/calico/v9.9.9/manifests/calico.yaml"
`)

    expect(pins).toEqual({
      calicoVersions: ["v9.9.9"],
      kindCommits: ["quoted-commit"],
    })
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
