import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { renderDawnTypes } from "../../../../../packages/core/src/typegen/render-route-types"
import {
  API_BEHAVIOR_CONTRACTS,
  API_REFERENCE_PAGES,
  API_REQUIRED_CONTRACT_KEYS,
  ARTIFACT_REGISTRY,
  artifactAddressFor,
  GENERATED_ROUTES_ARTIFACT,
} from "./api-reference"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../..")
const CHECK_DOCS_PATH = join(REPO_ROOT, "scripts/check-docs.mjs")

const foundationalPages = [
  { slug: "sdk", label: "@dawn-ai/sdk", href: "/docs/api/sdk" },
  { slug: "cli", label: "@dawn-ai/cli", href: "/docs/api/cli" },
  { slug: "core", label: "@dawn-ai/core", href: "/docs/api/core" },
  { slug: "generated-routes", label: "dawn:routes", href: "/docs/api/generated-routes" },
] as const

const packagePages = [
  { slug: "ag-ui", label: "@dawn-ai/ag-ui", href: "/docs/api/ag-ui" },
  { slug: "memory", label: "@dawn-ai/memory", href: "/docs/api/memory" },
  {
    slug: "memory-pgvector",
    label: "@dawn-ai/memory-pgvector",
    href: "/docs/api/memory-pgvector",
  },
  {
    slug: "postgres-storage",
    label: "@dawn-ai/postgres-storage",
    href: "/docs/api/postgres-storage",
  },
  { slug: "testing", label: "@dawn-ai/testing", href: "/docs/api/testing" },
  { slug: "evals", label: "@dawn-ai/evals", href: "/docs/api/evals" },
] as const
const allReferencePages = [...foundationalPages, ...packagePages] as const

interface WrapperContractAnalysis {
  readonly metadataTitle: string | null
  readonly contentImportTarget: string | null
  readonly docsPageImportTarget: string | null
  readonly docsPageHref: string | null
}

function analyzeWrapperContracts(sources: readonly string[]): readonly WrapperContractAnalysis[] {
  const result = spawnSync(process.execPath, [CHECK_DOCS_PATH, "--analyze-doc-titles"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input: JSON.stringify(sources.map((wrapperSource) => ({ mdxSource: "", wrapperSource }))),
  })
  expect(result.status, result.stderr || result.stdout).toBe(0)
  return JSON.parse(result.stdout) as readonly WrapperContractAnalysis[]
}

const foundationalSections = [
  "Use this when",
  "Install and import",
  "Compatibility and audience",
  "Public exports",
  "Key contracts",
  "Examples and related guides",
] as const

const foundationalPackageSlugs = new Map([
  ["@dawn-ai/sdk", "sdk"],
  ["@dawn-ai/cli", "cli"],
  ["@dawn-ai/core", "core"],
])

const foundationalCompatibilityRows = [
  ...ARTIFACT_REGISTRY.flatMap((artifact) => {
    const slug =
      "packageName" in artifact ? foundationalPackageSlugs.get(artifact.packageName) : null
    if (!slug) return []

    if (artifact.kind === "import" && artifact.surfaceKind === "typescript-runtime") {
      const surface =
        artifact.subpath === "."
          ? artifact.packageName
          : `${artifact.packageName}${artifact.subpath.slice(1)}`
      return [
        {
          slug,
          cells: [
            surface,
            artifact.runtime,
            artifact.purity,
            artifact.audience,
            artifact.stability,
          ],
        },
      ]
    }

    if (
      artifact.kind === "operated" &&
      artifact.packageName === "@dawn-ai/cli" &&
      artifact.selector === "bin.dawn"
    ) {
      return [
        {
          slug,
          cells: ["bin:dawn", artifact.runtime, "n/a", artifact.audience, artifact.stability],
        },
      ]
    }

    return []
  }),
  {
    slug: "generated-routes",
    cells: [
      GENERATED_ROUTES_ARTIFACT.moduleName,
      "generated types",
      GENERATED_ROUTES_ARTIFACT.audience,
      GENERATED_ROUTES_ARTIFACT.stability,
    ],
  },
]

function compatibilityRow(cells: readonly string[]): string {
  return `| ${cells.map((cell, index) => (index === 0 ? `\`${cell}\`` : cell)).join(" | ")} |`
}

function foundationalContent(slug: string): string {
  const path = join(REPO_ROOT, "apps/web/content/docs/api", `${slug}.mdx`)
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}

function foundationalWrapper(slug: string): string {
  const path = join(REPO_ROOT, "apps/web/app/docs/api", slug, "page.tsx")
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}

function packageExample(slug: string): string {
  const section = foundationalContent(slug).split("## Examples and related guides")[1] ?? ""
  const match = /```ts\n([\s\S]*?)\n```/.exec(section)
  if (!match?.[1]) throw new Error(`missing TypeScript example for ${slug}`)
  return match[1]
}

interface InventoryFixture {
  readonly name: string
  readonly packages: {
    readonly dir: string
    readonly packageJson: Record<string, unknown>
  }[]
  readonly artifacts: Record<string, unknown>[]
  readonly documents: {
    readonly href: string
    readonly path: string
    source: string
  }[]
  readonly behaviorContracts: BehaviorContractFixture[]
  requiredContractKeys?: string[]
  readonly generatedAuthorities?: GeneratedAuthorityFixture[]
  readonly files: Record<string, string>
}

interface GeneratedAuthorityFixture extends Record<string, unknown> {
  declarations: string
  moduleName: string
}

interface BehaviorContractFixture extends Record<string, unknown> {
  claim: string
  authorities: Record<string, unknown>[]
}

const ownershipRows = [
  ["agent", "Declare an agent route."],
  ["AgentConfig", "Configure an agent route."],
  ["PublicShape", "Describe the public result."],
  ["mode", "Expose the inferred execution mode."],
  ["Worker", "Run public work."],
  ["makeResult", "Create an inferred generic result."],
  ["MergedOptions", "Configure merged behavior."],
  ["sameParamProbe", "Lock merged same-parameter overload precedence."],
  ["specializedProbe", "Lock specialized overload precedence."],
  ["wildcardExport", "Configure wildcard behavior."],
  ["aliasExport", "Call `allow() | reject()` through the aliased helper."],
  ["defaultExport", "Call the default helper."],
] as const

function ownershipTable(
  rows: readonly (readonly [string, string])[] = ownershipRows,
  heading = "@dawn-ai/sdk",
): string {
  return [
    `### ${heading}`,
    "",
    "| Export | Responsibility |",
    "|---|---|",
    ...rows.map(([symbol, responsibility]) => `| \`${symbol}\` | ${responsibility} |`),
  ].join("\n")
}

function generatedOwnershipTable(symbols: readonly string[]): string {
  return [
    "### `dawn:routes`",
    "",
    "| Generated export | Responsibility |",
    "|---|---|",
    ...symbols.map((symbol) => `| \`${symbol}\` | Generated route contract. |`),
  ].join("\n")
}

const noStateGeneratedExports = [
  "DawnRoutePath",
  "DawnRouteParams",
  "DawnRouteTools",
  "RouteTools",
] as const

const stateGeneratedExports = [...noStateGeneratedExports, "DawnRouteState", "RouteState"] as const

const generatedManifest = {
  appRoot: "/fixture/app",
  routes: [
    {
      id: "/hello/[tenant]",
      pathname: "/hello/[tenant]",
      kind: "workflow",
      entryFile: "/fixture/app/hello/[tenant].ts",
      routeDir: "/fixture/app/hello/[tenant]",
      segments: [
        { kind: "static", value: "hello" },
        { kind: "dynamic", name: "tenant" },
      ],
    },
  ],
} as Parameters<typeof renderDawnTypes>[0]
const generatedToolTypes = [
  {
    pathname: "/hello/[tenant]",
    tools: [
      { name: "greet", description: "Greet the caller", inputType: "void", outputType: "string" },
    ],
  },
] as Parameters<typeof renderDawnTypes>[1]
const generatedStateTypes = [
  {
    pathname: "/hello/[tenant]",
    fields: [{ name: "status", type: '"ready" | "done"' }],
  },
] as NonNullable<Parameters<typeof renderDawnTypes>[2]>
const noStateGeneratedDeclarations = renderDawnTypes(generatedManifest, generatedToolTypes)
const stateGeneratedDeclarations = renderDawnTypes(
  generatedManifest,
  generatedToolTypes,
  generatedStateTypes,
)

const agentContract = `export declare function agent<TState extends object = Record<string, never>>(
  config: AgentConfig<TState>,
  options?: { strict: boolean },
  ...tools: readonly string[]
): DawnAgent<TState>
export declare function agent(config: AgentConfig<never>): DawnAgent<never>`

const agentContractFence = `\`\`\`ts api-contract="@dawn-ai/sdk#.:agent"
${agentContract}
\`\`\``

const contractFences = `
${agentContractFence}

\`\`\`ts api-contract="@dawn-ai/sdk#.:AgentConfig"
export interface AgentConfig<TState extends object = Record<string, never>> {
  readonly model?: KnownModelId
  readonly state?: TState
  readonly strategy?: "fast" | "slow"
}
\`\`\`

\`\`\`ts api-contract="@dawn-ai/sdk#.:PublicShape"
export interface PublicShape {
  readonly result?: ({ ok: true } & { value: string }) | { ok: false }
  transform?(input: string): number
  transform?(input: number): string
  label?: "a;b"
  message?: "a  b"
  template?: \`a  \${string};b\`
  code?: 1_000
  large?: 1_000n
}
\`\`\`

\`\`\`ts api-contract="@dawn-ai/sdk#.:mode"
export declare const mode: "fast"
\`\`\`

\`\`\`ts api-contract="@dawn-ai/sdk#.:Worker"
export declare abstract class Worker extends BaseWorker implements Runnable {
  constructor(name: string, attempts?: number)
  readonly status: "ready"
  run(input: string): number
  run(input: number): string
  abstract plan?(input: string): boolean
}
\`\`\`

\`\`\`ts api-contract="@dawn-ai/sdk#.:MergedOptions"
export interface MergedOptions extends BaseOptions {
  first: string
  parse(input: "specific"): "specific"
  select(input: string): "first"
}
export interface MergedOptions extends ExtraOptions {
  second?: number
  parse(input: string): "general"
  select(input: string): "second"
}
\`\`\`

\`\`\`ts api-contract="@dawn-ai/sdk#.:sameParamProbe"
export declare const sameParamProbe: "second"
\`\`\`

\`\`\`ts api-contract="@dawn-ai/sdk#.:specializedProbe"
export declare const specializedProbe: "specific"
\`\`\`

\`\`\`ts api-contract="@dawn-ai/sdk#.:makeResult"
export declare function makeResult<T>(value: T): { readonly value: T }
\`\`\`

\`\`\`ts api-contract="@dawn-ai/sdk#.:wildcardExport"
export declare const wildcardExport: { readonly mode?: "a" | "b" }
\`\`\`

\`\`\`ts api-contract="@dawn-ai/sdk#.:defaultExport"
export declare function defaultExport(input: string): boolean
\`\`\`
`

const agentConfigFieldTable = `**Fields: \`@dawn-ai/sdk#.:AgentConfig\`**
| Field | Type | Required | Description |
|---|---|---|---|
| \`readonly model\` | \`KnownModelId\` | no | Model used by the route. |
| \`readonly state\` | \`TState\` | no | Initial route state. |
| \`readonly strategy\` | \`"fast" \\| "slow"\` | no | Execution strategy. |`

const behaviorMarker =
  '{/* api-behavior-authorities: [{"kind":"source-ast","file":"packages/sdk/src/behavior.ts","selector":"BehaviorOptions.retries"},{"kind":"test-assertion","file":"packages/sdk/test/behavior.test.ts","testNames":["uses three retries","uses matrix","polls status"]}] */}'

const selectorMarker =
  '{/* api-behavior-authorities: [{"kind":"source-ast","file":"packages/sdk/src/behavior.ts","selector":"retryDefault"},{"kind":"source-ast","file":"packages/sdk/src/behavior.ts","selector":"Mode.Fast"},{"kind":"source-ast","file":"packages/sdk/src/behavior.ts","selector":"Limits.max"},{"kind":"source-ast","file":"packages/sdk/src/behavior.ts","selector":"behaviorMap.retry"},{"kind":"source-ast","file":"packages/sdk/src/behavior.ts","selector":"decide.branch[0]"}] */}'

function baseline(): InventoryFixture {
  return {
    name: "baseline",
    packages: [
      {
        dir: "packages/sdk",
        packageJson: {
          name: "@dawn-ai/sdk",
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              import: "./dist/index.js",
              default: "./dist/index.js",
            },
            "./package.json": "./package.json",
          },
        },
      },
    ],
    artifacts: [
      {
        kind: "import",
        packageName: "@dawn-ai/sdk",
        subpath: ".",
        coverage: "detailed",
        surfaceKind: "typescript-runtime",
        ownerHref: "/docs/api/sdk",
      },
      {
        kind: "import",
        packageName: "@dawn-ai/sdk",
        subpath: "./package.json",
        coverage: "catalog-only",
        surfaceKind: "metadata",
        ownerHref: "/docs/api/sdk",
      },
      {
        kind: "operated",
        packageName: "@dawn-ai/sdk",
        selector: "bin.dawn",
        coverage: "catalog-only",
        ownerHref: "/docs/api/sdk",
      },
    ],
    documents: [
      {
        href: "/docs/api/sdk",
        path: "docs/sdk.mdx",
        source: `# Alpha <em>Beta</em> \`<Tools>\` <https://dawn.example/api> <mailto:docs@dawn.example> <team@dawn.example>

${ownershipTable()}
${contractFences}

${agentConfigFieldTable}

#### Behavior contract \`sdk-retries\`
${behaviorMarker}
Agent routes retry failed model calls.

<Callout
  tone="warning"
>
Critical behavior.
</Callout>

##### Nested evidence

- Retries default to three attempts.

The literal \`\`<RelatedCards />\`\` remains behavior prose.

See <https://dawn.example/retry>, <mailto:help@dawn.example>, and <help@dawn.example>.

\`\`\`ts
// fenced prose is not part of the claim
\`\`\`

<RelatedCards
  title="More API reference"
  items={cards}
/>

#### Behavior contract \`sdk-options-shape\`
{/* api-behavior-authorities: [{"kind":"source-ast","file":"packages/sdk/src/behavior.ts","selector":"BehaviorOptions"}] */}
import {
  cards,
} from "./cards.js"
export const links = [
  cards,
]
import behavior remains visible.
export behavior remains visible.
Retry options expose the supported attempt range.

#### Behavior contract \`sdk-choice-branch\`
{/* api-behavior-authorities: [{"kind":"source-ast","file":"packages/sdk/src/behavior.ts","selector":"choose.branch[0]"}] */}
Active choices select the on branch.

#### Behavior contract \`sdk-selector-shapes\`
${selectorMarker}
Selector authorities cover public declaration shapes.

#### Unrelated contract
This prose is outside the behavior block.

<!--
${ownershipTable([["commentExport", "A comment decoy."]])}
\`\`\`ts api-contract="@dawn-ai/sdk#.:commentExport"
export declare const commentExport: string
\`\`\`
-->

\`\`\`md
${ownershipTable([["fencedExport", "A fence decoy."]])}
**Fields: \`@dawn-ai/sdk#.:Fenced\`**
\`\`\`

\`${ownershipTable([["inlineExport", "An inline decoy."]]).replaceAll("\n", " ")}\`
`,
      },
    ],
    requiredContractKeys: [
      "@dawn-ai/sdk#.:agent",
      "@dawn-ai/sdk#.:AgentConfig",
      "@dawn-ai/sdk#.:PublicShape",
      "@dawn-ai/sdk#.:mode",
      "@dawn-ai/sdk#.:Worker",
      "@dawn-ai/sdk#.:MergedOptions",
      "@dawn-ai/sdk#.:sameParamProbe",
      "@dawn-ai/sdk#.:specializedProbe",
      "@dawn-ai/sdk#.:makeResult",
      "@dawn-ai/sdk#.:wildcardExport",
      "@dawn-ai/sdk#.:defaultExport",
    ],
    behaviorContracts: [
      {
        id: "sdk-retries",
        ownerHref: "/docs/api/sdk",
        claim:
          "Agent routes retry failed model calls. Critical behavior. Nested evidence Retries default to three attempts. The literal <RelatedCards /> remains behavior prose. See https://dawn.example/retry, mailto:help@dawn.example, and help@dawn.example.",
        authorities: [
          {
            kind: "source-ast",
            file: "packages/sdk/src/behavior.ts",
            selector: "BehaviorOptions.retries",
            expected: "readonly retries?: 3 | 4",
          },
          {
            kind: "test-assertion",
            file: "packages/sdk/test/behavior.test.ts",
            testNames: ["uses three retries", "uses matrix", "polls status"],
            assertionFingerprint:
              'expect(run()).not.toEqual({ retries: 4 })\nawait expect(Promise.resolve(run())).resolves.toEqual({ retries: 3 })\nawait expect(Promise.reject(new Error("no"))).rejects.toThrow("no")\nexpect(value).toBe(3)\nexpect.poll(() => run()).toBe("a;b")\nawait expect.poll(() => run()).toBe("a  b;")\nexpect("a  b").toMatch(/a  b/)',
          },
        ],
      },
      {
        id: "sdk-options-shape",
        ownerHref: "/docs/api/sdk",
        claim:
          "import behavior remains visible. export behavior remains visible. Retry options expose the supported attempt range.",
        authorities: [
          {
            kind: "source-ast",
            file: "packages/sdk/src/behavior.ts",
            selector: "BehaviorOptions",
            expected: "export interface BehaviorOptions { readonly retries?: 3 | 4; }",
          },
        ],
      },
      {
        id: "sdk-choice-branch",
        ownerHref: "/docs/api/sdk",
        claim: "Active choices select the on branch.",
        authorities: [
          {
            kind: "source-ast",
            file: "packages/sdk/src/behavior.ts",
            selector: "choose.branch[0]",
            expected: 'if (active) return "on";',
          },
        ],
      },
      {
        id: "sdk-selector-shapes",
        ownerHref: "/docs/api/sdk",
        claim: "Selector authorities cover public declaration shapes.",
        authorities: [
          {
            kind: "source-ast",
            file: "packages/sdk/src/behavior.ts",
            selector: "retryDefault",
            expected: "export const retryDefault = 3;",
          },
          {
            kind: "source-ast",
            file: "packages/sdk/src/behavior.ts",
            selector: "Mode.Fast",
            expected: 'Fast = "fast"',
          },
          {
            kind: "source-ast",
            file: "packages/sdk/src/behavior.ts",
            selector: "Limits.max",
            expected: "export const max = 4;",
          },
          {
            kind: "source-ast",
            file: "packages/sdk/src/behavior.ts",
            selector: "behaviorMap.retry",
            expected: "retry: 3",
          },
          {
            kind: "source-ast",
            file: "packages/sdk/src/behavior.ts",
            selector: "decide.branch[0]",
            expected: 'if (active) return "on";',
          },
        ],
      },
    ],
    files: {
      "packages/sdk/src/index.ts": `
export { agent } from "./agent.js"
export type { AgentConfig, PublicShape } from "./agent.js"
export * from "./extra.js"
export { renamed as aliasExport } from "./alias.js"
export { default as defaultExport } from "./default.js"
import { importedOnly } from "./imported.js"
const privateOnly = importedOnly
void privateOnly
`,
      "packages/sdk/src/agent.ts": `
type KnownModelId = "gpt-5-mini" | "gpt-5.4"
interface DawnAgent<TState> { readonly state: TState }
export interface AgentConfig<TState extends object = Record<string, never>> {
  readonly model?: KnownModelId
  readonly state?: TState
  readonly strategy?: "fast" | "slow"
}
export interface PublicShape {
  readonly result?: ({ ok: true } & { value: string }) | { ok: false }
  transform?(input: string): number
  transform?(input: number): string
  label?: "a;b"
  message?: "a  b"
  template?: \`a  \${string};b\`
  code?: 1_000
  large?: 1_000n
}
export function agent<TState extends object = Record<string, never>>(
  config: AgentConfig<TState>,
  options?: { strict: boolean },
  ...tools: readonly string[]
): DawnAgent<TState>
export function agent(config: AgentConfig<never>): DawnAgent<never>
export function agent(config: AgentConfig<object>): DawnAgent<object> {
  return { state: config.state ?? {} }
}
`,
      "packages/sdk/src/extra.ts": `
export const wildcardExport: { readonly mode?: "a" | "b" } = { mode: "a" }
export const mode = "fast"
interface Runnable { run(input: string): number }
class BaseWorker { readonly base = true }
export abstract class Worker extends BaseWorker implements Runnable {
  readonly status = "ready"
  private secret = 1
  protected internal = 2
  constructor(name: string, attempts?: number) { super(); void name; void attempts }
  run(input: string): number
  run(input: number): string
  run(input: string | number) { return typeof input === "string" ? input.length : String(input) }
  abstract plan?(input: string): boolean
}
export function makeResult<T>(value: T) { return { value } as const }
interface BaseOptions { readonly base?: boolean }
interface ExtraOptions { readonly extra?: string }
export interface MergedOptions extends BaseOptions {
  first: string
  parse(input: "specific"): "specific"
  select(input: string): "first"
}
export interface MergedOptions extends ExtraOptions {
  second?: number
  parse(input: string): "general"
  select(input: string): "second"
}
declare const mergedOptions: MergedOptions
export const sameParamProbe = mergedOptions.select("input")
export const specializedProbe = mergedOptions.parse("specific")
const privateSameName = "agent"
void privateSameName
`,
      "packages/sdk/src/alias.ts":
        "export function renamed(value: string): number { return value.length }\n",
      "packages/sdk/src/default.ts":
        "export default function defaultThing(input: string): boolean { return input.length > 0 }\n",
      "packages/sdk/src/imported.ts": "export const importedOnly = true\n",
      "packages/sdk/src/private.ts": "export const agent = 'private same-name decoy'\n",
      "packages/sdk/src/behavior.ts": `
export interface BehaviorOptions {
  readonly retries?: 3 | 4
}
export function choose(active: boolean): "on" | "off" {
  if (active) return "on"
  return "off"
}
export const retryDefault = 3
export enum Mode { Fast = "fast", Slow = "slow" }
export namespace Limits { export const max = 4 }
export const behaviorMap = { retry: 3, mode: "fast" }
export const decide = (active: boolean): "on" | "off" => {
  if (active) return "on"
  return "off"
}
`,
      "packages/sdk/test/behavior.test.ts": `
import { expect, it, test } from "vitest"
declare function run(): unknown
test("uses three retries", async () => {
  expect(run()).not.toEqual({ retries: 4 })
  await expect(Promise.resolve(run())).resolves.toEqual({ retries: 3 })
  await expect(Promise.reject(new Error("no"))).rejects.toThrow("no")
})
it.each([[3]])("uses matrix", (value) => {
  expect(value).toBe(3)
})
test("marker without assertion", () => {})
test("polls status", async () => {
  expect.poll(() => run()).toBe("a;b")
  await expect.poll(() => run()).toBe("a  b;")
  expect("a  b").toMatch(/a  b/)
})
`,
    },
  }
}

function mutated(name: string, mutate: (fixture: InventoryFixture) => void): InventoryFixture {
  const fixture = structuredClone(baseline())
  ;(fixture as { name: string }).name = name
  mutate(fixture)
  return fixture
}

function generatedFixture(
  name: string,
  declarations: string,
  symbols: readonly string[] | null,
): InventoryFixture {
  const fixture: InventoryFixture = {
    name,
    packages: [],
    artifacts: [structuredClone(GENERATED_ROUTES_ARTIFACT)],
    documents: [],
    behaviorContracts: [],
    files: {},
    generatedAuthorities: [
      {
        moduleName: GENERATED_ROUTES_ARTIFACT.moduleName,
        declarations,
      },
    ],
  }
  if (symbols) {
    fixture.documents.push({
      href: GENERATED_ROUTES_ARTIFACT.ownerHref,
      path: "docs/generated-routes.mdx",
      source: generatedOwnershipTable(symbols),
    })
  }
  return fixture
}

function replaceDoc(fixture: InventoryFixture, from: string, to: string): void {
  const document = fixture.documents[0]
  if (!document) throw new Error("baseline document missing")
  document.source = document.source.replace(from, to)
}

function replaceFile(fixture: InventoryFixture, path: string, from: string, to: string): void {
  const source = fixture.files[path]
  if (source === undefined) throw new Error(`baseline file missing: ${path}`)
  fixture.files[path] = source.replace(from, to)
}

function swapDoc(fixture: InventoryFixture, first: string, second: string): void {
  const marker = "__SWAPPED_API_OVERLOAD__"
  replaceDoc(fixture, first, marker)
  replaceDoc(fixture, second, first)
  replaceDoc(fixture, marker, second)
}

function appendToPrimaryDoc(fixture: InventoryFixture, source: string): void {
  const document = fixture.documents[0]
  if (!document) throw new Error("baseline document missing")
  document.source += `\n${source}\n`
}

function sdkRetriesBlock(marker = behaviorMarker): string {
  return `#### Behavior contract \`sdk-retries\`
${marker}
Agent routes retry failed model calls.

<Callout>Critical behavior.</Callout>

##### Nested evidence

- Retries default to three attempts.`
}

function firstBehaviorContract(fixture: InventoryFixture): BehaviorContractFixture {
  const contract = fixture.behaviorContracts[0]
  if (!contract) throw new Error("baseline behavior contract missing")
  return contract
}

const mutationFixtures: InventoryFixture[] = [
  baseline(),
  mutated("duplicate-owner", (fixture) => {
    fixture.documents.push({
      href: "/fixture/sdk-copy",
      path: "docs/sdk-copy.mdx",
      source: ownershipTable([["agent", "Duplicate ownership."]]),
    })
  }),
  mutated("missing-source-symbol", (fixture) => {
    replaceDoc(fixture, "| `agent` | Declare an agent route. |", "| `ghost` | Declare a ghost. |")
  }),
  mutated("undocumented-export", (fixture) => {
    const path = "packages/sdk/src/index.ts"
    fixture.files[path] = `${fixture.files[path] ?? ""}\nexport const undocumented = true\n`
  }),
  mutated("stale-documented-export", (fixture) => {
    replaceDoc(
      fixture,
      "| `agent` | Declare an agent route. |",
      "| `agent` | Declare an agent route. |\n| `stale` | A stale export. |",
    )
    replaceDoc(
      fixture,
      contractFences,
      `${contractFences}\n\`\`\`ts api-contract="@dawn-ai/sdk#.:stale"\nexport declare const stale: string\n\`\`\``,
    )
  }),
  mutated("contract-table-key-mismatch", (fixture) => {
    replaceDoc(
      fixture,
      'api-contract="@dawn-ai/sdk#.:agent"',
      'api-contract="@dawn-ai/sdk#.:ghost"',
    )
  }),
  mutated("duplicate-contract", (fixture) => {
    appendToPrimaryDoc(fixture, agentContractFence)
  }),
  mutated("orphan-contract", (fixture) => {
    replaceDoc(fixture, "| `agent` | Declare an agent route. |", "")
  }),
  mutated("contract-inferred-literal", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/extra.ts", 'mode = "fast"', 'mode = "slow"')
  }),
  mutated("contract-class-public", (fixture) => {
    replaceFile(
      fixture,
      "packages/sdk/src/extra.ts",
      "run(input: number): string",
      "run(input: number): boolean",
    )
  }),
  mutated("contract-class-constructor-added", (fixture) => {
    replaceDoc(fixture, "constructor(name: string, attempts?: number)\n", "")
  }),
  mutated("contract-class-constructor-removed", (fixture) => {
    replaceFile(
      fixture,
      "packages/sdk/src/extra.ts",
      "  constructor(name: string, attempts?: number) { super(); void name; void attempts }\n",
      "",
    )
  }),
  mutated("contract-class-constructor-type", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/extra.ts", "name: string", "name: number")
  }),
  mutated("contract-class-constructor-optional", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/extra.ts", "attempts?: number", "attempts: number")
  }),
  mutated("contract-class-extends", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/extra.ts", "extends BaseWorker", "")
  }),
  mutated("contract-class-implements", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/extra.ts", " implements Runnable", "")
  }),
  mutated("contract-interface-merge-second", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/extra.ts", "second?: number", "second?: string")
  }),
  mutated("contract-interface-merge-conflict", (fixture) => {
    replaceFile(
      fixture,
      "packages/sdk/src/extra.ts",
      "export interface MergedOptions extends ExtraOptions {\n  second?: number",
      "export interface MergedOptions extends ExtraOptions {\n  first: number\n  second?: number",
    )
  }),
  mutated("contract-interface-merge-metadata", (fixture) => {
    replaceFile(
      fixture,
      "packages/sdk/src/extra.ts",
      "export interface MergedOptions extends ExtraOptions",
      "export interface MergedOptions<T> extends ExtraOptions",
    )
  }),
  mutated("contract-interface-merge-removed", (fixture) => {
    replaceDoc(
      fixture,
      `export interface MergedOptions extends ExtraOptions {
  second?: number
  parse(input: string): "general"
  select(input: string): "second"
}
`,
      "",
    )
  }),
  mutated("contract-interface-overload-specificity-order", (fixture) => {
    swapDoc(fixture, 'parse(input: "specific"): "specific"', 'parse(input: string): "general"')
  }),
  mutated("contract-interface-overload-return-order", (fixture) => {
    swapDoc(fixture, 'select(input: string): "first"', 'select(input: string): "second"')
  }),
  mutated("contract-interface-combined-wrong-return-order", (fixture) => {
    replaceDoc(
      fixture,
      `export interface MergedOptions extends BaseOptions {
  first: string
  parse(input: "specific"): "specific"
  select(input: string): "first"
}
export interface MergedOptions extends ExtraOptions {
  second?: number
  parse(input: string): "general"
  select(input: string): "second"
}`,
      `export interface MergedOptions extends BaseOptions, ExtraOptions {
  first: string
  second?: number
  parse(input: "specific"): "specific"
  parse(input: string): "general"
  select(input: string): "first"
  select(input: string): "second"
}`,
    )
  }),
  mutated("combined-interface-specialized-precedence", (fixture) => {
    replaceDoc(
      fixture,
      `export interface MergedOptions extends BaseOptions {
  first: string
  parse(input: "specific"): "specific"
  select(input: string): "first"
}
export interface MergedOptions extends ExtraOptions {
  second?: number
  parse(input: string): "general"
  select(input: string): "second"
}`,
      `export interface MergedOptions extends BaseOptions, ExtraOptions {
  first: string
  second?: number
  parse(input: string): "general"
  parse(input: "specific"): "specific"
  select(input: string): "second"
  select(input: string): "first"
}`,
    )
  }),
  mutated("contract-unsupported-merge", (fixture) => {
    fixture.files["packages/sdk/src/extra.ts"] +=
      "\nexport namespace Worker { export const version = 1 }\n"
  }),
  mutated("contract-inferred-return", (fixture) => {
    replaceFile(
      fixture,
      "packages/sdk/src/extra.ts",
      "return { value } as const",
      "return { item: value } as const",
    )
  }),
  mutated("contract-parse-error", (fixture) => {
    replaceDoc(fixture, 'readonly status: "ready"', 'readonly status: "ready')
  }),
  mutated("contract-tag-spacing", (fixture) => {
    replaceDoc(fixture, "ts api-contract=", "ts  api-contract=")
  }),
  mutated("contract-tag-malformed-key", (fixture) => {
    replaceDoc(
      fixture,
      'api-contract="@dawn-ai/sdk#.:mode"',
      'api-contract = "@dawn-ai/sdk#.:mode"',
    )
  }),
  mutated("contract-tag-colon", (fixture) => {
    replaceDoc(fixture, "ts api-contract=", "ts api-contract:")
  }),
  mutated("contract-tag-braces", (fixture) => {
    replaceDoc(fixture, "ts api-contract=", "ts {api-contract}=")
  }),
  mutated("contract-tag-comma", (fixture) => {
    replaceDoc(fixture, "ts api-contract=", "ts api-contract,=")
  }),
  mutated("contract-tag-standalone", (fixture) => {
    replaceDoc(fixture, 'ts api-contract="@dawn-ai/sdk#.:agent"', "ts api-contract")
  }),
  mutated("contract-interface-method-optional", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/agent.ts", "transform?(input", "transform(input")
  }),
  mutated("contract-class-method-optional", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/extra.ts", "plan?(input", "plan(input")
  }),
  mutated("contract-class-method-abstract", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/extra.ts", "abstract plan?", "plan?")
  }),
  mutated("contract-type-literal-semicolon", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/agent.ts", 'label?: "a;b"', 'label?: "ab"')
  }),
  mutated("contract-type-literal-spacing", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/agent.ts", 'message?: "a  b"', 'message?: "a b"')
  }),
  mutated("contract-type-template-spacing", (fixture) => {
    replaceFile(
      fixture,
      "packages/sdk/src/agent.ts",
      "template?: `a  $" + "{string};b`",
      "template?: `a $" + "{string};b`",
    )
  }),
  mutated("contract-type-numeric-drift", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/agent.ts", "code?: 1_000", "code?: 1001")
  }),
  mutated("contract-type-bigint-drift", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/agent.ts", "large?: 1_000n", "large?: 1001n")
  }),
  mutated("contract-class-method-overload", (fixture) => {
    replaceDoc(fixture, "  run(input: number): string\n", "")
  }),
  mutated("contract-class-implementation-only", (fixture) => {
    replaceFile(
      fixture,
      "packages/sdk/src/extra.ts",
      "  run(input: string): number\n  run(input: number): string\n",
      "",
    )
  }),
  ...(
    [
      ["generic-constraint", "TState extends object", "TState extends string"],
      ["generic-default", "Record<string, never>", "Record<string, string>"],
      ["parameter-name", "config: AgentConfig<TState>", "configuration: AgentConfig<TState>"],
      ["parameter-type", "options?: { strict: boolean }", "options?: { strict: string }"],
      ["parameter-optionality", "options?: { strict: boolean }", "options: { strict: boolean }"],
      ["parameter-rest", "...tools: readonly string[]", "tools: readonly string[]"],
      ["return-type", "): DawnAgent<TState>", "): Promise<DawnAgent<TState>>"],
    ] as const
  ).map(([name, from, to]) =>
    mutated(`contract-${name}`, (fixture) => replaceDoc(fixture, from, to)),
  ),
  mutated("contract-overload", (fixture) => {
    replaceDoc(
      fixture,
      "\nexport declare function agent(config: AgentConfig<never>): DawnAgent<never>",
      "",
    )
  }),
  ...(
    [
      ["interface-field-name", "readonly result?", "readonly response?"],
      ["interface-field-type", "value: string", "value: number"],
      ["interface-field-readonly", "readonly result?", "result?"],
      ["interface-field-optionality", "readonly result?", "readonly result"],
      ["interface-field-union", "| { ok: false }", '| { ok: "no" }'],
      ["interface-field-intersection", "& { value: string }", "& { value: number }"],
    ] as const
  ).map(([name, from, to]) =>
    mutated(`contract-${name}`, (fixture) => replaceDoc(fixture, from, to)),
  ),
  mutated("field-name", (fixture) => {
    replaceDoc(
      fixture,
      "| `readonly model` | `KnownModelId` | no |",
      "| `readonly engine` | `KnownModelId` | no |",
    )
  }),
  mutated("field-type", (fixture) => {
    replaceDoc(
      fixture,
      "| `readonly model` | `KnownModelId` | no |",
      "| `readonly model` | `string` | no |",
    )
  }),
  mutated("field-required", (fixture) => {
    replaceDoc(
      fixture,
      "| `readonly model` | `KnownModelId` | no |",
      "| `readonly model` | `KnownModelId` | yes |",
    )
  }),
  mutated("field-readonly-authored", (fixture) => {
    replaceDoc(fixture, "| `readonly model` |", "| `model` |")
  }),
  mutated("field-readonly-source", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/agent.ts", "readonly model?", "model?")
  }),
  mutated("field-union", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/agent.ts", '"fast" | "slow"', '"fast" | "safe"')
  }),
  mutated("duplicate-field-table", (fixture) => {
    appendToPrimaryDoc(fixture, agentConfigFieldTable)
  }),
  mutated("orphan-field-table", (fixture) => {
    replaceDoc(fixture, "| `AgentConfig` | Configure an agent route. |", "")
  }),
  mutated("field-caption-removed", (fixture) => {
    replaceDoc(fixture, "**Fields: `@dawn-ai/sdk#.:AgentConfig`**\n", "")
  }),
  mutated("field-caption-malformed", (fixture) => {
    replaceDoc(fixture, "**Fields: `@dawn-ai/sdk#.:AgentConfig`**", "**Field: AgentConfig**")
  }),
  mutated("field-header-optional", (fixture) => {
    replaceDoc(
      fixture,
      "| Field | Type | Required | Description |",
      "| Field | Type | Optional | Description |",
    )
  }),
  mutated("field-separator-malformed", (fixture) => {
    replaceDoc(fixture, "|---|---|---|---|", "|---|---|--|---|")
  }),
  mutated("field-table-empty", (fixture) => {
    replaceDoc(
      fixture,
      '| `readonly model` | `KnownModelId` | no | Model used by the route. |\n| `readonly state` | `TState` | no | Initial route state. |\n| `readonly strategy` | `"fast" \\| "slow"` | no | Execution strategy. |',
      "",
    )
  }),
  mutated("field-table-malformed-row", (fixture) => {
    replaceDoc(fixture, "| `readonly model` |", "| model |")
  }),
  mutated("field-table-malformed-columns", (fixture) => {
    replaceDoc(
      fixture,
      "| `readonly state` | `TState` | no | Initial route state. |",
      "| `readonly state` | `TState` | no |",
    )
  }),
  mutated("foreign-contract-key", (fixture) => {
    fixture.documents.push({
      href: "/fixture/foreign",
      path: "docs/foreign.mdx",
      source:
        '```ts api-contract="@dawn-ai/foreign#.:ghost"\nexport declare const ghost: string\n```',
    })
  }),
  mutated("malformed-contract-key", (fixture) => {
    fixture.documents.push({
      href: "/fixture/malformed",
      path: "docs/malformed.mdx",
      source: '```ts api-contract="not-an-address"\nexport declare const ghost: string\n```',
    })
  }),
  mutated("foreign-field-key", (fixture) => {
    fixture.documents.push({
      href: "/fixture/foreign-fields",
      path: "docs/foreign-fields.mdx",
      source: `**Fields: \`@dawn-ai/foreign#.:Ghost\`**
| Field | Type | Required | Description |
|---|---|---|---|
| \`value\` | \`string\` | yes | A foreign field. |`,
    })
  }),
  mutated("malformed-field-key", (fixture) => {
    fixture.documents.push({
      href: "/fixture/malformed-fields",
      path: "docs/malformed-fields.mdx",
      source: `**Fields: \`not-an-address\`**
| Field | Type | Required | Description |
|---|---|---|---|
| \`value\` | \`string\` | yes | A malformed field. |`,
    })
  }),
  mutated("split-contract-owner-page", (fixture) => {
    replaceDoc(fixture, agentContractFence, "")
    fixture.documents.push({
      href: "/fixture/other",
      path: "docs/other-contract.mdx",
      source: agentContractFence,
    })
  }),
  mutated("split-field-owner-page", (fixture) => {
    replaceDoc(fixture, agentConfigFieldTable, "")
    fixture.documents.push({
      href: "/fixture/other",
      path: "docs/other-fields.mdx",
      source: agentConfigFieldTable,
    })
  }),
  mutated("foreign-ownership-key", (fixture) => {
    fixture.documents.push({
      href: "/fixture/foreign-owner",
      path: "docs/foreign-owner.mdx",
      source: ownershipTable([["Ghost", "A foreign owner."]], "@x/foreign"),
    })
  }),
  mutated("malformed-ownership-key", (fixture) => {
    fixture.documents.push({
      href: "/fixture/malformed-owner",
      path: "docs/malformed-owner.mdx",
      source: ownershipTable([["Ghost", "A malformed owner."]], "not-an-address"),
    })
  }),
  mutated("ownership-wrong-owner-page", (fixture) => {
    replaceDoc(fixture, ownershipTable(), "")
    fixture.documents.push({
      href: "/fixture/wrong-owner",
      path: "docs/wrong-owner.mdx",
      source: ownershipTable(),
    })
  }),
  mutated("removed-subpath", (fixture) => {
    const manifest = fixture.packages[0]?.packageJson as {
      exports: Record<string, unknown>
    }
    delete manifest.exports["."]
  }),
  mutated("wrong-target", (fixture) => {
    const manifest = fixture.packages[0]?.packageJson as {
      exports: Record<string, { types: string }>
    }
    const rootExport = manifest.exports["."]
    if (!rootExport) throw new Error("baseline root export missing")
    rootExport.types = "./dist/wrong.d.ts"
  }),
  mutated("behavior-claim", (fixture) => {
    firstBehaviorContract(fixture).claim = "Agent routes never retry failed model calls."
  }),
  mutated("behavior-autolink-claim", (fixture) => {
    firstBehaviorContract(fixture).claim = firstBehaviorContract(fixture).claim.replace(
      "https://dawn.example/retry",
      "https://dawn.example/changed",
    )
  }),
  mutated("behavior-component-claim", (fixture) => {
    firstBehaviorContract(fixture).claim =
      "Agent routes retry failed model calls. Nested evidence Retries default to three attempts."
  }),
  mutated("behavior-source-expectation", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/behavior.ts", "3 | 4", "3 | 5")
  }),
  mutated("behavior-test-expectation", (fixture) => {
    replaceFile(fixture, "packages/sdk/test/behavior.test.ts", "toBe(3)", "toBe(4)")
  }),
  mutated("behavior-test-poll-spacing", (fixture) => {
    replaceFile(fixture, "packages/sdk/test/behavior.test.ts", 'toBe("a  b;")', 'toBe("a b;")')
  }),
  mutated("behavior-test-poll-semicolon", (fixture) => {
    replaceFile(fixture, "packages/sdk/test/behavior.test.ts", 'toBe("a  b;")', 'toBe("a  b")')
  }),
  mutated("behavior-test-regex-spacing", (fixture) => {
    replaceFile(fixture, "packages/sdk/test/behavior.test.ts", "toMatch(/a  b/)", "toMatch(/a b/)")
  }),
  mutated("behavior-marker-only", (fixture) => {
    replaceFile(
      fixture,
      "packages/sdk/test/behavior.test.ts",
      "expect(run()).not.toEqual({ retries: 4 })",
      "void run()",
    )
  }),
  mutated("behavior-authority-removed", (fixture) => {
    firstBehaviorContract(fixture).authorities.pop()
  }),
  mutated("behavior-marker-removed", (fixture) => {
    replaceDoc(fixture, behaviorMarker, "")
  }),
  mutated("behavior-marker-changed", (fixture) => {
    replaceDoc(fixture, '"selector":"BehaviorOptions.retries"', '"selector":"BehaviorOptions.mode"')
  }),
  mutated("behavior-html-marker", (fixture) => {
    replaceDoc(fixture, behaviorMarker, `${behaviorMarker.slice(3, -3).replace(/^ /, "<!-- ")} -->`)
  }),
  mutated("behavior-marker-not-immediate", (fixture) => {
    replaceDoc(fixture, behaviorMarker, `Prose before marker.\n${behaviorMarker}`)
  }),
  mutated("behavior-contract-extra-field", (fixture) => {
    firstBehaviorContract(fixture).unexpected = true
  }),
  mutated("behavior-source-declaration", (fixture) => {
    replaceFile(
      fixture,
      "packages/sdk/src/behavior.ts",
      "readonly retries?: 3 | 4",
      "readonly retries?: 3 | 4\n  readonly enabled?: boolean",
    )
  }),
  mutated("behavior-source-branch", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/behavior.ts", 'return "on"', 'return "enabled"')
  }),
  mutated("behavior-selector-variable", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/behavior.ts", "retryDefault = 3", "retryDefault = 5")
  }),
  mutated("behavior-selector-variable-kind", (fixture) => {
    replaceFile(
      fixture,
      "packages/sdk/src/behavior.ts",
      "export const retryDefault",
      "export let retryDefault",
    )
  }),
  mutated("behavior-selector-enum", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/behavior.ts", 'Fast = "fast"', 'Fast = "quick"')
  }),
  mutated("behavior-selector-namespace", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/behavior.ts", "max = 4", "max = 5")
  }),
  mutated("behavior-selector-namespace-kind", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/behavior.ts", "export const max", "export let max")
  }),
  mutated("behavior-selector-object", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/behavior.ts", "retry: 3", "retry: 5")
  }),
  mutated("behavior-selector-arrow-branch", (fixture) => {
    replaceFile(
      fixture,
      "packages/sdk/src/behavior.ts",
      'decide = (active: boolean): "on" | "off" => {\n  if (active)',
      'decide = (active: boolean): "on" | "off" => {\n  if (!active)',
    )
  }),
  mutated("behavior-selector-ambiguous", (fixture) => {
    fixture.files["packages/sdk/src/behavior.ts"] += "\nexport const retryDefault = 3\n"
  }),
  mutated("behavior-duplicate-test-name", (fixture) => {
    fixture.files["packages/sdk/test/behavior.test.ts"] +=
      '\ntest("uses three retries", () => expect(run()).toBeDefined())\n'
  }),
  mutated("behavior-await", (fixture) => {
    replaceFile(
      fixture,
      "packages/sdk/test/behavior.test.ts",
      "await expect(Promise.resolve(run()))",
      "expect(Promise.resolve(run()))",
    )
  }),
  mutated("duplicate-behavior-id", (fixture) => {
    appendToPrimaryDoc(fixture, sdkRetriesBlock())
  }),
  mutated("duplicate-behavior-invalid-first", (fixture) => {
    replaceDoc(fixture, behaviorMarker, "")
    appendToPrimaryDoc(fixture, sdkRetriesBlock())
  }),
  mutated("invalid-backtick-info-visible", (fixture) => {
    appendToPrimaryDoc(
      fixture,
      `\`\`\`md \`invalid\`
${ownershipTable([["Ghost", "This visible decoy must be rejected."]], "@x/foreign")}`,
    )
  }),
]

const acceptanceFixtures: InventoryFixture[] = [
  mutated("leading-underscore-public-exports", (fixture) => {
    replaceDoc(
      fixture,
      "| `defaultExport` | Call the default helper. |",
      "| `defaultExport` | Call the default helper. |\n| `__testHook` | Reset test state. |\n| `___literalName` | Preserve a literal triple-underscore name. |",
    )
    fixture.files["packages/sdk/src/index.ts"] +=
      "\nexport const __testHook = true\nexport const ___literalName = true\n"
  }),
  mutated("leading-underscore-owner-mutation", (fixture) => {
    replaceDoc(
      fixture,
      "| `defaultExport` | Call the default helper. |",
      "| `defaultExport` | Call the default helper. |\n| `___testHook` | Wrong escaped spelling. |",
    )
    fixture.files["packages/sdk/src/index.ts"] += "\nexport const __testHook = true\n"
  }),
  mutated("nested-contract-fence-decoy", (fixture) => {
    appendToPrimaryDoc(
      fixture,
      `\`\`\`\`md
\`\`\`ts api-contract="@x/foreign#.:Ghost"
export declare const Ghost: string
\`\`\`
\`\`\`\``,
    )
  }),
  mutated("tilde-info-backtick-decoy", (fixture) => {
    appendToPrimaryDoc(
      fixture,
      `~~~md \`valid\`
${ownershipTable([["Ghost", "This fenced decoy must be ignored."]], "@x/foreign")}
~~~`,
    )
  }),
  mutated("unescaped-code-span-pipe", (fixture) => {
    replaceDoc(fixture, '`"fast" \\| "slow"`', '`"fast" | "slow"`')
  }),
  mutated("class-private-details-ignored", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/extra.ts", "secret = 1", 'secret = "hidden"')
    replaceFile(fixture, "packages/sdk/src/extra.ts", "internal = 2", "internal = false")
  }),
  mutated("executable-typescript-example", (fixture) => {
    appendToPrimaryDoc(
      fixture,
      `\`\`\`ts
import { agent } from "@dawn-ai/sdk"
const route = agent({ model: "gpt-5-mini" })
console.log(route)
\`\`\``,
    )
  }),
  mutated("contract-tag-removed", (fixture) => {
    replaceDoc(fixture, '```ts api-contract="@dawn-ai/sdk#.:mode"', "```ts")
  }),
  mutated("required-contract-key-removed", (fixture) => {
    fixture.requiredContractKeys = [...(fixture.requiredContractKeys ?? []).slice(1)]
  }),
  mutated("required-contract-key-duplicated", (fixture) => {
    fixture.requiredContractKeys = [...(fixture.requiredContractKeys ?? []), "@dawn-ai/sdk#.:agent"]
  }),
  mutated("required-contract-key-stale", (fixture) => {
    fixture.requiredContractKeys = [...(fixture.requiredContractKeys ?? []), "@dawn-ai/sdk#.:Ghost"]
  }),
  mutated("required-contract-key-substituted-with-fence", (fixture) => {
    fixture.requiredContractKeys = (fixture.requiredContractKeys ?? []).map((key) =>
      key === "@dawn-ai/sdk#.:mode" ? "@dawn-ai/sdk#.:wildcardExport" : key,
    )
    replaceDoc(
      fixture,
      '```ts api-contract="@dawn-ai/sdk#.:mode"',
      '```ts api-contract="@dawn-ai/sdk#.:wildcardExport"',
    )
  }),
  mutated("api-contract-substring-metadata", (fixture) => {
    appendToPrimaryDoc(
      fixture,
      `\`\`\`ts title="api-contract example"
export declare const mode: "fast"
\`\`\`

\`\`\`ts data-api-contract="example"
export declare const mode: "fast"
\`\`\`

\`\`\`ts api-contractual="example"
export declare const mode: "fast"
\`\`\``,
    )
  }),
  mutated("api-contract-bare-metadata-values", (fixture) => {
    appendToPrimaryDoc(
      fixture,
      `\`\`\`ts title=api-contract
export declare const mode: "fast"
\`\`\`

\`\`\`ts label:api-contract
export declare const mode: "fast"
\`\`\`

\`\`\`ts label:"api-contract"
export declare const mode: "fast"
\`\`\``,
    )
  }),
  mutated("ordinary-untagged-table", (fixture) => {
    appendToPrimaryDoc(
      fixture,
      `| Field | Type | Optional | Description |
|---|---|---|---|
| name | string | no | Ordinary prose table. |`,
    )
  }),
  mutated("combined-interface-contract", (fixture) => {
    replaceDoc(
      fixture,
      `export interface MergedOptions extends BaseOptions {
  first: string
  parse(input: "specific"): "specific"
  select(input: string): "first"
}
export interface MergedOptions extends ExtraOptions {
  second?: number
  parse(input: string): "general"
  select(input: string): "second"
}`,
      `export interface MergedOptions extends BaseOptions, ExtraOptions {
  first: string
  second?: number
  parse(input: "specific"): "specific"
  parse(input: string): "general"
  select(input: string): "second"
  select(input: string): "first"
}`,
    )
  }),
  mutated("interface-layout-reordered", (fixture) => {
    replaceDoc(
      fixture,
      `export interface MergedOptions extends BaseOptions {
  first: string
  parse(input: "specific"): "specific"
  select(input: string): "first"
}
export interface MergedOptions extends ExtraOptions {
  second?: number
  parse(input: string): "general"
  select(input: string): "second"
}`,
      `export interface MergedOptions extends ExtraOptions {
  select(input: string): "first"
  second?: number
  parse(input: "specific"): "specific"
}
export interface MergedOptions extends BaseOptions {
  parse(input: string): "general"
  first: string
  select(input: string): "second"
}`,
    )
  }),
  mutated("semantic-numeric-decimal", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/agent.ts", "code?: 1_000", "code?: 1000")
    replaceFile(fixture, "packages/sdk/src/agent.ts", "large?: 1_000n", "large?: 1000n")
  }),
  mutated("semantic-numeric-hex", (fixture) => {
    replaceFile(fixture, "packages/sdk/src/agent.ts", "code?: 1_000", "code?: 0x3e8")
    replaceFile(fixture, "packages/sdk/src/agent.ts", "large?: 1_000n", "large?: 0x3e8n")
  }),
  mutated("semantic-template-escape", (fixture) => {
    replaceFile(
      fixture,
      "packages/sdk/src/agent.ts",
      "template?: `a  $" + "{string};b`",
      "template?: `\\x61  $" + "{string};b`",
    )
  }),
  mutated("semantic-assertion-numeric", (fixture) => {
    replaceFile(fixture, "packages/sdk/test/behavior.test.ts", "toBe(3)", "toBe(0x3)")
  }),
  mutated("source-ast-comments", (fixture) => {
    replaceFile(
      fixture,
      "packages/sdk/src/behavior.ts",
      "export interface BehaviorOptions",
      "// public behavior options\nexport interface BehaviorOptions",
    )
    replaceFile(
      fixture,
      "packages/sdk/src/behavior.ts",
      'if (active) return "on"',
      'if (active) /* active branch */ return "on"',
    )
  }),
  mutated("heading-autolink-mutation", (fixture) => {
    replaceDoc(fixture, "https://dawn.example/api", "https://dawn.example/reference")
  }),
  mutated("contract-literal-quote-style", (fixture) => {
    replaceDoc(fixture, 'readonly status: "ready"', "readonly status: 'ready'")
  }),
  mutated("unsupported-enum-contract", (fixture) => {
    replaceDoc(
      fixture,
      "| `defaultExport` | Call the default helper. |",
      "| `defaultExport` | Call the default helper. |\n| `ContractEnum` | Describe contract states. |",
    )
    appendToPrimaryDoc(
      fixture,
      '```ts api-contract="@dawn-ai/sdk#.:ContractEnum"\nexport declare enum ContractEnum { Ready = "ready" }\n```',
    )
    fixture.files["packages/sdk/src/extra.ts"] += '\nexport enum ContractEnum { Ready = "ready" }\n'
  }),
  mutated("unsupported-namespace-contract", (fixture) => {
    replaceDoc(
      fixture,
      "| `defaultExport` | Call the default helper. |",
      "| `defaultExport` | Call the default helper. |\n| `ContractNamespace` | Group contract helpers. |",
    )
    appendToPrimaryDoc(
      fixture,
      '```ts api-contract="@dawn-ai/sdk#.:ContractNamespace"\nexport declare namespace ContractNamespace { export function run(input: string): number }\n```',
    )
    fixture.files["packages/sdk/src/extra.ts"] +=
      "\nexport namespace ContractNamespace { export function run(input: string) { return input.length } }\n"
  }),
  mutated("workspace-package-reexports", (fixture) => {
    fixture.packages.push({
      dir: "packages/core",
      packageJson: {
        name: "@dawn-ai/core",
        exports: {
          ".": { types: "./dist/index.d.ts" },
          "./wild": { types: "./dist/wild.d.ts" },
          "./alias": { types: "./dist/alias.d.ts" },
        },
      },
    })
    fixture.files["packages/sdk/src/index.ts"] = `
export { agent, type AgentConfig, type PublicShape } from "@dawn-ai/core"
export * from "@dawn-ai/core/wild"
export { coreOriginal as aliasExport } from "@dawn-ai/core/alias"
export { default as defaultExport } from "./default.js"
`
    fixture.files["packages/core/src/index.ts"] = fixture.files["packages/sdk/src/agent.ts"] ?? ""
    fixture.files["packages/core/src/wild.ts"] = fixture.files["packages/sdk/src/extra.ts"] ?? ""
    fixture.files["packages/core/src/alias.ts"] =
      "export function coreOriginal(value: string): number { return value.length }\n"
  }),
]

const unresolvedWorkspaceFixture = structuredClone(
  acceptanceFixtures.find(({ name }) => name === "workspace-package-reexports") ?? baseline(),
)
;(unresolvedWorkspaceFixture as { name: string }).name = "unresolved-workspace-reexport"
unresolvedWorkspaceFixture.packages.splice(1, 1)

const generatedFixtures: InventoryFixture[] = [
  generatedFixture("generated-owner-missing", noStateGeneratedDeclarations, null),
  generatedFixture("generated-no-state", noStateGeneratedDeclarations, noStateGeneratedExports),
  generatedFixture("generated-with-state", stateGeneratedDeclarations, stateGeneratedExports),
  generatedFixture(
    "generated-no-state-after-state",
    noStateGeneratedDeclarations,
    noStateGeneratedExports,
  ),
  generatedFixture(
    "generated-export-added",
    noStateGeneratedDeclarations.replace("\n}", "\n  export type UnexpectedRouteType = never;\n}"),
    noStateGeneratedExports,
  ),
  generatedFixture(
    "generated-export-removed",
    noStateGeneratedDeclarations.replace(
      / {2}export type RouteTools<P extends DawnRoutePath> = DawnRouteTools\[P\];\n/,
      "",
    ),
    noStateGeneratedExports,
  ),
]
function generatedMutation(
  name: string,
  mutate: (fixture: InventoryFixture) => void,
): InventoryFixture {
  const fixture = generatedFixture(name, noStateGeneratedDeclarations, noStateGeneratedExports)
  mutate(fixture)
  return fixture
}

const generatedReviewFixtures = [
  generatedMutation("generated-registry-removed", (fixture) => fixture.artifacts.splice(0)),
  generatedMutation("generated-registry-duplicated", (fixture) => {
    fixture.artifacts.push(structuredClone(GENERATED_ROUTES_ARTIFACT))
  }),
  generatedMutation("generated-owner-wrong", (fixture) => {
    ;(fixture.artifacts[0] as Record<string, unknown>).ownerHref = "/docs/api/wrong"
  }),
  generatedMutation("generated-audience-wrong", (fixture) => {
    ;(fixture.artifacts[0] as Record<string, unknown>).audience = "tooling"
  }),
  generatedMutation("generated-stability-wrong", (fixture) => {
    ;(fixture.artifacts[0] as Record<string, unknown>).stability = "low-level"
  }),
  generatedMutation("generated-runtime-forbidden", (fixture) => {
    ;(fixture.artifacts[0] as Record<string, unknown>).runtime = "edge-safe"
  }),
  generatedMutation("generated-purity-forbidden", (fixture) => {
    ;(fixture.artifacts[0] as Record<string, unknown>).purity = "dependency-free"
  }),
  generatedMutation("generated-authority-missing", (fixture) => {
    ;(fixture as { generatedAuthorities: GeneratedAuthorityFixture[] }).generatedAuthorities = []
  }),
  generatedMutation("generated-module-missing", (fixture) => {
    const authority = fixture.generatedAuthorities?.[0]
    if (authority) authority.declarations = authority.declarations.replace("dawn:routes", "other")
  }),
  generatedMutation("generated-module-duplicated", (fixture) => {
    const authority = fixture.generatedAuthorities?.[0]
    if (authority) authority.declarations += '\ndeclare module "dawn:routes" {}\n'
  }),
  generatedMutation("generated-value-export", (fixture) => {
    const authority = fixture.generatedAuthorities?.[0]
    if (authority) {
      authority.declarations = authority.declarations.replace(
        "export interface DawnRouteTools",
        "export class DawnRouteTools",
      )
    }
  }),
  generatedMutation("generated-alias-export", (fixture) => {
    const authority = fixture.generatedAuthorities?.[0]
    if (authority) {
      authority.declarations = authority.declarations.replace(
        "\n}",
        "\n  type Hidden = string;\n  export { type Hidden as UnexpectedRouteType };\n}",
      )
    }
  }),
  generatedMutation("generated-parse-error", (fixture) => {
    const authority = fixture.generatedAuthorities?.[0]
    if (authority) authority.declarations = authority.declarations.slice(0, -2)
  }),
  generatedMutation("generated-semantic-error", (fixture) => {
    const authority = fixture.generatedAuthorities?.[0]
    if (authority) {
      authority.declarations = authority.declarations.replace(
        "DawnRouteTools[P]",
        "MissingRouteTools[P]",
      )
    }
  }),
]

const fixtures: InventoryFixture[] = [
  ...mutationFixtures,
  ...acceptanceFixtures,
  unresolvedWorkspaceFixture,
  ...generatedFixtures,
  ...generatedReviewFixtures,
]

const fixtureInput = JSON.stringify(fixtures)
const subprocesses = [
  spawnSync(process.execPath, [CHECK_DOCS_PATH, "--analyze-api-inventory"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input: fixtureInput,
    maxBuffer: 16 * 1024 * 1024,
  }),
]

interface Analysis {
  readonly name: string
  readonly failures: readonly string[]
  readonly headings: readonly {
    readonly level: number
    readonly text: string
  }[]
}

const analyses = subprocesses.flatMap((subprocess) =>
  subprocess.status === 0 && subprocess.stdout.startsWith("[")
    ? (JSON.parse(subprocess.stdout) as readonly Analysis[])
    : [],
)
const byName = new Map(analyses.map((analysis) => [analysis.name, analysis]))

describe("API reference wrapper contracts", () => {
  it("structurally pairs every API wrapper with its canonical content, route, and title", () => {
    const wrapperSources = allReferencePages.map((page) => foundationalWrapper(page.slug))
    const wrapperAnalyses = analyzeWrapperContracts(wrapperSources)

    expect(wrapperAnalyses).toHaveLength(allReferencePages.length)
    for (const [index, page] of allReferencePages.entries()) {
      const analysis = wrapperAnalyses[index]
      const wrapperPath = join(REPO_ROOT, "apps/web/app/docs/api", page.slug, "page.tsx")
      expect(analysis?.metadataTitle, `${page.href} metadata title`).toBe(page.label)
      expect(analysis?.docsPageHref, `${page.href} DocsPage href`).toBe(page.href)
      expect(
        resolve(dirname(wrapperPath), analysis?.contentImportTarget ?? ""),
        `${page.href} content import`,
      ).toBe(join(REPO_ROOT, "apps/web/content/docs/api", `${page.slug}.mdx`))
      expect(
        `${resolve(dirname(wrapperPath), analysis?.docsPageImportTarget ?? "")}.tsx`,
        `${page.href} DocsPage import`,
      ).toBe(join(REPO_ROOT, "apps/web/app/components/docs/DocsPage.tsx"))
    }
  })

  it("rejects wrong structural values even when comments and strings contain canonical decoys", () => {
    const source = foundationalWrapper("sdk")
    const [wrongImport, wrongHref, wrongMetadata] = analyzeWrapperContracts([
      `// import Content from "../../../../content/docs/api/sdk.mdx"\nconst decoy = '../../../../content/docs/api/sdk.mdx'\n${source.replace("../../../../content/docs/api/sdk.mdx", "../../../../content/docs/api/cli.mdx")}\nvoid decoy`,
      `// <DocsPage href="/docs/api/sdk" Content={Content} />\nconst decoy = '/docs/api/sdk'\n${source.replace('href="/docs/api/sdk"', 'href="/docs/api/cli"')}\nvoid decoy`,
      `// export const metadata = { title: "@dawn-ai/sdk" }\nconst decoy = '@dawn-ai/sdk'\n${source.replace('title: "@dawn-ai/sdk"', 'title: "Wrong"')}\nvoid decoy`,
    ])

    expect(wrongImport?.contentImportTarget).toBe("../../../../content/docs/api/cli.mdx")
    expect(wrongHref?.docsPageHref).toBe("/docs/api/cli")
    expect(wrongMetadata?.metadataTitle).toBe("Wrong")
  })

  it("rejects JSX bindings that shadow the canonical imports", () => {
    const source = foundationalWrapper("sdk")
    const [shadowedContent, shadowedDocsPage] = analyzeWrapperContracts([
      source.replace("function Page()", "function Page(Content: unknown)"),
      source.replace("function Page() {", "function Page() {\n  const DocsPage = () => null"),
    ])

    expect(shadowedContent?.contentImportTarget).not.toBe("../../../../content/docs/api/sdk.mdx")
    expect(shadowedDocsPage?.docsPageImportTarget).not.toBe("../../../components/docs/DocsPage")
  })
})

describe("foundational API reference pages", () => {
  it.each(foundationalPages)("uses the exact H1 for $href", (page) => {
    const content = foundationalContent(page.slug)

    expect(content.match(/^# (.+)$/m)?.[1]).toBe(page.label)
  })

  it.each(foundationalPages)("uses the six-section reference template for $href", (page) => {
    const headings = [...foundationalContent(page.slug).matchAll(/^## (.+)$/gm)].map(
      (match) => match[1],
    )
    expect(headings).toEqual(foundationalSections)
  })

  it("keeps SDK root, pure, and testing surfaces distinct", () => {
    const content = foundationalContent("sdk")
    expect(content).toContain("### `@dawn-ai/sdk`")
    expect(content).toContain("### `@dawn-ai/sdk/pure`")
    expect(content).toContain("### `@dawn-ai/sdk/testing`")
    expect(content).toContain("not the `@dawn-ai/testing` package")
  })

  it("keeps CLI imports and executable distinct", () => {
    const content = foundationalContent("cli")
    for (const surface of [
      "@dawn-ai/cli",
      "@dawn-ai/cli/fetch",
      "@dawn-ai/cli/runtime",
      "@dawn-ai/cli/testing",
      "bin:dawn",
    ]) {
      expect(content).toContain(`### \`${surface}\``)
    }
  })

  it("publishes the exact ServeRuntimeOptions contract and all current fields", () => {
    const content = foundationalContent("cli")
    expect(content).toContain('```ts api-contract="@dawn-ai/cli#.:ServeRuntimeOptions"')
    expect(content).toContain("**Fields: `@dawn-ai/cli#.:ServeRuntimeOptions`**")
    for (const field of [
      "appRoot",
      "host",
      "port",
      "installSignalHandlers",
      "modules",
      "config",
      "checkpointer",
      "threadsStore",
      "permissionsStore",
      "memoryStore",
      "middleware",
    ]) {
      expect(content).toContain(`| \`readonly ${field}`)
    }
    expect(content).not.toContain("| `readonly sandboxManager`")
  })

  it("defers canonical-owner deep links until stable anchors land", () => {
    expect(foundationalContent("cli")).not.toContain("/docs/api#dawn-ai-langchain")
    expect(foundationalContent("core")).not.toContain("/docs/api#dawn-ai-sqlite-storage")
  })

  it("marks the Core compiler subpath as internal", () => {
    const content = foundationalContent("core")
    expect(content).toContain("### `@dawn-ai/core/internal/compiler`")
    expect(content).toMatch(/@dawn-ai\/core\/internal\/compiler[\s\S]{0,500}\binternal\b/i)
  })

  it.each(foundationalCompatibilityRows)(
    "renders the registry-derived compatibility row for $cells.0",
    ({ cells, slug }) => {
      expect(foundationalContent(slug)).toContain(compatibilityRow(cells))
    },
  )

  it.each(foundationalCompatibilityRows)(
    "rejects compatibility-label drift for $cells.0",
    ({ cells, slug }) => {
      for (let index = 1; index < cells.length; index += 1) {
        const mutated = [...cells]
        mutated[index] = `wrong-${index}`
        expect(foundationalContent(slug)).not.toContain(compatibilityRow(mutated))
      }
    },
  )

  it("registers source-coupled defaults, errors, and lifecycle behavior", () => {
    expect(API_BEHAVIOR_CONTRACTS.map(({ id }) => id)).toEqual([
      "sdk.agent.descriptor-shape",
      "sdk.middleware.result-shapes",
      "sdk.validate-model-id.advisory",
      "cli.serve.production-boot",
      "cli.serve-runtime.port-precedence",
      "cli.fetch.request-store-lifecycle",
      "core.load-config.failed-load-eviction",
      "core.state.reducer-resolution",
      "generated-routes.state-conditional",
      "generated-routes.tool-signatures",
      "ag-ui.outbound.errors-as-events",
      "ag-ui.inbound.lossless-input",
      "memory.namespace.stable-encoding",
      "memory.browse.pure-subpath",
      "memory.write-policy",
      "memory-pgvector.schema.identifier-validation",
      "memory-pgvector.dimension-branches",
      "memory-pgvector.update-preserves-embedding",
      "postgres-storage.migration.instance-scoped",
      "postgres-storage.entry-split",
      "testing.fake-embedder.deterministic",
      "testing.harness-isolation",
      "evals.scorer-errors.zero-score",
      "evals.run-and-gate",
    ])
  })
})

describe("package API reference pages", () => {
  it.each(packagePages)("uses the exact H1 for $href", (page) => {
    const content = foundationalContent(page.slug)

    expect(content.match(/^# (.+)$/m)?.[1]).toBe(page.label)
  })

  it.each(packagePages)("uses the six-section reference template for $href", (page) => {
    const headings = [...foundationalContent(page.slug).matchAll(/^## (.+)$/gm)].map(
      (match) => match[1],
    )
    expect(headings).toEqual(foundationalSections)
  })

  it("owns every explicit detailed subpath separately", () => {
    expect(foundationalContent("ag-ui")).toContain("### `@dawn-ai/ag-ui/sse`")
    for (const subpath of ["browse", "namespace", "reconcile"]) {
      expect(foundationalContent("memory")).toContain(`### \`@dawn-ai/memory/${subpath}\``)
    }
    expect(foundationalContent("postgres-storage")).toContain(
      "### `@dawn-ai/postgres-storage/node`",
    )
  })

  it("documents Testing's fake embedder and all four conformance runners", () => {
    const content = foundationalContent("testing")
    for (const exportName of [
      "fakeEmbedder",
      "runCheckpointerConformance",
      "runMemoryStoreConformance",
      "runPermissionsStoreConformance",
      "runThreadsStoreConformance",
    ]) {
      expect(content).toContain(`| \`${exportName}\` |`)
    }
  })

  it("documents Postgres node wildcard ownership and instance-scoped migration", () => {
    const content = foundationalContent("postgres-storage")
    expect(content).toContain("The `/node` entry also re-exports every root export")
    expect(content).toContain("Migration state is instance-scoped")
  })

  it("keeps application-critical lifecycle and trust-boundary guidance explicit", () => {
    expect(foundationalContent("testing")).toContain(
      "temporarily changes process-wide `OPENAI_BASE_URL` and `OPENAI_API_KEY`",
    )
    expect(foundationalContent("testing")).toContain("restores them on awaited close")
    expect(foundationalContent("postgres-storage")).toContain(
      "same database, schema, prefix, component, and current package schema",
    )
    expect(foundationalContent("postgres-storage")).toContain(
      "sees a durable permission grant only after that store calls `load()`",
    )
    expect(foundationalContent("memory-pgvector")).toContain("needed DDL and extension privileges")
    expect(foundationalContent("memory-pgvector")).toContain(
      "does not migrate an existing vector dimension or HNSW tuning",
    )
    expect(foundationalContent("memory")).toContain(
      "Browse cursors detect query mismatches but are not authenticated tokens",
    )
    expect(foundationalContent("memory")).toContain(
      "validateBrowseQuery(query, { maxLimit: BROWSE_MAX_LIMIT })",
    )
    expect(foundationalContent("memory")).toContain(
      "SQLite stores memory rows—including content, data, source, and tags—as plaintext",
    )
    expect(foundationalContent("memory")).toContain(
      "Low-level `MemoryStore` implementations can store typed procedural records",
    )
    expect(foundationalContent("memory")).toContain(
      "the generated `remember` tool returns a not-yet-wired rejection",
    )
    expect(foundationalContent("memory-pgvector")).toContain(
      "Content or data updates do not recompute that embedding",
    )
    expect(foundationalContent("memory-pgvector")).toContain(
      "Both `queryEmbedding` and `embedderId` are required",
    )
    expect(foundationalContent("testing")).toContain(
      "Empty or tokenless inputs produce a zero vector",
    )
    expect(foundationalContent("testing")).toContain(
      "With positive dimensions, inputs containing supported tokens are unit-length",
    )
    expect(foundationalContent("testing")).toContain(
      "`fakeEmbedder({ dims: 0 })` produces an empty vector",
    )
    expect(foundationalContent("evals")).toContain(
      "informational with `gated: false` and `passed: true`",
    )
    expect(foundationalContent("evals")).toContain(
      "counts collected stream chunks or deltas, not model-tokenizer tokens",
    )
    expect(foundationalContent("evals")).toContain(
      "`gate.perScorer()` ignores scorers without an explicit threshold",
    )
  })

  it("keeps the pgvector example exact-optional safe", () => {
    const content = foundationalContent("memory-pgvector")
    expect(content).toContain("if (!connectionString)")
    expect(content).not.toContain("connectionString: process.env.DATABASE_URL")
  })

  it("type-checks the pgvector example with exact optional properties", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "dawn-pgvector-doc-example-"))
    const fileName = join(fixtureRoot, "pgvector-example.ts")
    const source = `
export {}
declare const process: { readonly env: Record<string, string | undefined> }
declare function pgvectorMemoryStore(options: {
  readonly connectionString?: string
  readonly dimensions: number
  readonly tablePrefix?: string
}): {
  search(query: { readonly namespace: string; readonly query?: string }): Promise<unknown>
  close(): Promise<void>
}
${packageExample("memory-pgvector").replace(
  'import { pgvectorMemoryStore } from "@dawn-ai/memory-pgvector"',
  "",
)}
`
    const configPath = join(fixtureRoot, "tsconfig.json")
    try {
      writeFileSync(fileName, source)
      writeFileSync(
        configPath,
        JSON.stringify({
          compilerOptions: {
            exactOptionalPropertyTypes: true,
            module: "ESNext",
            noEmit: true,
            strict: true,
            target: "ES2022",
            types: [],
          },
          files: [fileName],
        }),
      )
      const result = spawnSync(
        join(REPO_ROOT, "node_modules/typescript/bin/tsc"),
        ["-p", configPath],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
        },
      )
      expect(result.status, result.stderr || result.stdout).toBe(0)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it("passes the source-derived inventory and behavior contracts for all ten owners", () => {
    const result = spawnSync(
      process.execPath,
      [CHECK_DOCS_PATH, "--analyze-detailed-api-references"],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    )
    expect(result.status, result.stderr || result.stdout).toBe(0)
    const analysis = JSON.parse(result.stdout) as {
      readonly failures: readonly string[]
      readonly ownerHrefs: readonly string[]
      readonly artifactAddresses: readonly string[]
      readonly behaviorIds: readonly string[]
      readonly contractKeys: readonly string[]
    }
    expect(analysis.failures).toEqual([])
    expect(analysis.ownerHrefs).toEqual(API_REFERENCE_PAGES.map(({ href }) => href))
    expect(analysis.artifactAddresses).toEqual(
      ARTIFACT_REGISTRY.filter(
        (artifact) =>
          artifact.kind === "generated" ||
          (artifact.kind === "import" && artifact.coverage === "detailed"),
      ).map(artifactAddressFor),
    )
    expect(analysis.behaviorIds).toEqual(API_BEHAVIOR_CONTRACTS.map(({ id }) => id))
    expect(analysis.contractKeys).toEqual(API_REQUIRED_CONTRACT_KEYS)
  }, 30_000)

  it("registers the package defaults, errors, and lifecycle behavior", () => {
    expect(API_BEHAVIOR_CONTRACTS.map(({ id }) => id)).toEqual([
      "sdk.agent.descriptor-shape",
      "sdk.middleware.result-shapes",
      "sdk.validate-model-id.advisory",
      "cli.serve.production-boot",
      "cli.serve-runtime.port-precedence",
      "cli.fetch.request-store-lifecycle",
      "core.load-config.failed-load-eviction",
      "core.state.reducer-resolution",
      "generated-routes.state-conditional",
      "generated-routes.tool-signatures",
      "ag-ui.outbound.errors-as-events",
      "ag-ui.inbound.lossless-input",
      "memory.namespace.stable-encoding",
      "memory.browse.pure-subpath",
      "memory.write-policy",
      "memory-pgvector.schema.identifier-validation",
      "memory-pgvector.dimension-branches",
      "memory-pgvector.update-preserves-embedding",
      "postgres-storage.migration.instance-scoped",
      "postgres-storage.entry-split",
      "testing.fake-embedder.deterministic",
      "testing.harness-isolation",
      "evals.scorer-errors.zero-score",
      "evals.run-and-gate",
    ])
  })
})

describe("source-derived API inventory", () => {
  it("runs every isolated fixture through one compact stdin-fed process", () => {
    expect(fixtures).toHaveLength(161)
    expect(Buffer.byteLength(JSON.stringify(baseline()))).toBeLessThan(16 * 1024)
    expect(Buffer.byteLength(fixtureInput)).toBeLessThan(2 * 1024 * 1024)
    expect(subprocesses).toHaveLength(1)
    for (const subprocess of subprocesses) {
      expect(subprocess.status, subprocess.stderr || subprocess.stdout).toBe(0)
      expect(subprocess.stderr).toBe("")
    }
    expect(analyses).toHaveLength(fixtures.length)
    expect(new Set(analyses.map(({ name }) => name)).size).toBe(fixtures.length)
  })

  it("accepts checker-derived named, wildcard, alias, and default re-exports", () => {
    expect(byName.get("baseline")?.failures).toEqual([])
  })

  it.each(["generated-no-state", "generated-with-state", "generated-no-state-after-state"])(
    "accepts the exact %s ambient-module surface",
    (name) => {
      expect(byName.get(name)?.failures).toEqual([])
    },
  )

  it("keeps generated surfaces manifest-less and lightweight in the shared batch", () => {
    for (const fixture of generatedFixtures) {
      expect(fixture.packages).toEqual([])
      expect(fixture.files).toEqual({})
    }
  })

  it.each([
    ["generated-owner-missing", /dawn:routes.*missing.*Generated export table/i],
    ["generated-export-added", /dawn:routes.*exports.*UnexpectedRouteType.*exact/i],
    ["generated-export-removed", /dawn:routes.*exports.*instead of exact/i],
    ["generated-registry-removed", /dawn:routes.*registry.*missing/i],
    ["generated-registry-duplicated", /dawn:routes.*exactly one.*registry/i],
    ["generated-owner-wrong", /dawn:routes.*owner.*generated-routes/i],
    ["generated-audience-wrong", /dawn:routes.*audience.*application/i],
    ["generated-stability-wrong", /dawn:routes.*stability.*supported/i],
    ["generated-runtime-forbidden", /dawn:routes.*fields.*runtime/i],
    ["generated-purity-forbidden", /dawn:routes.*fields.*purity/i],
    ["generated-authority-missing", /dawn:routes.*authority.*missing/i],
    ["generated-module-missing", /dawn:routes.*ambient module.*missing/i],
    ["generated-module-duplicated", /dawn:routes.*ambient module.*exactly one/i],
    ["generated-value-export", /dawn:routes.*value export.*DawnRouteTools/i],
    ["generated-alias-export", /dawn:routes.*UnexpectedRouteType.*exact/i],
    ["generated-parse-error", /dawn:routes.*syntactic diagnostic/i],
    ["generated-semantic-error", /dawn:routes.*semantic diagnostic/i],
  ])("rejects %s", (name, diagnostic) => {
    expect(byName.get(name)?.failures).toEqual(
      expect.arrayContaining([expect.stringMatching(diagnostic)]),
    )
  })

  it("ignores tagged contract fences nested inside a longer outer fence", () => {
    expect(byName.get("nested-contract-fence-decoy")?.failures).toEqual([])
  })

  it("rejects visible ownership after an invalid backtick-fence opener", () => {
    expect(byName.get("invalid-backtick-info-visible")?.failures).toEqual(
      expect.arrayContaining([expect.stringMatching(/@x\/foreign#\.:Ghost.*known detailed/i)]),
    )
  })

  it.each([
    "unescaped-code-span-pipe",
    "class-private-details-ignored",
    "executable-typescript-example",
    "api-contract-substring-metadata",
    "api-contract-bare-metadata-values",
    "ordinary-untagged-table",
    "combined-interface-contract",
    "combined-interface-specialized-precedence",
    "contract-interface-overload-specificity-order",
    "interface-layout-reordered",
    "semantic-numeric-decimal",
    "semantic-numeric-hex",
    "semantic-template-escape",
    "semantic-assertion-numeric",
    "source-ast-comments",
    "contract-literal-quote-style",
    "workspace-package-reexports",
    "leading-underscore-public-exports",
    "tilde-info-backtick-decoy",
  ])("accepts %s", (name) => {
    expect(byName.get(name)?.failures).toEqual([])
  })

  it("matches rendered headings without treating inline code as MDX tags", () => {
    expect(byName.get("baseline")?.headings[0]).toEqual({
      level: 1,
      text: "Alpha Beta <Tools> https://dawn.example/api mailto:docs@dawn.example team@dawn.example",
    })
  })

  it("preserves a mutated CommonMark URL autolink in a rendered heading", () => {
    expect(byName.get("heading-autolink-mutation")?.headings[0]?.text).toContain(
      "https://dawn.example/reference",
    )
  })

  it.each([
    ["duplicate-owner", /@dawn-ai\/sdk.*\.?.*agent.*owner.*docs\/sdk/i],
    ["missing-source-symbol", /@dawn-ai\/sdk.*\.?.*ghost.*docs\/sdk.*source.*index/i],
    [
      "undocumented-export",
      /@dawn-ai\/sdk.*\.?.*undocumented.*owner.*docs\/api\/sdk.*source.*index/i,
    ],
    ["stale-documented-export", /@dawn-ai\/sdk.*\.?.*stale.*docs\/sdk.*source.*index/i],
    ["contract-table-key-mismatch", /@dawn-ai\/sdk.*\.?.*ghost.*contract.*owner/i],
    ["removed-subpath", /@dawn-ai\/sdk.*\.?.*source.*barrel|manifest.*subpath/i],
    ["wrong-target", /@dawn-ai\/sdk.*\.?.*wrong.*source.*target/i],
    ["duplicate-contract", /agent.*duplicate|exactly one API contract/i],
    ["orphan-contract", /agent.*no ownership|owner key mismatch/i],
    ["contract-tag-spacing", /malformed.*api-contract/i],
    ["contract-tag-malformed-key", /malformed.*api-contract/i],
    ["contract-tag-colon", /malformed.*api-contract/i],
    ["contract-tag-braces", /malformed.*api-contract/i],
    ["contract-tag-comma", /malformed.*api-contract/i],
    ["contract-tag-standalone", /malformed.*api-contract/i],
    ["contract-tag-removed", /mode.*required.*api-contract/i],
    ["required-contract-key-removed", /unregistered.*api-contract.*agent/i],
    ["required-contract-key-duplicated", /duplicate.*required.*api-contract.*agent/i],
    ["required-contract-key-stale", /required.*api-contract.*Ghost.*source|unknown/i],
    ["required-contract-key-substituted-with-fence", /duplicate.*required.*wildcardExport/i],
    ["unresolved-workspace-reexport", /agent.*source|undocumented.*agent/i],
  ])("rejects %s", (name, diagnostic) => {
    expect(byName.get(name)?.failures).toEqual(
      expect.arrayContaining([expect.stringMatching(diagnostic)]),
    )
  })

  it.each([
    "contract-generic-constraint",
    "contract-generic-default",
    "contract-parameter-name",
    "contract-parameter-type",
    "contract-parameter-optionality",
    "contract-parameter-rest",
    "contract-return-type",
    "contract-overload",
    "contract-interface-field-name",
    "contract-interface-field-type",
    "contract-interface-field-readonly",
    "contract-interface-field-optionality",
    "contract-interface-field-union",
    "contract-interface-field-intersection",
    "contract-inferred-literal",
    "contract-class-public",
    "contract-class-constructor-added",
    "contract-class-constructor-removed",
    "contract-class-constructor-type",
    "contract-class-constructor-optional",
    "contract-class-extends",
    "contract-class-implements",
    "contract-interface-merge-second",
    "contract-interface-merge-removed",
    "contract-interface-merge-conflict",
    "contract-interface-merge-metadata",
    "contract-interface-overload-return-order",
    "contract-interface-combined-wrong-return-order",
    "contract-interface-method-optional",
    "contract-class-method-optional",
    "contract-class-method-abstract",
    "contract-type-literal-semicolon",
    "contract-type-literal-spacing",
    "contract-type-template-spacing",
    "contract-type-numeric-drift",
    "contract-type-bigint-drift",
    "contract-class-method-overload",
    "contract-class-implementation-only",
    "contract-inferred-return",
    "contract-parse-error",
  ])("rejects the %s fingerprint mutation without a symbol rename", (name) => {
    expect(byName.get(name)?.failures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /@dawn-ai\/sdk.*(?:agent|PublicShape|MergedOptions|mode|Worker|makeResult).*contract.*source/i,
        ),
      ]),
    )
  })

  it("rejects a mixed class/namespace merge as unsupported", () => {
    expect(byName.get("contract-unsupported-merge")?.failures).toEqual(
      expect.arrayContaining([expect.stringMatching(/contract.*namespace.*unsupported/i)]),
    )
  })

  it.each([
    "field-name",
    "field-type",
    "field-required",
    "field-readonly-authored",
    "field-readonly-source",
    "field-union",
  ])("rejects the %s field-table mutation", (name) => {
    expect(byName.get(name)?.failures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/@dawn-ai\/sdk.*AgentConfig.*field.*docs\/sdk/i),
      ]),
    )
  })

  it.each([
    ["foreign-contract-key", /foreign.*contract.*known detailed/i],
    ["malformed-contract-key", /malformed.*api-contract/i],
    ["foreign-field-key", /foreign.*Fields.*known detailed/i],
    ["malformed-field-key", /malformed.*Fields/i],
    ["split-contract-owner-page", /agent.*contract.*same.*owner page/i],
    ["split-field-owner-page", /AgentConfig.*Fields.*same.*owner page/i],
    ["duplicate-field-table", /AgentConfig.*duplicate.*Fields|duplicate.*field table/i],
    ["orphan-field-table", /AgentConfig.*Fields.*no ownership/i],
    ["field-caption-removed", /field table.*caption/i],
    ["field-caption-malformed", /field table.*caption/i],
    ["field-header-optional", /field table.*(?:header|structure)/i],
    ["field-separator-malformed", /field table.*(?:separator|structure)/i],
    ["field-table-empty", /field table.*(?:row|structure)/i],
    ["field-table-malformed-row", /field table.*(?:row|structure)/i],
    ["field-table-malformed-columns", /field table.*(?:row|structure)/i],
    ["foreign-ownership-key", /@x\/foreign#\.:Ghost.*known detailed/i],
    ["malformed-ownership-key", /malformed.*ownership/i],
    ["leading-underscore-owner-mutation", /___testHook.*stale|__testHook.*undocumented/i],
    ["ownership-wrong-owner-page", /ownership.*canonical owner page/i],
  ])("rejects %s globally", (name, diagnostic) => {
    expect(byName.get(name)?.failures).toEqual(
      expect.arrayContaining([expect.stringMatching(diagnostic)]),
    )
  })

  it.each([
    ["behavior-claim", /sdk-retries.*claim/i],
    ["behavior-autolink-claim", /sdk-retries.*claim/i],
    ["behavior-component-claim", /sdk-retries.*claim/i],
    ["behavior-source-expectation", /sdk-retries.*source-ast.*BehaviorOptions\.retries/i],
    ["behavior-test-expectation", /sdk-retries.*test-assertion.*uses three retries/i],
    ["behavior-test-poll-spacing", /sdk-retries.*test-assertion.*polls status/i],
    ["behavior-test-poll-semicolon", /sdk-retries.*test-assertion.*polls status/i],
    ["behavior-test-regex-spacing", /sdk-retries.*test-assertion.*polls status/i],
    ["behavior-marker-only", /sdk-retries.*test-assertion.*expect/i],
    ["behavior-authority-removed", /sdk-retries.*authorit.*identity/i],
    ["behavior-marker-removed", /sdk-retries.*authorit.*marker/i],
    ["behavior-marker-changed", /sdk-retries.*authorit.*identity/i],
    ["behavior-html-marker", /sdk-retries.*authorit.*marker/i],
    ["behavior-marker-not-immediate", /sdk-retries.*authorit.*marker/i],
    ["behavior-contract-extra-field", /sdk-retries.*registry.*field/i],
    ["behavior-source-declaration", /sdk-options-shape.*source-ast.*BehaviorOptions/i],
    ["behavior-source-branch", /sdk-choice-branch.*source-ast.*choose\.branch\[0\]/i],
    ["behavior-selector-variable", /sdk-selector-shapes.*source-ast.*retryDefault/i],
    ["behavior-selector-variable-kind", /sdk-selector-shapes.*source-ast.*retryDefault/i],
    ["behavior-selector-enum", /sdk-selector-shapes.*source-ast.*Mode\.Fast/i],
    ["behavior-selector-namespace", /sdk-selector-shapes.*source-ast.*Limits\.max/i],
    ["behavior-selector-namespace-kind", /sdk-selector-shapes.*source-ast.*Limits\.max/i],
    ["behavior-selector-object", /sdk-selector-shapes.*source-ast.*behaviorMap\.retry/i],
    ["behavior-selector-arrow-branch", /sdk-selector-shapes.*source-ast.*decide\.branch/i],
    ["behavior-selector-ambiguous", /sdk-selector-shapes.*source-ast.*retryDefault/i],
    ["behavior-duplicate-test-name", /sdk-retries.*test-assertion.*uses three retries/i],
    ["behavior-await", /sdk-retries.*test-assertion.*uses three retries/i],
    ["duplicate-behavior-id", /duplicate.*sdk-retries/i],
    ["duplicate-behavior-invalid-first", /duplicate.*sdk-retries.*marker/i],
  ])("rejects %s", (name, diagnostic) => {
    expect(byName.get(name)?.failures).toEqual(
      expect.arrayContaining([expect.stringMatching(diagnostic)]),
    )
  })

  it.each(["unsupported-enum-contract", "unsupported-namespace-contract"])(
    "rejects %s with an explicit unsupported diagnostic",
    (name) => {
      expect(byName.get(name)?.failures).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/contract.*(?:enum|namespace).*unsupported/i),
        ]),
      )
    },
  )
})
