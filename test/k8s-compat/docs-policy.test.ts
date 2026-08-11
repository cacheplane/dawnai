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
const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" })

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

function normalizedProseStatements(source: string): readonly string[] {
  const statements: string[] = []
  const paragraphs = markdownText(source)
    .replaceAll(/\r\n?/g, "\n")
    .split(/\n\s*\n/)

  for (const paragraph of paragraphs) {
    const blocks = paragraph.split(/\n(?=\s*(?:(?:[-*+]|\d+\.)\s+|\|))/)
    for (const block of blocks) {
      const normalized = block
        .replaceAll(/^\s*(?:#{1,6}|>)\s?/gm, "")
        .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
        .replaceAll(/\s+/g, " ")
        .trim()
      for (const { segment } of sentenceSegmenter.segment(normalized)) {
        const statement = segment.trim()
        if (statement) statements.push(statement)
      }
    }
  }

  return statements
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

function isManagedKubernetesBoundary(text: string): boolean {
  const requiresSeparateValidation =
    /^(?:The )?managed[- ](?:Kubernetes(?: services?)?|cloud(?: services?)?|clusters?) (?:requires? separate validation|(?:must|should) be validated separately)[.!?]?$/i.test(
      text,
    )
  const outsideKindEvidence =
    /^(?:The )?managed[- ](?:Kubernetes(?: services?)?|cloud(?: services?)?|clusters?) (?:is|are|being) (?:outside (?:the )?Kind(?:\/Calico)? (?:coverage|evidence)|not covered by (?:the )?Kind(?:\/Calico)? (?:coverage|evidence))[.!?]?$/i.test(
      text,
    )
  const kindEvidenceExcludesScope =
    /^Kind(?:\/Calico)? (?:coverage|evidence) (?:does not|doesn't) cover managed[- ](?:Kubernetes(?: services?)?|cloud(?: services?)?|clusters?)[.!?]?$/i.test(
      text,
    )
  return requiresSeparateValidation || outsideKindEvidence || kindEvidenceExcludesScope
}

function isDynamicRwoStoragePrerequisite(text: string): boolean {
  const driverMustSupport =
    /^(?:(?:The|A) )?storage[- ]drivers? (?:must|needs? to) support dynamic(?:ally)? (?:ReadWriteOnce|RWO) provisioning[.!?]?$/i.test(
      text,
    )
  const driverIsRequired =
    /^(?:(?:The|A) )?storage[- ]driver(?:s| support)? (?:is|are) (?:required|(?:a )?prerequisite) for dynamic(?:ally)? (?:ReadWriteOnce|RWO) provisioning[.!?]?$/i.test(
      text,
    )
  const provisioningRequiresDriver =
    /^Dynamic(?:ally)? (?:ReadWriteOnce|RWO) provisioning (?:requires?|needs?) (?:a )?storage[- ]drivers?[.!?]?$/i.test(
      text,
    )
  return driverMustSupport || driverIsRequired || provisioningRequiresDriver
}

function isApprovedCniPreflightWarning(text: string): boolean {
  return /^Only after (?:every required permission is granted|all permissions pass) does it (?:check|probe) NetworkPolicy enforcement; an unconfirmed policy-capable CNI produces a warning (?:rather than a successful enforcement claim|instead of an enforcement claim)[.!?]?$/i.test(
    text,
  )
}

function hasPositiveCniClaimLanguage(text: string): boolean {
  const positiveClaim =
    /\b(?:certif(?:y|ies|ied|ying|ications?)|compatib(?:le|ilit(?:y|ies))|validat(?:e|es|ed|ing|ions?)|support(?:s|ed|ing)?|prov(?:e|es|ed|en|ing)|proofs?|guarantee(?:s|d|ing)?|work(?:s|ed|ing)?\s+with)\b/gi
  let negatedClaimEnd: number | undefined
  for (const match of text.matchAll(positiveClaim)) {
    const prefix = text.slice(Math.max(0, match.index - 32), match.index)
    const isDirectlyNegated =
      /(?:\b(?:not|never|cannot|can't|doesn't|don't|isn't|aren't)\s+|\bno(?:\s+CNIs?(?:\s+(?:implementations?|plugins?))?)?\s+|\b(?:rather than|instead of)\s+|\bnon-)$/i.test(
        prefix,
      )
    if (isDirectlyNegated) {
      negatedClaimEnd = match.index + match[0].length
      continue
    }
    const followsNegatedClaim =
      negatedClaimEnd !== undefined &&
      /^(?:certifications?|compatibilit(?:y|ies)|validations?|support|proofs?|guarantees?)$/i.test(
        match[0],
      ) &&
      /^\s+(?:CNIs?(?:\s+(?:implementations?|plugins?))?\s+)?$/i.test(
        text.slice(negatedClaimEnd, match.index),
      )
    if (followsNegatedClaim) {
      negatedClaimEnd = undefined
      continue
    }
    return true
  }
  return false
}

function hasBroadCniQualifier(text: string): boolean {
  for (const match of text.matchAll(/\b(?:any|arbitrary|other|every|all)\b/gi)) {
    const prefix = text.slice(0, match.index)
    if (match[0].toLowerCase() === "all" && /\bat\s+$/i.test(prefix)) continue
    return true
  }
  return false
}

function isUnsupportedCniClaim(text: string): boolean {
  if (!/\bCNIs?(?:\s+(?:implementations?|plugins?))?\b/i.test(text)) return false
  if (hasBroadCniQualifier(text) && !isApprovedCniPreflightWarning(text)) return true
  return hasPositiveCniClaimLanguage(text)
}

function makesUnsupportedCompatibilityClaim(source: string): boolean {
  const text = markdownText(source).replaceAll(/\s+/g, " ").trim()
  if (text === compatibilityDisclaimer) return false
  const namesStorageDriver = /\bstorage[- ]drivers?\b/i.test(text)
  if (namesStorageDriver && !isDynamicRwoStoragePrerequisite(text)) return true

  if (isUnsupportedCniClaim(text)) return true

  const namesManagedKubernetes =
    /\bmanaged[- ](?:Kubernetes(?: services?)?|cloud(?: services?)?|clusters?)\b/i.test(text)
  return namesManagedKubernetes && !isManagedKubernetesBoundary(text)
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
      for (const statement of normalizedProseStatements(source)) {
        expect(
          makesUnsupportedCompatibilityClaim(statement),
          `${name} contains an unsupported managed-Kubernetes, CNI, or storage claim: ${statement}`,
        ).toBe(false)
      }
    }
  })

  test.each([
    "Dawn certifies managed Kubernetes services.",
    "Kind is compatible with every CNI.",
    "Kind validates managed Kubernetes services.",
    `Kind coverage proves compatibility across all
managed Kubernetes services.`,
    "Kind proves every managed cluster, CNI, and storage driver",
    "Kind supports managed Kubernetes services",
    "Kind guarantees compatibility for other CNIs",
    "Kind coverage proves storage driver compatibility",
    "Kind validates managed Kubernetes services that require separate validation.",
    "Kind validates storage drivers required for dynamic RWO provisioning.",
    "Managed Kubernetes services require separate validation, but Kind validates them.",
    "The storage driver must support dynamic ReadWriteOnce provisioning, and Kind validates all storage drivers.",
    "Kind works with every policy-enforcing standards-compliant CNI.",
    "Kind works with every broadly-used policy-enforcing standards-compliant CNI.",
    "Kind supports CNI implementations other than Calico.",
    "Kind certifies all of the following: CNI implementations.",
    "Kind certifies CNI implementations.",
    "Kind is compatible with CNI implementations.",
    "Kind validates CNI implementations.",
    "Kind supports CNI implementations.",
    "Kind proves CNI compatibility.",
    "Kind guarantees CNI compatibility.",
    "Kind works with CNI implementations.",
    "Kind does not guarantee CNI compatibility, but Kind validates CNI implementations.",
    "Kind provides CNI certification.",
    "The Kind suite is proving CNI compatibility.",
  ])("rejects semantic compatibility overclaim: %s", (claim) => {
    expect(normalizedProseStatements(claim).some(makesUnsupportedCompatibilityClaim)).toBe(true)
  })

  test.each([
    compatibilityDisclaimer,
    `Dawn's Kind/Calico coverage does not certify managed Kubernetes services,
other CNI implementations, or storage drivers.`,
    "A policy-enforcing CNI is required for NetworkPolicy egress controls.",
    "CNIs that do not enforce NetworkPolicy leave egress open.",
    "A CNI that ignores NetworkPolicy does not provide egress isolation.",
    "Preflight warns when a policy-capable CNI cannot be confirmed; it does not guarantee enforcement.",
    "Kind does not guarantee CNI compatibility.",
    "Kind provides no CNI certification.",
    "Dynamic ReadWriteOnce storage provisioning is required.",
    "The storage driver must support dynamic ReadWriteOnce provisioning.",
    "Managed Kubernetes services are outside Kind evidence.",
    "Managed Kubernetes services are not covered by Kind evidence.",
    "Kind evidence does not cover managed Kubernetes services.",
    "The compatibility suite tests Kind with Calico.",
    "Kind coverage proves compatibility for the policy-pinned versions. Managed Kubernetes services require separate validation.",
    `Kind coverage proves compatibility for the policy-pinned versions.

Managed Kubernetes services require separate validation.`,
  ])("allows factual compatibility boundary: %s", (claim) => {
    expect(normalizedProseStatements(claim).some(makesUnsupportedCompatibilityClaim)).toBe(false)
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
