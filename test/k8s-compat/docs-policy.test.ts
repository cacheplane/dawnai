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
  package: resolve(repoRoot, "packages/sandbox/README.md"),
  website: resolve(repoRoot, "apps/web/content/docs/sandbox.mdx"),
  bundled: resolve(repoRoot, "packages/cli/docs/sandbox.md"),
  contributors: resolve(repoRoot, "CONTRIBUTORS.md"),
} as const

type DocumentationName = keyof typeof documentationPaths
type Documentation = Readonly<Record<DocumentationName, string>>

const policyDocumentation = ["chart", "package", "website", "bundled"] as const
const commandDocumentation = [...policyDocumentation, "contributors"] as const

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
    const disclaimer =
      "Dawn's Kind/Calico coverage does not certify managed Kubernetes services, other CNI implementations, or storage drivers."

    for (const name of policyDocumentation) {
      const source = markdownText(documentation[name])
      expect(source, `${name} must state the non-certification boundary`).toContain(disclaimer)
    }

    for (const [name, source] of Object.entries(documentation)) {
      for (const line of markdownText(source).split("\n")) {
        if (!/\bcertif(?:y|ies|ied|ication)\b/i.test(line)) continue
        expect(
          line.trim(),
          `${name} contains certification wording outside the approved boundary`,
        ).toBe(disclaimer)
      }
    }
  })
})
