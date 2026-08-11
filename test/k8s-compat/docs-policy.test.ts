import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, test } from "vitest"

import { KUBERNETES_COMPAT_USAGE } from "../../scripts/kubernetes-compat/harness.ts"
import {
  type CompatibilityPolicy,
  loadCompatibilityPolicy,
} from "../../scripts/kubernetes-compat/policy.ts"

const repoRoot = resolve(__dirname, "../..")
const documentationPaths = {
  chart: resolve(repoRoot, "charts/dawn-sandbox-infra/README.md"),
  chartValues: resolve(repoRoot, "charts/dawn-sandbox-infra/values.yaml"),
  chartNotes: resolve(repoRoot, "charts/dawn-sandbox-infra/templates/NOTES.txt"),
  package: resolve(repoRoot, "packages/sandbox/README.md"),
  website: resolve(repoRoot, "apps/web/content/docs/sandbox.mdx"),
  bundled: resolve(repoRoot, "packages/cli/docs/sandbox.md"),
  contributors: resolve(repoRoot, "CONTRIBUTORS.md"),
} as const

type DocumentationName = keyof typeof documentationPaths
type Documentation = Readonly<Record<DocumentationName, string>>

const policyDocumentation = ["chart", "package", "website", "bundled"] as const
const commandDocumentation = [...policyDocumentation, "contributors"] as const
const compatibilityDisclaimer =
  "Dawn's Kind/Calico coverage does not certify managed Kubernetes services, other CNI implementations, or storage drivers."

async function loadDocumentation(): Promise<Documentation> {
  const entries = await Promise.all(
    Object.entries(documentationPaths).map(async ([name, path]) => [
      name,
      await readFile(path, "utf8"),
    ]),
  )
  return Object.fromEntries(entries) as Documentation
}

function markdownText(source: string): string {
  return source.replaceAll("`", "")
}

function proseText(source: string): string {
  return markdownText(source)
    .replaceAll(/\n\s*#\s?/g, " ")
    .replaceAll(/\s+/g, " ")
}

function calicoVersion(policy: CompatibilityPolicy): string {
  const versions = new Set(
    policy.calico.images.map(({ source }) => /:(v\d+\.\d+\.\d+)$/.exec(source)?.[1]),
  )
  if (versions.size !== 1 || versions.has(undefined)) {
    throw new Error("Compatibility policy must use one version across all Calico images")
  }
  return [...versions][0] as string
}

function portableCommand(policy: CompatibilityPolicy): string {
  const targets = policy.targets.map(({ minor }) => minor).join("|")
  return `pnpm verify:k8s:compat -- --target <${targets}> --context <exact-context> [--storage-class <name>] [--keep-on-failure]`
}

function makesUnsupportedCompatibilityClaim(source: string): boolean {
  const text = markdownText(source).trim()
  if (text === compatibilityDisclaimer) return false
  const namesKindEvidence = /\bKind(?:\/Calico)?(?:\s+(?:coverage|evidence|suite|tests?))?\b/i.test(
    text,
  )
  const makesClaim = /\b(?:certif(?:y|ies|ied|ication)|proves?|supports?|guarantees?)\b/i.test(text)
  const namesUnsupportedScope =
    /\b(?:managed (?:Kubernetes(?: services?)?|cloud(?: services?)?|clusters?)|(?:arbitrary|other|every|all)\s+(?:CNIs?|storage drivers?|managed clusters?)|storage drivers?)\b/i.test(
      text,
    )
  return namesKindEvidence && makesClaim && namesUnsupportedScope
}

describe("Kubernetes compatibility documentation policy", () => {
  test("derives every documented Kubernetes target and tool version from policy", async () => {
    const [policy, documentation] = await Promise.all([
      loadCompatibilityPolicy(),
      loadDocumentation(),
    ])
    const expectedKubernetesVersions = new Set(
      policy.targets.flatMap(({ minor, version }) => [minor, version]),
    )
    const expectedToolVersions = new Map([
      ["Node", policy.toolchain.node],
      ["pnpm", policy.toolchain.pnpm],
      ["Helm", policy.toolchain.helm],
      ["Kind", policy.toolchain.kind],
      ["kubectl", policy.toolchain.kubectl],
      ["Calico", calicoVersion(policy)],
    ])

    for (const name of policyDocumentation) {
      const source = markdownText(documentation[name])
      for (const target of policy.targets) {
        expect(source, `${name} must document policy target ${target.minor}`).toContain(
          `Kubernetes ${target.minor} (${target.version})`,
        )
      }
      for (const tool of ["Kind", "kubectl", "Calico"] as const) {
        expect(source, `${name} must document policy ${tool} version`).toContain(
          `${tool} ${expectedToolVersions.get(tool)}`,
        )
      }
    }

    for (const [name, source] of Object.entries(documentation)) {
      const text = markdownText(source)
      for (const match of text.matchAll(
        /\bKubernetes(?: API servers?| servers?| targets?)?\s+(v?\d+\.\d+(?:\.\d+)?)\b/g,
      )) {
        const version = match[1]?.replace(/^v/, "")
        expect(
          expectedKubernetesVersions.has(version ?? ""),
          `${name} documents Kubernetes version ${version} outside compatibility policy`,
        ).toBe(true)
      }
      for (const match of text.matchAll(
        /\b(Node|pnpm|Helm|Kind|kubectl|Calico)\s+(v?\d+\.\d+\.\d+)\b/g,
      )) {
        const tool = match[1] ?? ""
        const version = match[2] ?? ""
        expect(
          version === expectedToolVersions.get(tool),
          `${name} documents ${tool} ${version} outside compatibility policy`,
        ).toBe(true)
      }
    }
  })

  test("publishes the portable command with its exact supported flag surface", async () => {
    const [policy, documentation] = await Promise.all([
      loadCompatibilityPolicy(),
      loadDocumentation(),
    ])
    const expected = portableCommand(policy)
    expect(KUBERNETES_COMPAT_USAGE).toContain(`  ${expected}\n`)

    for (const name of commandDocumentation) {
      const commands = documentation[name]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("pnpm verify:k8s:compat"))
      expect(commands, `${name} must publish only the canonical portable command`).toEqual([
        expected,
      ])
    }
  })

  test("states the Kind evidence boundary without making certification claims", async () => {
    const documentation = await loadDocumentation()

    for (const name of policyDocumentation) {
      const source = markdownText(documentation[name])
      expect(source, `${name} must state the non-certification boundary`).toContain(
        compatibilityDisclaimer,
      )
    }

    for (const [name, source] of Object.entries(documentation)) {
      for (const line of markdownText(source).split("\n")) {
        expect(
          makesUnsupportedCompatibilityClaim(line),
          `${name} contains an unsupported managed-Kubernetes, CNI, or storage claim: ${line.trim()}`,
        ).toBe(false)
      }
    }
  })

  test.each([
    "Kind proves every managed cluster, CNI, and storage driver",
    "Kind supports managed Kubernetes services",
    "Kind guarantees compatibility for other CNIs",
    "Kind coverage proves storage driver compatibility",
  ])("rejects semantic compatibility overclaim: %s", (claim) => {
    expect(makesUnsupportedCompatibilityClaim(claim)).toBe(true)
  })

  test.each([
    compatibilityDisclaimer,
    "A policy-enforcing CNI is required for NetworkPolicy egress controls.",
    "Dynamic ReadWriteOnce storage provisioning is required.",
  ])("allows factual compatibility boundary: %s", (claim) => {
    expect(makesUnsupportedCompatibilityClaim(claim)).toBe(false)
  })

  test("keeps chart values and NOTES aligned with operational prerequisites", async () => {
    const documentation = await loadDocumentation()
    expect(documentation.chartValues).toMatch(/\benforce:\s+restricted\b/)

    for (const name of ["chartValues", "chartNotes"] as const) {
      const source = proseText(documentation[name])
      expect(source, `${name} must require Pod Security Admission`).toMatch(
        /Pod Security Admission/,
      )
      expect(source, `${name} must require dynamic RWO provisioning`).toMatch(
        /dynamic(?:ally)? (?:RWO|provisioning for ReadWriteOnce)/i,
      )
      expect(source, `${name} must require a policy-enforcing CNI`).toMatch(/policy-enforcing CNI/)
    }
  })

  test("requires credential-safe cross-namespace ServiceAccount wiring in chart NOTES", async () => {
    const { chartNotes } = await loadDocumentation()
    expect(chartNotes).not.toContain("Bind an in-cluster Dawn app to this ServiceAccount")
    expect(chartNotes).not.toMatch(/serviceAccountName:\s+\{\{.*orchestratorSAName/)
    expect(chartNotes).toContain(
      "Create or use the Dawn app ServiceAccount in a separate management namespace.",
    )
    expect(chartNotes).toContain(
      `--set-json 'orchestrator.subjects[0]={"kind":"ServiceAccount","name":"<app-service-account>","namespace":"<management-namespace>"}'`,
    )
    expect(chartNotes).toContain(
      "Configure the app Pod to use that management-namespace ServiceAccount.",
    )
  })
})
