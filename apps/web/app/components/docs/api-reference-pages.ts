export interface ApiReferencePage {
  readonly label: string
  readonly href: string
  readonly surfaceName: string
  readonly ownerPackageNames: readonly string[]
  readonly parent: {
    readonly label: "API Reference"
    readonly href: "/docs/api"
  }
}

export const API_REFERENCE_PARENT = { label: "API Reference", href: "/docs/api" } as const

export const API_REFERENCE_PAGES = [
  referencePage("@dawn-ai/sdk", "/docs/api/sdk", ["@dawn-ai/sdk"]),
  referencePage("@dawn-ai/cli", "/docs/api/cli", ["@dawn-ai/cli"]),
  referencePage("@dawn-ai/core", "/docs/api/core", ["@dawn-ai/core"]),
  referencePage("@dawn-ai/ag-ui", "/docs/api/ag-ui", ["@dawn-ai/ag-ui"]),
  referencePage("@dawn-ai/memory", "/docs/api/memory", ["@dawn-ai/memory"]),
  referencePage("@dawn-ai/memory-pgvector", "/docs/api/memory-pgvector", [
    "@dawn-ai/memory-pgvector",
  ]),
  referencePage("@dawn-ai/postgres-storage", "/docs/api/postgres-storage", [
    "@dawn-ai/postgres-storage",
  ]),
  referencePage("@dawn-ai/testing", "/docs/api/testing", ["@dawn-ai/testing"]),
  referencePage("@dawn-ai/evals", "/docs/api/evals", ["@dawn-ai/evals"]),
  referencePage("dawn:routes", "/docs/api/generated-routes", ["@dawn-ai/cli", "@dawn-ai/core"]),
  referencePage("@dawn-ai/permissions", "/docs/api/permissions", ["@dawn-ai/permissions"]),
  referencePage("@dawn-ai/workspace", "/docs/api/workspace", ["@dawn-ai/workspace"]),
] as const satisfies readonly ApiReferencePage[]

function referencePage(
  surfaceName: string,
  href: string,
  ownerPackageNames: readonly string[],
): ApiReferencePage {
  return {
    label: surfaceName,
    href,
    surfaceName,
    ownerPackageNames,
    parent: API_REFERENCE_PARENT,
  }
}
