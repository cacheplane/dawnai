import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { fileURLToPath } from "node:url"
import { MIMEType, stripVTControlCharacters } from "node:util"

import { RECOMMENDED_VERCEL_CONFIG } from "../../src/lib/build/targets/vercel-config.js"
import { validateVercelOutput } from "../../src/lib/build/targets/vercel-output.js"

export const REQUIRED_VERCEL_ENV = [
  "DAWN_VERCEL_TOKEN",
  "DAWN_VERCEL_ORG_ID",
  "DAWN_VERCEL_PROJECT_ID",
  "DAWN_VERCEL_DATABASE_URL",
] as const

export const NATIVE_DIRECT_DAWN_DEPENDENCIES = [
  "@dawn-ai/cli",
  "@dawn-ai/postgres-storage",
  "@dawn-ai/sdk",
] as const

export interface NativePackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly name: string
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
  readonly version: string
}

export interface NativeWorkspacePackage {
  readonly dir: string
  readonly manifest: NativePackageManifest
  readonly name: string
}

export interface NativePackedArtifact {
  readonly packageJson: NativePackageManifest
  readonly packageName: string
  readonly packageVersion: string
  readonly tarballName: string
  readonly tarballPath: string
}

export interface NativeLocalCommandRequest {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly executable: string
  readonly timeoutMs: number
}

export interface NativeLocalCommandResult {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

export type NativeLocalCommandRunner = (
  request: NativeLocalCommandRequest,
) => Promise<NativeLocalCommandResult>

export interface AssembledNativeFixture {
  readonly kind: "source" | "prebuilt"
  readonly lockfilePath: string
  readonly root: string
}

export interface NativeFixtureAssembly {
  readonly artifacts: readonly NativePackedArtifact[]
  readonly closure: readonly NativeWorkspacePackage[]
  readonly prebuilt: AssembledNativeFixture
  readonly runRoot: string
  readonly source: AssembledNativeFixture
}

export interface AssembleNativeFixturesOptions {
  readonly generatedFiles: Readonly<Record<string, string>>
  readonly orgId: string
  readonly packPackage?: (
    entry: NativeWorkspacePackage,
    packDir: string,
  ) => Promise<NativePackedArtifact>
  readonly projectId: string
  readonly repoRoot: string
  readonly runCommand: NativeLocalCommandRunner
  readonly runRoot: string
}

export interface NativeReleaseAuthorization {
  readonly apply: (headers: Headers) => void
  readonly assertSafe: (label: string, value: unknown) => void
  readonly digestSha256: string
}

export function createNativeReleaseAuthorization(): NativeReleaseAuthorization {
  const credential = randomBytes(32).toString("base64url")
  const digestSha256 = createHash("sha256").update(credential, "utf8").digest("hex")
  const redactor = createSecretRedactor([credential])
  return {
    apply: (headers) => headers.set("x-dawn-vercel-release", credential),
    assertSafe: (label, value) => redactor.assertSafe(label, value),
    digestSha256,
  }
}

export function nativeAgentRunBody(
  route: "/state#agent" | "/stream#agent",
  content: string,
): {
  readonly input: {
    readonly messages: readonly [{ readonly content: string; readonly role: "user" }]
  }
  readonly route: "/state#agent" | "/stream#agent"
} {
  if (route === "/state#agent") assertLogMarker(content)
  else assertBarrierId(content)
  return { input: { messages: [{ content, role: "user" }] }, route }
}

export function renderNativeRouteFiles(
  releaseDigestSha256: string,
): Readonly<Record<string, string>> {
  if (!/^[a-f0-9]{64}$/.test(releaseDigestSha256)) {
    throw new Error("native release digest must be a lowercase SHA-256 hex value")
  }

  const database = [
    'import { Pool } from "pg"',
    "",
    "function nativeDatabaseUrl(): string | undefined {",
    "  const value = process.env.DATABASE_URL",
    "  if (value === undefined) return undefined",
    "  let databaseUrl: URL",
    "  try {",
    "    databaseUrl = new URL(value)",
    "  } catch {",
    '    throw new Error("native fixture DATABASE_URL is malformed")',
    "  }",
    '  databaseUrl.searchParams.set("sslmode", "verify-full")',
    "  return databaseUrl.toString()",
    "}",
    "",
    "export const pool = new Pool({",
    "  connectionString: nativeDatabaseUrl(),",
    "  max: 2,",
    "  connectionTimeoutMillis: 10_000,",
    "  idleTimeoutMillis: 30_000,",
    "  query_timeout: 5_000,",
    "  statement_timeout: 5_000,",
    "})",
    "",
    "function safePoolErrorField(value: unknown, fallback: string): string {",
    '  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)',
    "    ? value",
    "    : fallback",
    "}",
    "",
    'pool.on("error", (error: Error & { readonly code?: unknown }) => {',
    '  console.error("dawn-vercel-fixture-pool-error", {',
    '    code: safePoolErrorField(error.code, "UNKNOWN"),',
    '    name: safePoolErrorField(error.name, "Error"),',
    "  })",
    "})",
    "",
  ].join("\n")

  const streamDeadline = [
    "export async function raceStreamDeadline(operation, timeoutMs, signal) {",
    "  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {",
    '    throw new Error("stream deadline must be a positive safe integer")',
    "  }",
    "  let timeout",
    "  let onAbort",
    "  try {",
    "    const deadline = new Promise((_, reject) => {",
    "      timeout = setTimeout(",
    '        () => reject(new Error("stream operation deadline exceeded")),',
    "        timeoutMs,",
    "      )",
    "      if (signal) {",
    '        onAbort = () => reject(new Error("stream barrier wait aborted"))',
    "        if (signal.aborted) onAbort()",
    '        else signal.addEventListener("abort", onAbort, { once: true })',
    "      }",
    "    })",
    "    return await Promise.race([operation, deadline])",
    "  } finally {",
    "    if (timeout !== undefined) clearTimeout(timeout)",
    '    if (signal && onAbort) signal.removeEventListener("abort", onAbort)',
    "  }",
    "}",
    "",
  ].join("\n")

  const state = [
    'import { HumanMessage, type BaseMessage } from "@langchain/core/messages"',
    'import { Annotation, END, START, StateGraph } from "@langchain/langgraph"',
    'import { DawnPostgresSaver } from "@dawn-ai/postgres-storage"',
    'import { pool } from "../../lib/database.js"',
    "",
    "const State = Annotation.Root({",
    "  messages: Annotation<BaseMessage[]>({",
    "    reducer: (current, update) => [...current, ...update],",
    "    default: () => [],",
    "  }),",
    "  visits: Annotation<number>({",
    "    reducer: (current, update) => current + update,",
    "    default: () => 0,",
    "  }),",
    "  markers: Annotation<string[]>({",
    "    reducer: (current, update) => [...current, ...update],",
    "    default: () => [],",
    "  }),",
    "})",
    "",
    "const checkpointer = new DawnPostgresSaver({ pool })",
    "",
    "function record(state: typeof State.State): { readonly markers: string[]; readonly visits: 1 } {",
    "  const latest = state.messages.at(-1)",
    '  if (!(latest instanceof HumanMessage) || typeof latest.content !== "string") {',
    '    throw new Error("state route requires one latest HumanMessage with string content")',
    "  }",
    "  const marker = latest.content",
    '  if (/^log-vcl-[a-f0-9]{32}$/.test(marker)) console.info("dawn-vercel-fixture-log", marker)',
    "  return { markers: [marker], visits: 1 }",
    "}",
    "",
    "export const agent = new StateGraph(State)",
    '  .addNode("record", record)',
    '  .addEdge(START, "record")',
    '  .addEdge("record", END)',
    "  .compile({ checkpointer })",
    "",
  ].join("\n")

  const stream = [
    'import { HumanMessage } from "@langchain/core/messages"',
    'import { pool } from "../../lib/database.js"',
    'import { raceStreamDeadline } from "../../lib/stream-deadline.mjs"',
    "",
    "const BARRIER_GRAMMAR = /^b-vcl-[a-f0-9]{32}$/",
    "const POLL_INTERVAL_MS = 250",
    "const POLL_DEADLINE_MS = 60_000",
    "const QUERY_DEADLINE_MS = 5_000",
    "",
    "interface RunnableConfig {",
    "  readonly signal?: AbortSignal",
    "}",
    "",
    "function readBarrierId(input: unknown): string {",
    '  if (typeof input !== "object" || input === null || !("messages" in input)) {',
    '    throw new Error("stream route requires normalized messages")',
    "  }",
    "  const messages = (input as { readonly messages?: unknown }).messages",
    "  if (!Array.isArray(messages) || messages.length === 0) {",
    '    throw new Error("stream route requires one latest HumanMessage")',
    "  }",
    "  const latest = messages.at(-1)",
    "  if (",
    "    !(latest instanceof HumanMessage) ||",
    '    typeof latest.content !== "string" ||',
    "    !BARRIER_GRAMMAR.test(latest.content)",
    "  ) {",
    '    throw new Error("stream route requires a canonical barrier identifier")',
    "  }",
    "  return latest.content",
    "}",
    "",
    "async function waitForRelease(barrierId: string, signal?: AbortSignal): Promise<void> {",
    "  const deadline = Date.now() + POLL_DEADLINE_MS",
    "  while (Date.now() < deadline) {",
    '    if (signal?.aborted) throw new Error("stream barrier wait aborted")',
    "    const remainingMs = deadline - Date.now()",
    "    if (remainingMs <= 0) break",
    "    const result = await raceStreamDeadline(",
    "      pool.query<{ readonly released: boolean }>(",
    '        "SELECT released FROM public.dawn_vercel_test_barriers WHERE barrier_id = $1",',
    "        [barrierId],",
    "      ),",
    "      Math.min(QUERY_DEADLINE_MS, remainingMs),",
    "      signal,",
    "    )",
    "    if (result.rows.length > 1) {",
    '      throw new Error("stream barrier query returned multiple rows")',
    "    }",
    "    if (result.rows.length === 1 && result.rows[0]?.released === true) return",
    "    const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))",
    "    if (sleepMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, sleepMs))",
    "  }",
    '  throw new Error("stream barrier wait deadline exceeded")',
    "}",
    "",
    "export const agent = {",
    "  async invoke(input: unknown, config: RunnableConfig = {}) {",
    "    const barrierId = readBarrierId(input)",
    "    await waitForRelease(barrierId, config.signal)",
    "    return { barrierId, released: true as const }",
    "  },",
    "  async *streamEvents(input: unknown, config: RunnableConfig = {}) {",
    "    const barrierId = readBarrierId(input)",
    "    yield {",
    '      event: "on_chat_model_stream",',
    '      name: "dawn-vercel-fixture-stream",',
    '      run_id: "dawn-vercel-fixture-stream",',
    '      data: { chunk: { content: "before-release" } },',
    "    }",
    "    await waitForRelease(barrierId, config.signal)",
    "    yield {",
    '      event: "on_chat_model_stream",',
    '      name: "dawn-vercel-fixture-stream",',
    '      run_id: "dawn-vercel-fixture-stream",',
    '      data: { chunk: { content: "after-release" } },',
    "    }",
    "    yield {",
    '      event: "on_chain_end",',
    '      name: "LangGraph",',
    '      run_id: "dawn-vercel-fixture-stream",',
    "      data: { output: { barrierId, released: true as const } },",
    "    }",
    "  },",
    "}",
    "",
  ].join("\n")

  const release = [
    'import { pool } from "../../lib/database.js"',
    "",
    "const BARRIER_GRAMMAR = /^b-vcl-[a-f0-9]{32}$/",
    "",
    "export async function graph(input: unknown) {",
    "  if (",
    '    typeof input !== "object" ||',
    "    input === null ||",
    '    !("barrierId" in input) ||',
    '    typeof input.barrierId !== "string" ||',
    "    !BARRIER_GRAMMAR.test(input.barrierId)",
    "  ) {",
    '    throw new Error("release route requires a canonical barrier identifier")',
    "  }",
    "  const barrierId = input.barrierId",
    "  const result = await pool.query<{ readonly barrier_id: string }>(",
    '    "UPDATE public.dawn_vercel_test_barriers SET released = true WHERE barrier_id = $1 AND released = false RETURNING barrier_id",',
    "    [barrierId],",
    "  )",
    "  if (result.rows.length !== 1 || result.rows[0]?.barrier_id !== barrierId) {",
    '    throw new Error("release route did not update exactly one requested barrier")',
    "  }",
    "  return { barrierId, released: true as const }",
    "}",
    "",
  ].join("\n")

  const middleware = [
    'import { Buffer } from "node:buffer"',
    'import { createHash, timingSafeEqual } from "node:crypto"',
    'import { allow, defineMiddleware, reject } from "@dawn-ai/sdk"',
    "",
    `const RELEASE_DIGEST = Buffer.from("${releaseDigestSha256}", "hex")`,
    "const RELEASE_HEADER_GRAMMAR = /^[A-Za-z0-9_-]{43}$/",
    "",
    "export default defineMiddleware((request) => {",
    '  if (request.routeId !== "/release") return allow()',
    '  const credential = request.headers["x-dawn-vercel-release"]',
    "  if (!credential || !RELEASE_HEADER_GRAMMAR.test(credential)) {",
    '    return reject(401, { error: "unauthorized" })',
    "  }",
    '  const presentedDigest = createHash("sha256").update(credential, "utf8").digest()',
    "  if (",
    "    presentedDigest.length !== RELEASE_DIGEST.length ||",
    "    !timingSafeEqual(presentedDigest, RELEASE_DIGEST)",
    "  ) {",
    '    return reject(401, { error: "unauthorized" })',
    "  }",
    "  return allow()",
    "})",
    "",
  ].join("\n")

  return {
    "src/app/release/index.ts": release,
    "src/app/state/index.ts": state,
    "src/app/stream/index.ts": stream,
    "src/lib/database.ts": database,
    "src/lib/stream-deadline.mjs": streamDeadline,
    "src/middleware.ts": middleware,
  }
}

function mutableYamlObject(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

function splitYamlFlow(value: string): readonly string[] {
  const parts: string[] = []
  let quote: '"' | "'" | undefined
  let escaped = false
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote === '"' && escaped) {
      escaped = false
      continue
    }
    if (quote === '"' && character === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === ",") {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  if (quote) throw new Error("native fixture lockfile contains an unterminated flow quote")
  parts.push(value.slice(start).trim())
  return parts.filter((part) => part.length > 0)
}

function yamlEntrySeparator(value: string): number {
  let quote: '"' | "'" | undefined
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote === '"' && escaped) {
      escaped = false
      continue
    }
    if (quote === '"' && character === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === ":") return index
  }
  return -1
}

function parseYamlScalar(source: string): unknown {
  const value = source.trim()
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value)
    } catch (error) {
      throw new Error("native fixture lockfile contains invalid double-quoted YAML", {
        cause: error,
      })
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new Error("native fixture lockfile contains invalid single-quoted YAML")
    }
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (value === "{}") return mutableYamlObject()
  if (value === "[]") return []
  if (value.startsWith("{") && value.endsWith("}")) {
    const result = mutableYamlObject()
    for (const entry of splitYamlFlow(value.slice(1, -1))) {
      const separator = yamlEntrySeparator(entry)
      if (separator <= 0) throw new Error("native fixture lockfile contains invalid flow YAML")
      const key = String(parseYamlScalar(entry.slice(0, separator)))
      if (Object.hasOwn(result, key)) {
        throw new Error("native fixture lockfile contains a duplicate flow key")
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: parseYamlScalar(entry.slice(separator + 1)),
        writable: true,
      })
    }
    return result
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitYamlFlow(value.slice(1, -1)).map((entry) => parseYamlScalar(entry))
  }
  if (value === "true") return true
  if (value === "false") return false
  if (value === "null" || value === "~") return null
  return value
}

export function parseNativeFixtureLockfile(source: string): unknown {
  if (source.length === 0 || source.includes("\t")) {
    throw new Error("native fixture lockfile must be nonempty space-indented YAML")
  }
  const lines = source
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line, index) => ({
      indent: line.length - line.trimStart().length,
      line: index + 1,
      text: line.trim(),
    }))
    .filter(({ text }) => text.length > 0 && !text.startsWith("#"))
  const root = mutableYamlObject()
  const stack: Array<{
    readonly indent: number
    readonly value: Record<string, unknown> | unknown[]
  }> = [{ indent: -1, value: root }]

  for (const [index, line] of lines.entries()) {
    if (line.indent % 2 !== 0) {
      throw new Error(`native fixture lockfile line ${line.line} has invalid indentation`)
    }
    while ((stack.at(-1)?.indent ?? -1) >= line.indent) stack.pop()
    const parent = stack.at(-1)?.value
    if (!parent) throw new Error(`native fixture lockfile line ${line.line} has no parent`)
    const next = lines[index + 1]

    if (line.text.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new Error(`native fixture lockfile line ${line.line} has an unexpected sequence`)
      }
      parent.push(parseYamlScalar(line.text.slice(2)))
      continue
    }
    if (Array.isArray(parent)) {
      throw new Error(`native fixture lockfile line ${line.line} must be a sequence item`)
    }

    const separator = yamlEntrySeparator(line.text)
    if (separator <= 0) throw new Error(`native fixture lockfile line ${line.line} is malformed`)
    const key = String(parseYamlScalar(line.text.slice(0, separator)))
    if (Object.hasOwn(parent, key)) {
      throw new Error(`native fixture lockfile line ${line.line} repeats a key`)
    }
    const remainder = line.text.slice(separator + 1).trim()
    const parsed =
      remainder.length > 0
        ? parseYamlScalar(remainder)
        : next && next.indent > line.indent && next.text.startsWith("- ")
          ? []
          : mutableYamlObject()
    Object.defineProperty(parent, key, {
      configurable: true,
      enumerable: true,
      value: parsed,
      writable: true,
    })
    if (remainder.length === 0) {
      if (!next || next.indent <= line.indent) {
        throw new Error(`native fixture lockfile line ${line.line} has an empty mapping value`)
      }
      stack.push({ indent: line.indent, value: parsed as Record<string, unknown> | unknown[] })
    }
  }
  return root
}

function artifactsByName(
  artifacts: readonly NativePackedArtifact[],
): ReadonlyMap<string, NativePackedArtifact> {
  const indexed = new Map<string, NativePackedArtifact>()
  for (const artifact of artifacts) {
    if (indexed.has(artifact.packageName)) {
      throw new Error(`duplicate native packed artifact ${artifact.packageName}`)
    }
    indexed.set(artifact.packageName, artifact)
  }
  return indexed
}

export function renderNativeFixtureManifest(
  kind: "source" | "prebuilt",
  artifacts: readonly NativePackedArtifact[],
): Record<string, unknown> {
  const indexed = artifactsByName(artifacts)
  const localDependencies = Object.fromEntries(
    NATIVE_DIRECT_DAWN_DEPENDENCIES.map((name) => {
      const artifact = indexed.get(name)
      if (!artifact) throw new Error(`native fixture manifest is missing packed dependency ${name}`)
      return [name, `file:vendor/${artifact.tarballName}`]
    }),
  )
  return {
    name: `dawn-vercel-native-${kind}`,
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: "pnpm@10.33.0",
    scripts: { build: "dawn build" },
    dependencies: {
      ...localDependencies,
      "@langchain/core": "1.2.5",
      "@langchain/langgraph": "1.4.9",
      "@langchain/langgraph-checkpoint": "1.1.3",
      "@neondatabase/serverless": "1.1.0",
      hono: "4.12.28",
      pg: "8.22.0",
      zod: "4.4.3",
    },
  }
}

export function renderNativeWorkspaceYaml(artifacts: readonly NativePackedArtifact[]): string {
  artifactsByName(artifacts)
  return [
    "packages:",
    '  - "."',
    "",
    "onlyBuiltDependencies:",
    "  - esbuild",
    "",
    "allowBuilds:",
    "  esbuild: true",
    "",
    "overrides:",
    ...[...artifacts]
      .sort((left, right) => left.packageName.localeCompare(right.packageName))
      .map(
        (artifact) =>
          `  ${JSON.stringify(artifact.packageName)}: ${JSON.stringify(`file:vendor/${artifact.tarballName}`)}`,
      ),
    "",
  ].join("\n")
}

function packageManifestFromJson(value: unknown, path: string): NativePackageManifest {
  const manifest = lockfileRecord(value, path)
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error(`${path} must contain string name and version fields`)
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    if (manifest[field] === undefined) continue
    const dependencies = lockfileRecord(manifest[field], `${path}.${field}`)
    if (Object.values(dependencies).some((entry) => typeof entry !== "string")) {
      throw new Error(`${path}.${field} must contain only string dependency ranges`)
    }
  }
  if (manifest.peerDependenciesMeta !== undefined) {
    const metadata = lockfileRecord(manifest.peerDependenciesMeta, `${path}.peerDependenciesMeta`)
    for (const entry of Object.values(metadata)) {
      const record = lockfileRecord(entry, `${path}.peerDependenciesMeta entry`)
      if (record.optional !== undefined && typeof record.optional !== "boolean") {
        throw new Error(`${path}.peerDependenciesMeta optional must be boolean`)
      }
    }
  }
  return manifest as unknown as NativePackageManifest
}

async function readNativeWorkspacePackages(
  repoRoot: string,
): Promise<ReadonlyMap<string, NativeWorkspacePackage>> {
  const packagesRoot = join(repoRoot, "packages")
  const entries = await readdir(packagesRoot, { withFileTypes: true })
  const packages = new Map<string, NativeWorkspacePackage>()
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const dir = join("packages", entry.name)
    const manifestPath = join(repoRoot, dir, "package.json")
    let source: string
    try {
      source = await readFile(manifestPath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch (error) {
      throw new Error(`native workspace package manifest is invalid at ${manifestPath}`, {
        cause: error,
      })
    }
    const manifest = packageManifestFromJson(parsed, `native workspace package ${entry.name}`)
    if (!manifest.name.startsWith("@dawn-ai/")) continue
    if (packages.has(manifest.name)) {
      throw new Error(`duplicate native workspace package ${manifest.name}`)
    }
    packages.set(manifest.name, { dir, manifest, name: manifest.name })
  }
  return packages
}

async function runSuccessfulLocalCommand(
  runCommand: NativeLocalCommandRunner,
  request: Omit<NativeLocalCommandRequest, "env" | "timeoutMs">,
): Promise<NativeLocalCommandResult> {
  const result = await runCommand({
    ...request,
    env: stringEnvironment(sanitizeChildEnvironment(process.env, {})),
    timeoutMs: NATIVE_VERCEL_CHILD_TIMEOUT_MS,
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `native fixture local command ${basename(request.executable)} failed with exit ${result.exitCode}: ${result.stderr || result.stdout}`,
    )
  }
  return result
}

async function packNativeWorkspacePackage(
  entry: NativeWorkspacePackage,
  packDir: string,
  repoRoot: string,
  runCommand: NativeLocalCommandRunner,
): Promise<NativePackedArtifact> {
  const existing = new Set(await readdir(packDir))
  await runSuccessfulLocalCommand(runCommand, {
    executable: "corepack",
    args: ["pnpm", "pack", "--pack-destination", packDir],
    cwd: join(repoRoot, entry.dir),
  })
  const tarballs = (await readdir(packDir)).filter(
    (name) => name.endsWith(".tgz") && !existing.has(name),
  )
  if (tarballs.length !== 1) {
    throw new Error(`${entry.name} pack must produce exactly one new tarball`)
  }
  const tarballName = tarballs[0] as string
  const tarballPath = join(packDir, tarballName)
  const extractRoot = join(packDir, `.extract-${entry.name.slice("@dawn-ai/".length)}`)
  await mkdir(extractRoot)
  await runSuccessfulLocalCommand(runCommand, {
    executable: "tar",
    args: ["-xzf", tarballPath, "-C", extractRoot],
    cwd: repoRoot,
  })
  const extractedPath = join(extractRoot, "package", "package.json")
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(extractedPath, "utf8"))
  } catch (error) {
    throw new Error(`${entry.name} packed artifact must contain valid package.json`, {
      cause: error,
    })
  }
  const packageJson = packageManifestFromJson(parsed, `${entry.name} packed package.json`)
  if (packageJson.name !== entry.name || packageJson.version !== entry.manifest.version) {
    throw new Error(`${entry.name} packed metadata does not match its workspace manifest`)
  }
  return {
    packageJson,
    packageName: entry.name,
    packageVersion: entry.manifest.version,
    tarballName,
    tarballPath,
  }
}

function assertSafeGeneratedFilePath(path: string): void {
  const segments = path.split(/[\\/]/)
  const reserved = new Set([
    ".dawn",
    ".vercel",
    "node_modules",
    "vendor",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "vercel.json",
    "dawn.config.ts",
  ])
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    reserved.has(segments[0] as string)
  ) {
    throw new Error(`unsafe generated native fixture path ${path}`)
  }
}

async function writeNativeFixture(
  root: string,
  kind: "source" | "prebuilt",
  artifacts: readonly NativePackedArtifact[],
  generatedFiles: Readonly<Record<string, string>>,
  orgId: string,
  projectId: string,
): Promise<AssembledNativeFixture> {
  await mkdir(join(root, "vendor"), { recursive: true })
  await mkdir(join(root, ".vercel"), { recursive: true })
  for (const artifact of artifacts) {
    await copyFile(artifact.tarballPath, join(root, "vendor", artifact.tarballName))
  }
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      `${JSON.stringify(renderNativeFixtureManifest(kind, artifacts), null, 2)}\n`,
      "utf8",
    ),
    writeFile(join(root, "pnpm-workspace.yaml"), renderNativeWorkspaceYaml(artifacts), "utf8"),
    writeFile(
      join(root, "vercel.json"),
      `${JSON.stringify(RECOMMENDED_VERCEL_CONFIG, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(root, ".vercel", "project.json"),
      `${JSON.stringify({ orgId, projectId }, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(root, "dawn.config.ts"),
      'export default { build: { targets: ["vercel"] } }\n',
      "utf8",
    ),
  ])
  for (const [path, contents] of Object.entries(generatedFiles)) {
    assertSafeGeneratedFilePath(path)
    const destination = join(root, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, contents, { encoding: "utf8", flag: "wx" })
  }
  return { kind, lockfilePath: join(root, "pnpm-lock.yaml"), root }
}

export async function assembleNativeFixtures(
  options: AssembleNativeFixturesOptions,
): Promise<NativeFixtureAssembly> {
  if (!isAbsolute(options.repoRoot) || !isAbsolute(options.runRoot)) {
    throw new Error("native fixture repoRoot and runRoot must be absolute")
  }
  await assertRegularDirectory(options.repoRoot, "native fixture repository root")
  const canonicalRepoRoot = await realpath(options.repoRoot)
  const canonicalRunParent = await realpath(dirname(options.runRoot))
  const canonicalRunRoot = join(canonicalRunParent, basename(options.runRoot))
  const relativeRunRoot = relative(canonicalRepoRoot, canonicalRunRoot)
  const runRootIsOutside =
    relativeRunRoot === ".." ||
    relativeRunRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativeRunRoot)
  if (!runRootIsOutside) {
    throw new Error("native fixture runRoot must be outside the repository")
  }
  await mkdir(canonicalRunRoot)
  const packDir = join(canonicalRunRoot, "packs")
  const fixtureRoot = join(canonicalRunRoot, "fixtures")
  await mkdir(packDir)
  await mkdir(fixtureRoot)

  const packages = await readNativeWorkspacePackages(canonicalRepoRoot)
  const closure = deriveDawnPackageClosure(NATIVE_DIRECT_DAWN_DEPENDENCIES, packages)
  await runSuccessfulLocalCommand(options.runCommand, {
    executable: "corepack",
    args: ["pnpm", "build"],
    cwd: canonicalRepoRoot,
  })

  const artifacts: NativePackedArtifact[] = []
  for (const entry of closure) {
    const artifact = options.packPackage
      ? await options.packPackage(entry, packDir)
      : await packNativeWorkspacePackage(entry, packDir, canonicalRepoRoot, options.runCommand)
    if (
      artifact.packageName !== entry.name ||
      artifact.packageVersion !== entry.manifest.version ||
      artifact.packageJson.name !== entry.name ||
      artifact.packageJson.version !== entry.manifest.version ||
      dirname(artifact.tarballPath) !== packDir ||
      basename(artifact.tarballPath) !== artifact.tarballName
    ) {
      throw new Error(`packed artifact identity mismatch for ${entry.name}`)
    }
    const stats = await lstat(artifact.tarballPath)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`packed artifact for ${entry.name} must be a regular non-symlink file`)
    }
    artifacts.push(artifact)
  }
  const source = await writeNativeFixture(
    join(fixtureRoot, "source"),
    "source",
    artifacts,
    options.generatedFiles,
    options.orgId,
    options.projectId,
  )
  const prebuilt = await writeNativeFixture(
    join(fixtureRoot, "prebuilt"),
    "prebuilt",
    artifacts,
    options.generatedFiles,
    options.orgId,
    options.projectId,
  )

  for (const fixture of [source, prebuilt]) {
    await runSuccessfulLocalCommand(options.runCommand, {
      executable: "corepack",
      args: ["pnpm", "install", "--lockfile-only", "--ignore-scripts"],
      cwd: fixture.root,
    })
    validateNativeFixtureLockfile(
      parseNativeFixtureLockfile(await readFile(fixture.lockfilePath, "utf8")),
      artifacts,
    )
  }
  await rm(join(source.root, "node_modules"), { force: true, recursive: true })
  await runSuccessfulLocalCommand(options.runCommand, {
    executable: "corepack",
    args: ["pnpm", "install", "--frozen-lockfile"],
    cwd: prebuilt.root,
  })

  const expectedTarballs = artifacts.map(({ tarballName }) => tarballName)
  await assertNativeFixtureUploadIsolation({
    expectedTarballs,
    kind: "source",
    orgId: options.orgId,
    projectId: options.projectId,
    root: source.root,
  })
  return { artifacts, closure, prebuilt, runRoot: canonicalRunRoot, source }
}

export function deriveDawnPackageClosure(
  roots: readonly string[],
  packages: ReadonlyMap<string, NativeWorkspacePackage>,
): readonly NativeWorkspacePackage[] {
  const visited = new Set<string>()
  const pending = [...roots]
  while (pending.length > 0) {
    const name = pending.pop() as string
    if (visited.has(name)) continue
    if (!name.startsWith("@dawn-ai/")) {
      throw new Error(`native fixture root ${name} must be a Dawn package`)
    }
    const entry = packages.get(name)
    if (!entry) throw new Error(`native fixture package closure is missing ${name}`)
    if (entry.name !== name || entry.manifest.name !== name) {
      throw new Error(`native fixture package map entry for ${name} has inconsistent names`)
    }
    visited.add(name)

    const dependencies = new Set([
      ...Object.keys(entry.manifest.dependencies ?? {}),
      ...Object.keys(entry.manifest.optionalDependencies ?? {}),
      ...Object.keys(entry.manifest.peerDependencies ?? {}).filter(
        (dependency) => entry.manifest.peerDependenciesMeta?.[dependency]?.optional !== true,
      ),
    ])
    for (const dependency of dependencies) {
      if (dependency.startsWith("@dawn-ai/") && !visited.has(dependency)) pending.push(dependency)
    }
  }

  return [...visited]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => packages.get(name) as NativeWorkspacePackage)
}

function lockfileRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a lockfile object`)
  }
  return value as Record<string, unknown>
}

function collectLockfileStrings(
  value: unknown,
  output: string[] = [],
  active = new WeakSet<object>(),
): readonly string[] {
  if (typeof value === "string") {
    output.push(value)
    return output
  }
  if (!value || typeof value !== "object") return output
  if (active.has(value)) throw new Error("native fixture lockfile contains a reference cycle")
  active.add(value)
  try {
    if (Array.isArray(value)) {
      for (const entry of value) collectLockfileStrings(entry, output, active)
      return output
    }
    for (const [key, entry] of Object.entries(value)) {
      output.push(key)
      collectLockfileStrings(entry, output, active)
    }
    return output
  } finally {
    active.delete(value)
  }
}

function dawnNameFromLockfileKey(value: string): string | undefined {
  const match = /^(@dawn-ai\/[A-Za-z0-9._-]+)(?:@|$)/.exec(value)
  return match?.[1]
}

function parsePnpmPeerContext(value: string, start: number): number | undefined {
  if (value[start] !== "(") return undefined
  let index = start + 1
  const peer = /^(?:@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)@/.exec(value.slice(index))
  if (!peer) return undefined
  index += peer[0].length

  const versionStart = index
  while (index < value.length && value[index] !== "(" && value[index] !== ")") {
    if (/\s/.test(value[index] as string)) return undefined
    index += 1
  }
  if (index === versionStart) return undefined
  if (/[:/\\]/.test(value.slice(versionStart, index))) return undefined

  while (value[index] === "(") {
    const nestedEnd = parsePnpmPeerContext(value, index)
    if (nestedEnd === undefined) return undefined
    index = nestedEnd
  }
  return value[index] === ")" ? index + 1 : undefined
}

function hasCompletePnpmPeerSuffix(value: string): boolean {
  if (value.length === 0) return false
  let index = 0
  while (index < value.length) {
    const contextEnd = parsePnpmPeerContext(value, index)
    if (contextEnd === undefined) return false
    index = contextEnd
  }
  return true
}

function matchesVendoredReference(value: string, ref: string): boolean {
  return (
    value === ref || (value.startsWith(ref) && hasCompletePnpmPeerSuffix(value.slice(ref.length)))
  )
}

function matchesVendoredIdentity(value: string, packageName: string, ref: string): boolean {
  return matchesVendoredReference(value, `${packageName}@${ref}`)
}

export function validateNativeFixtureLockfile(
  value: unknown,
  artifacts: readonly NativePackedArtifact[],
): void {
  const lockfile = lockfileRecord(value, "native fixture lockfile")
  if (lockfile.lockfileVersion !== "9.0") {
    throw new Error('native fixture lockfileVersion must be exactly "9.0"')
  }
  const expected = new Map<
    string,
    { readonly artifact: NativePackedArtifact; readonly ref: string }
  >()
  const expectedTarballs = new Set<string>()
  for (const artifact of artifacts) {
    if (!/^@dawn-ai\/[A-Za-z0-9._-]+$/.test(artifact.packageName)) {
      throw new Error(`invalid Dawn packed artifact name ${artifact.packageName}`)
    }
    if (
      basename(artifact.tarballName) !== artifact.tarballName ||
      !/^[A-Za-z0-9._-]+\.tgz$/.test(artifact.tarballName)
    ) {
      throw new Error(`invalid vendored tarball name for ${artifact.packageName}`)
    }
    if (basename(artifact.tarballPath) !== artifact.tarballName) {
      throw new Error(`packed tarball path does not match ${artifact.packageName}`)
    }
    if (expected.has(artifact.packageName) || expectedTarballs.has(artifact.tarballName)) {
      throw new Error(`duplicate native packed artifact for ${artifact.packageName}`)
    }
    expectedTarballs.add(artifact.tarballName)
    expected.set(artifact.packageName, {
      artifact,
      ref: `file:vendor/${artifact.tarballName}`,
    })
  }
  if (expected.size === 0)
    throw new Error("native fixture lockfile expects a nonempty Dawn closure")

  const strings = collectLockfileStrings(lockfile)
  for (const item of strings) {
    const dawnName = dawnNameFromLockfileKey(item)
    if (dawnName) {
      const expectedEntry = expected.get(dawnName)
      if (!expectedEntry) {
        throw new Error(`native fixture lockfile contains unexpected Dawn package ${dawnName}`)
      }
      if (item !== dawnName && !matchesVendoredIdentity(item, dawnName, expectedEntry.ref)) {
        throw new Error(`native fixture lockfile contains a non-vendored copy of ${dawnName}`)
      }
    }
    if (/^(?:workspace:|link:)/.test(item)) {
      throw new Error("native fixture lockfile contains a workspace or link reference")
    }
    if (
      item.includes("../") ||
      item.includes("..\\") ||
      /(?:^|[\\/])(?:packages|assets)[\\/]/.test(item) ||
      /file:(?:\/|[A-Za-z]:[\\/])/.test(item)
    ) {
      throw new Error("native fixture lockfile contains a repository or absolute path")
    }
    if (item.includes("file:")) {
      const recognized = [...expected].some(([name, { ref }]) => {
        return matchesVendoredReference(item, ref) || matchesVendoredIdentity(item, name, ref)
      })
      if (!recognized) {
        throw new Error("native fixture lockfile contains an unexpected file reference")
      }
    }
  }

  const overrides = lockfileRecord(lockfile.overrides, "native fixture lockfile overrides")
  for (const [name, { ref }] of expected) {
    if (overrides[name] !== ref) {
      throw new Error(`native fixture lockfile override for ${name} must be ${ref}`)
    }
  }

  const importers = lockfileRecord(lockfile.importers, "native fixture lockfile importers")
  for (const [importerName, importerValue] of Object.entries(importers)) {
    const importer = lockfileRecord(importerValue, `native fixture importer ${importerName}`)
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      if (importer[field] === undefined) continue
      const dependencies = lockfileRecord(importer[field], `native fixture importer ${field}`)
      for (const [name, dependencyValue] of Object.entries(dependencies)) {
        if (!name.startsWith("@dawn-ai/")) continue
        const expectedEntry = expected.get(name)
        if (!expectedEntry) {
          throw new Error(`native fixture importer contains unexpected Dawn package ${name}`)
        }
        const dependency = lockfileRecord(dependencyValue, `native fixture importer ${name}`)
        if (
          dependency.specifier !== expectedEntry.ref ||
          typeof dependency.version !== "string" ||
          !matchesVendoredReference(dependency.version, expectedEntry.ref)
        ) {
          throw new Error(`native fixture importer does not use the matching tarball for ${name}`)
        }
      }
    }
  }

  const packages = lockfileRecord(lockfile.packages, "native fixture lockfile packages")
  const snapshots = lockfileRecord(lockfile.snapshots, "native fixture lockfile snapshots")
  for (const [name, { artifact, ref }] of expected) {
    const packageKeys = Object.keys(packages).filter((key) =>
      matchesVendoredIdentity(key, name, ref),
    )
    const snapshotKeys = Object.keys(snapshots).filter((key) =>
      matchesVendoredIdentity(key, name, ref),
    )
    if (packageKeys.length !== 1 || snapshotKeys.length !== 1) {
      throw new Error(
        `native fixture lockfile must contain ${name} exactly once in packages and snapshots`,
      )
    }
    const packageEntry = lockfileRecord(packages[packageKeys[0] as string], `package ${name}`)
    const resolution = lockfileRecord(packageEntry.resolution, `package ${name} resolution`)
    if (resolution.tarball !== ref || packageEntry.version !== artifact.packageVersion) {
      throw new Error(`native fixture lockfile package ${name} does not match its packed artifact`)
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function assertRegularDirectory(path: string, label: string): Promise<void> {
  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a regular non-symlink directory`)
  }
}

async function assertNoSymlinks(path: string, label: string): Promise<void> {
  const stats = await lstat(path)
  if (stats.isSymbolicLink()) throw new Error(`${label} contains a symlink at ${path}`)
  if (!stats.isDirectory()) return
  for (const entry of await readdir(path)) {
    await assertNoSymlinks(join(path, entry), label)
  }
}

export async function assertNativeFixtureUploadIsolation(options: {
  readonly expectedTarballs: readonly string[]
  readonly kind: "source" | "prebuilt"
  readonly orgId: string
  readonly projectId: string
  readonly root: string
}): Promise<void> {
  if (!isAbsolute(options.root)) throw new Error("native fixture root must be absolute")
  await assertRegularDirectory(options.root, "native fixture root")

  const expectedTarballs = [...options.expectedTarballs].sort()
  if (
    expectedTarballs.length === 0 ||
    new Set(expectedTarballs).size !== expectedTarballs.length ||
    expectedTarballs.some((name) => basename(name) !== name || !/^[A-Za-z0-9._-]+\.tgz$/.test(name))
  ) {
    throw new Error("expected vendored tarball names must be unique safe basenames")
  }

  const projectPath = join(options.root, ".vercel", "project.json")
  const projectStats = await lstat(projectPath)
  if (projectStats.isSymbolicLink() || !projectStats.isFile()) {
    throw new Error("native fixture project link must be a regular non-symlink file")
  }
  let project: unknown
  try {
    project = JSON.parse(await readFile(projectPath, "utf8"))
  } catch (error) {
    throw new Error("native fixture project link must contain valid JSON", { cause: error })
  }
  const projectRecord = lockfileRecord(project, "native fixture project link")
  if (
    Object.keys(projectRecord).sort().join("\0") !== "orgId\0projectId" ||
    projectRecord.orgId !== options.orgId ||
    projectRecord.projectId !== options.projectId
  ) {
    throw new Error("native fixture project link must exactly match the expected project binding")
  }

  const vendorPath = join(options.root, "vendor")
  await assertRegularDirectory(vendorPath, "native fixture vendor directory")
  await assertNoSymlinks(vendorPath, "native fixture vendor directory")
  const actualTarballs = (await readdir(vendorPath)).sort()
  if (actualTarballs.join("\0") !== expectedTarballs.join("\0")) {
    throw new Error("native fixture vendor directory must contain the exact expected tarballs")
  }
  for (const name of expectedTarballs) {
    const stats = await lstat(join(vendorPath, name))
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`native fixture tarball ${name} must be a regular non-symlink file`)
    }
  }

  if (options.kind === "source") {
    if (await pathExists(join(options.root, "node_modules"))) {
      throw new Error("source native fixture must not contain node_modules")
    }
    if (await pathExists(join(options.root, ".vercel", "output"))) {
      throw new Error("source native fixture must not contain .vercel/output")
    }
    if (await pathExists(join(options.root, ".dawn"))) {
      throw new Error("source native fixture must not contain .dawn")
    }
    await assertNoSymlinks(options.root, "source native fixture upload tree")
    return
  }

  const outputPath = join(options.root, ".vercel", "output")
  await assertRegularDirectory(outputPath, "prebuilt native fixture output")
  await assertNoSymlinks(outputPath, "prebuilt native fixture output")
}

export interface NativeLaneEnvironment {
  readonly artifactDir: string
  readonly databaseUrl: string
  readonly orgId: string
  readonly projectId: string
  readonly token: string
}

export function nativeLaneEnabled(value: string | undefined): boolean {
  if (value === undefined) return false
  if (value === "1") return true
  throw new Error('DAWN_TEST_VERCEL must be exactly "1" when present')
}

export function readNativeLaneEnvironment(
  env: NodeJS.ProcessEnv,
  nodeVersion = process.versions.node,
): NativeLaneEnvironment {
  const failures: string[] = []
  if (nodeVersion.split(".", 1)[0] !== "24") failures.push(`Node 24 (received ${nodeVersion})`)

  const artifactDir = env.DAWN_VERCEL_ARTIFACT_DIR
  if (!artifactDir) failures.push("DAWN_VERCEL_ARTIFACT_DIR")
  else if (!isAbsolute(artifactDir)) failures.push("DAWN_VERCEL_ARTIFACT_DIR (absolute path)")

  for (const name of REQUIRED_VERCEL_ENV) {
    if (!env[name]) failures.push(name)
  }
  if (env.DAWN_VERCEL_ORG_ID && !/^team_[A-Za-z0-9]+$/.test(env.DAWN_VERCEL_ORG_ID)) {
    failures.push("DAWN_VERCEL_ORG_ID (team_* identifier)")
  }
  if (env.DAWN_VERCEL_PROJECT_ID && !/^prj_[A-Za-z0-9]+$/.test(env.DAWN_VERCEL_PROJECT_ID)) {
    failures.push("DAWN_VERCEL_PROJECT_ID (prj_* identifier)")
  }
  if (failures.length > 0) {
    throw new Error(`native Vercel lane input validation failed: ${failures.join(", ")}`)
  }

  return {
    artifactDir: artifactDir as string,
    databaseUrl: env.DAWN_VERCEL_DATABASE_URL as string,
    orgId: env.DAWN_VERCEL_ORG_ID as string,
    projectId: env.DAWN_VERCEL_PROJECT_ID as string,
    token: env.DAWN_VERCEL_TOKEN as string,
  }
}

function assertGrammar(name: string, value: string, grammar: RegExp): string {
  if (!grammar.test(value)) throw new Error(`${name} does not match ${grammar.source}`)
  return value
}

export function assertDeploymentId(value: string): string {
  return assertGrammar("deployment ID", value, /^dpl_[A-Za-z0-9]+$/)
}

export function assertReconciliationMarker(value: string): string {
  return assertGrammar("reconciliation marker", value, /^vclrun_[a-f0-9]{32}$/)
}

export function assertThreadId(value: string): string {
  return assertGrammar("thread ID", value, /^t-vcl-[a-f0-9]{32}$/)
}

export function assertBarrierId(value: string): string {
  return assertGrammar("barrier ID", value, /^b-vcl-[a-f0-9]{32}$/)
}

export function assertLogMarker(value: string): string {
  return assertGrammar("log marker", value, /^log-vcl-[a-f0-9]{32}$/)
}

const VERCEL_HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+vercel\.app$/

export function canonicalizeVercelOrigin(value: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new Error("Vercel deployment origin must be a nonempty value without whitespace")
  }
  const bareHostname = /^[A-Za-z0-9.-]+$/.test(value) ? value : undefined
  const absoluteMatch = /^https:\/\/([A-Za-z0-9.-]+)\/?$/.exec(value)
  const hostnameInput = bareHostname ?? absoluteMatch?.[1]
  if (
    !hostnameInput ||
    hostnameInput.length > 253 ||
    !VERCEL_HOSTNAME.test(hostnameInput.toLowerCase())
  ) {
    throw new Error(
      "Vercel deployment origin must be a bare hostname or an exact root HTTPS URL on *.vercel.app",
    )
  }

  let parsed: URL
  try {
    parsed = new URL(absoluteMatch ? value : `https://${value}`)
  } catch (error) {
    throw new Error("Vercel deployment origin is malformed", { cause: error })
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Vercel deployment origin must be an HTTPS root origin")
  }
  const hostname = parsed.hostname.toLowerCase()
  if (!VERCEL_HOSTNAME.test(hostname)) {
    throw new Error("Vercel deployment origin must use a valid *.vercel.app hostname")
  }
  return `https://${hostname}`
}

export interface SecretRedactor {
  readonly assertSafe: (label: string, value: unknown) => void
  readonly redact: (value: string) => string
  readonly redactValue: (value: unknown) => unknown
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function projectError(value: Error): Record<string, unknown> {
  return {
    ...Object.fromEntries(Object.entries(value)),
    name: value.name,
    message: value.message,
    ...(value.stack ? { stack: value.stack } : {}),
    ...(value.cause !== undefined ? { cause: value.cause } : {}),
    ...(value instanceof AggregateError ? { errors: value.errors } : {}),
  }
}

function mapStrings(
  value: unknown,
  transform: (value: string) => string,
  active = new WeakSet<object>(),
  jsonKey = "",
): unknown {
  if (typeof value === "string") return transform(value)
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    if (active.has(value)) throw new Error("evidence contains a reference cycle")
    active.add(value)
    try {
      const toJSON = (value as { readonly toJSON?: unknown }).toJSON
      if (typeof toJSON === "function") {
        return mapStrings(toJSON.call(value, jsonKey), transform, active, jsonKey)
      }
      if (value instanceof Error) return mapStrings(projectError(value), transform, active, jsonKey)
      if (Array.isArray(value)) {
        return value.map((entry, index) => mapStrings(entry, transform, active, String(index)))
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          transform(key),
          mapStrings(entry, transform, active, key),
        ]),
      )
    } finally {
      active.delete(value)
    }
  }
  return value
}

function collectRawJsonStrings(
  value: unknown,
  strings: string[] = [],
  active = new WeakSet<object>(),
  jsonKey = "",
): string[] {
  if (typeof value === "string") {
    strings.push(value)
    return strings
  }
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return strings
  if (active.has(value)) throw new Error("evidence contains a reference cycle")
  active.add(value)
  try {
    const toJSON = (value as { readonly toJSON?: unknown }).toJSON
    if (typeof toJSON === "function") {
      collectRawJsonStrings(toJSON.call(value, jsonKey), strings, active, jsonKey)
    }
    if (value instanceof Error) {
      collectRawJsonStrings(projectError(value), strings, active, jsonKey)
      return strings
    }
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) {
        collectRawJsonStrings(entry, strings, active, String(index))
      }
      return strings
    }
    for (const [key, entry] of Object.entries(value)) {
      strings.push(key)
      collectRawJsonStrings(entry, strings, active, key)
    }
    return strings
  } finally {
    active.delete(value)
  }
}

function secretScanSurfaces(value: unknown): readonly string[] {
  if (typeof value === "string") return [value]
  try {
    const rawStrings = collectRawJsonStrings(value)
    const projectedJson = JSON.stringify(mapStrings(value, (entry) => entry))
    return projectedJson === undefined ? rawStrings : [...rawStrings, projectedJson]
  } catch (error) {
    void error
    throw new Error("evidence could not be traversed for protected-value scanning")
  }
}

function assertPlainJsonValue(value: unknown, path = "$", active = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers`)
    return
  }
  if (typeof value !== "object") {
    throw new Error(`${path} must contain only plain JSON values`)
  }
  if (active.has(value)) throw new Error(`${path} contains a JSON reference cycle`)
  active.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(`${path} must contain only plain JSON arrays`)
      }
      const enumerableKeys = Object.keys(value)
      if (
        enumerableKeys.length !== value.length ||
        enumerableKeys.some((key, index) => key !== String(index))
      ) {
        throw new Error(`${path} must not contain sparse arrays or extra array properties`)
      }
      const allowedKeys = new Set<PropertyKey>([
        "length",
        ...Array.from({ length: value.length }, (_, index) => String(index)),
      ])
      if (Reflect.ownKeys(value).some((key) => !allowedKeys.has(key))) {
        throw new Error(`${path} must not contain hidden array properties`)
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error(`${path}[${index}] must be an enumerable JSON data property`)
        }
        assertPlainJsonValue(descriptor.value, `${path}[${index}]`, active)
      }
      return
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects`)
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new Error(`${path} must not contain symbol keys`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error(`${path} must contain only enumerable JSON data properties`)
      }
      assertPlainJsonValue(descriptor.value, `${path} property`, active)
    }
  } finally {
    active.delete(value)
  }
}

function cloneOwnJsonData(value: unknown, path = "$", active = new WeakSet<object>()): unknown {
  if (!value || typeof value !== "object") return value
  if (active.has(value)) throw new Error(`${path} contains a reference cycle`)
  active.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(`${path} must contain only plain arrays`)
      }
      const allowedKeys = new Set<PropertyKey>([
        "length",
        ...Array.from({ length: value.length }, (_, index) => String(index)),
      ])
      if (Reflect.ownKeys(value).some((key) => !allowedKeys.has(key))) {
        throw new Error(`${path} must not contain sparse or extra array properties`)
      }
      const clone: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error(`${path}[${index}] must be an enumerable data property`)
        }
        clone.push(cloneOwnJsonData(descriptor.value, `${path}[${index}]`, active))
      }
      return clone
    }
    const clone: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) {
        throw new Error(`${path} must contain only data properties`)
      }
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneOwnJsonData(descriptor.value, `${path} property`, active),
        writable: true,
      })
    }
    return clone
  } finally {
    active.delete(value)
  }
}

export function createSecretRedactor(protectedValues: readonly string[]): SecretRedactor {
  if (protectedValues.some((value) => value.length === 0)) {
    throw new Error("protected values must be nonempty")
  }
  const variants = [
    ...new Set(protectedValues.flatMap((value) => [value, encodeURIComponent(value)])),
  ].sort((left, right) => right.length - left.length)
  const matchers = variants.map((value) => ({
    raw: value,
    matcher: new RegExp(escapeRegExp(value), value.includes("%") ? "gi" : "g"),
  }))
  const redact = (value: string): string => {
    let result = value
    for (const { matcher } of matchers) result = result.replace(matcher, "[REDACTED]")
    return result
  }
  return {
    assertSafe: (label, value) => {
      const surfaces = secretScanSurfaces(value)
      const leaked = matchers.find(({ raw, matcher }) => {
        const matched = surfaces.some((surface) => {
          matcher.lastIndex = 0
          const found = matcher.test(surface)
          matcher.lastIndex = 0
          return found
        })
        return matched && raw.length > 0
      })
      if (leaked) throw new Error(`${label} contains a protected value`)
    },
    redact,
    redactValue: (value) => {
      try {
        return mapStrings(value, redact)
      } catch (error) {
        void error
        throw new Error("evidence could not be redacted safely")
      }
    },
  }
}

export function sanitizeChildEnvironment(
  inherited: NodeJS.ProcessEnv,
  allowedAdditions: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue
    if (
      name.startsWith("DAWN_VERCEL_") ||
      name.startsWith("VERCEL_") ||
      name.startsWith("NOW_") ||
      name === "DATABASE_URL" ||
      name.toUpperCase().includes("RELEASE")
    ) {
      continue
    }
    sanitized[name] = value
  }
  for (const [name, value] of Object.entries(allowedAdditions)) sanitized[name] = value
  return sanitized
}

const NATIVE_CHILD_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024
const NATIVE_CHILD_TREE_KILL_MS = 100
const NATIVE_CHILD_HARD_SETTLE_MS = 250

interface NativeChildHandle {
  readonly pid?: number
  readonly stderr: NodeJS.ReadableStream & { destroy: () => void }
  readonly stdout: NodeJS.ReadableStream & { destroy: () => void }
  kill(signal?: NodeJS.Signals): boolean
  off(event: "error", listener: () => void): this
  off(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: "error", listener: () => void): this
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

interface NativeTaskkillHandle {
  kill(signal?: NodeJS.Signals): boolean
  off(event: "error", listener: () => void): this
  off(event: "close", listener: (code: number | null) => void): this
  once(event: "error", listener: () => void): this
  once(event: "close", listener: (code: number | null) => void): this
}

export async function runNativeWindowsTaskkill(
  pid: number,
  spawnTaskkill: (executable: string, args: readonly string[]) => NativeTaskkillHandle = (
    executable,
    args,
  ) =>
    spawn(executable, [...args], {
      detached: false,
      shell: false,
      stdio: "ignore",
    }) as NativeTaskkillHandle,
  timeoutMs = NATIVE_CHILD_TREE_KILL_MS,
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("native Windows tree-kill timeout is malformed")
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false
    let killer: NativeTaskkillHandle
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      killer.off("error", onError)
      killer.off("close", onClose)
      resolve(result)
    }
    const onError = (): void => finish(false)
    const onClose = (code: number | null): void => finish(code === 0)
    try {
      killer = spawnTaskkill("taskkill", ["/PID", String(pid), "/T", "/F"])
    } catch {
      resolve(false)
      return
    }
    killer.once("error", onError)
    killer.once("close", onClose)
    timer = setTimeout(() => {
      try {
        killer.kill("SIGKILL")
      } catch {
        // The bounded result below owns settlement even if the killer cannot be stopped.
      }
      finish(false)
    }, timeoutMs)
    timer.unref()
  })
}

export function createNativeChildRunner(
  options: {
    readonly killProcessTree?: (child: NativeChildHandle) => boolean | Promise<boolean>
    readonly platform?: NodeJS.Platform
    readonly runWindowsTaskkill?: (pid: number) => Promise<boolean>
    readonly spawnChild?: (
      executable: string,
      args: readonly string[],
      options: {
        readonly cwd: string
        readonly detached: boolean
        readonly env: Readonly<Record<string, string>>
      },
    ) => NativeChildHandle
  } = {},
): NativeLocalCommandRunner & NativeVercelChildRunner {
  const platform = options.platform ?? process.platform
  const spawnChild =
    options.spawnChild ??
    ((executable, args, childOptions) =>
      spawn(executable, [...args], {
        ...childOptions,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      }) as unknown as NativeChildHandle)
  const killProcessTree =
    options.killProcessTree ??
    (async (child: NativeChildHandle): Promise<boolean> => {
      const pid = child.pid
      if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return child.kill("SIGKILL")
      if (platform === "win32") {
        try {
          return await nativeWithTimeout(
            "Windows tree termination",
            NATIVE_CHILD_TREE_KILL_MS,
            (options.runWindowsTaskkill ?? runNativeWindowsTaskkill)(pid as number),
          )
        } catch {
          return false
        }
      }
      process.kill(-(pid as number), "SIGKILL")
      return true
    })

  return async (request) => {
    if (
      typeof request.executable !== "string" ||
      request.executable.length === 0 ||
      !isAbsolute(request.cwd) ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs <= 0 ||
      !Array.isArray(request.args) ||
      request.args.some((argument) => typeof argument !== "string")
    ) {
      throw new Error("native child request is malformed")
    }
    const env = stringEnvironment(request.env)
    return await new Promise<NativeLocalCommandResult>((resolve, reject) => {
      let settled = false
      let stdout = ""
      let stderr = ""
      let terminationError: Error | undefined
      let hardSettleTimer: ReturnType<typeof setTimeout> | undefined
      const child = spawnChild(request.executable, request.args, {
        cwd: request.cwd,
        detached: platform !== "win32",
        env,
      })
      const stdoutDecoder = new StringDecoder("utf8")
      const stderrDecoder = new StringDecoder("utf8")
      let stdoutBytes = 0
      let stderrBytes = 0
      const onStdout = (chunk: Buffer): void => append("stdout", chunk)
      const onStderr = (chunk: Buffer): void => append("stderr", chunk)
      const onError = (): void => terminate(new Error("native child spawn failed"))
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (!terminationError) {
          stdout += stdoutDecoder.end()
          stderr += stderrDecoder.end()
        }
        finish(() => {
          if (terminationError) reject(terminationError)
          else if (signal) reject(new Error("native child terminated by a signal"))
          else resolve({ exitCode: code ?? 1, stderr, stdout })
        })
      }
      const cleanup = (): void => {
        clearTimeout(deadlineTimer)
        if (hardSettleTimer) clearTimeout(hardSettleTimer)
        child.stdout.off("data", onStdout)
        child.stderr.off("data", onStderr)
        child.off("error", onError)
        child.off("close", onClose)
        child.stdout.destroy()
        child.stderr.destroy()
      }
      const finish = (operation: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        operation()
      }
      const terminate = (error: Error): void => {
        if (terminationError) return
        terminationError = error
        hardSettleTimer = setTimeout(
          () => finish(() => reject(terminationError as Error)),
          NATIVE_CHILD_HARD_SETTLE_MS,
        )
        hardSettleTimer.unref()
        const directKill = (): void => {
          try {
            child.kill("SIGKILL")
          } catch {
            // The bounded hard-settle below owns completion even if termination APIs fail.
          }
        }
        void Promise.resolve()
          .then(async () => (settled ? true : await killProcessTree(child)))
          .then((killed) => {
            if (!settled && !killed) directKill()
          })
          .catch(() => {
            if (!settled) directKill()
          })
      }
      const append = (stream: "stderr" | "stdout", chunk: Buffer): void => {
        if (settled || terminationError) return
        if (stream === "stdout") {
          stdoutBytes += chunk.byteLength
          stdout += stdoutDecoder.write(chunk)
        } else {
          stderrBytes += chunk.byteLength
          stderr += stderrDecoder.write(chunk)
        }
        if (stdoutBytes + stderrBytes > NATIVE_CHILD_OUTPUT_LIMIT_BYTES) {
          terminate(new Error("native child output exceeded its bounded limit"))
        }
      }
      child.stdout.on("data", onStdout)
      child.stderr.on("data", onStderr)
      child.once("error", onError)
      child.once("close", onClose)
      const deadlineTimer = setTimeout(
        () => terminate(new Error("native child timeout deadline exceeded")),
        request.timeoutMs,
      )
      deadlineTimer.unref()
    })
  }
}

export const runNativeLocalChild = createNativeChildRunner()

async function nativeWithTimeout<T>(
  label: string,
  timeoutMs: number,
  operation: Promise<T>,
): Promise<T> {
  if (
    !/^[A-Za-z][A-Za-z0-9 -]{0,127}$/.test(label) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error("native operation timeout request is malformed")
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`native ${label} timeout deadline exceeded`)),
          timeoutMs,
        )
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type NativeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface NativeDeadlineOwner {
  readonly abort: (reason?: string) => void
  readonly aborted: () => boolean
  readonly clear: () => void
  readonly onAbort: (callback: () => void) => void
  readonly signal: globalThis.AbortSignal
}

export function createNativeDeadlineOwner(timeoutMs: number): NativeDeadlineOwner {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("native fetch timeout must be a positive safe integer")
  }
  const controller = new AbortController()
  let aborted = false
  const abortCallbacks = new Set<() => void>()
  const abort = (reason = "native fetch body cancelled"): void => {
    if (aborted) return
    aborted = true
    controller.abort(new Error(reason))
    for (const callback of abortCallbacks) callback()
    abortCallbacks.clear()
  }
  const timer = setTimeout(() => abort("native fetch deadline exceeded"), timeoutMs)
  timer.unref()
  return {
    abort,
    aborted: () => aborted,
    clear: () => clearTimeout(timer),
    onAbort: (callback: () => void) => {
      if (aborted) callback()
      else abortCallbacks.add(callback)
    },
    signal: controller.signal,
  }
}

export function createNativeFetchAdapters(fetchImplementation: NativeFetch = fetch) {
  const startRequest = async (
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<{
    readonly abort: () => void
    readonly aborted: () => boolean
    readonly clear: () => void
    readonly onAbort: (callback: () => void) => void
    readonly response: Response
  }> => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("native fetch timeout must be a positive safe integer")
    }
    const owner = createNativeDeadlineOwner(timeoutMs)
    try {
      const response = await nativeWithTimeout(
        "fetch",
        timeoutMs,
        fetchImplementation(url, { ...init, redirect: "manual", signal: owner.signal }),
      )
      return {
        abort: owner.abort,
        aborted: owner.aborted,
        clear: owner.clear,
        onAbort: owner.onAbort,
        response,
      }
    } catch {
      owner.abort("native fetch failed")
      owner.clear()
      throw new Error("native fetch failed or exceeded its deadline")
    }
  }
  const wrapResponseBody = (
    response: Response,
    owner: {
      readonly abort: () => void
      readonly clear: () => void
      readonly onAbort: (callback: () => void) => void
    },
  ): Response => {
    if (!response.body) {
      owner.clear()
      return response
    }
    const reader = response.body.getReader()
    let wrappedController: ReadableStreamDefaultController<Uint8Array> | undefined
    const failBody = (): void => {
      void reader.cancel().catch(() => undefined)
      try {
        wrappedController?.error(new Error("native fetch body deadline exceeded"))
      } catch {
        // The wrapped body may already be closed or errored.
      }
    }
    const wrappedBody = new ReadableStream<Uint8Array>({
      start: (controller) => {
        wrappedController = controller
      },
      cancel: async () => {
        owner.abort()
        await reader.cancel().catch(() => undefined)
        owner.clear()
      },
      pull: async (controller) => {
        try {
          const result = await reader.read()
          if (result.done) {
            owner.clear()
            controller.close()
          } else {
            controller.enqueue(result.value)
          }
        } catch (error) {
          owner.abort()
          await reader.cancel().catch(() => undefined)
          owner.clear()
          controller.error(error)
        }
      },
    })
    owner.onAbort(failBody)
    const wrapped = new Response(wrappedBody, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    })
    return new Proxy(wrapped, {
      get(target, property, _receiver) {
        if (property === "redirected" || property === "type" || property === "url") {
          return Reflect.get(response, property, response)
        }
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  }
  return {
    apiTransport: async (apiRequest: NativeVercelApiRequest): Promise<NativeVercelApiResponse> => {
      const url = new URL(apiRequest.url)
      if (url.origin !== "https://api.vercel.com") {
        throw new Error("native Vercel API transport requires the fixed API origin")
      }
      const owner = await startRequest(
        url.href,
        {
          headers: apiRequest.headers,
          method: apiRequest.method,
          redirect: "manual",
        },
        apiRequest.timeoutMs,
      )
      const response = owner.response
      const chunks: Uint8Array[] = []
      let totalBytes = 0
      const reader = response.body?.getReader()
      if (reader) owner.onAbort(() => void reader.cancel().catch(() => undefined))
      try {
        if (reader) {
          while (true) {
            const result = await reader.read()
            if (result.done) break
            totalBytes += result.value.byteLength
            if (totalBytes > 1_048_576) {
              owner.abort()
              await reader.cancel().catch(() => undefined)
              throw new Error("native Vercel API response exceeded its bounded body limit")
            }
            chunks.push(result.value)
          }
        }
      } catch {
        owner.abort()
        await reader?.cancel().catch(() => undefined)
        throw new Error("native Vercel API body read failed or exceeded its deadline")
      } finally {
        owner.clear()
      }
      if (owner.aborted()) {
        throw new Error("native Vercel API body read exceeded its deadline")
      }
      const bytes = new Uint8Array(totalBytes)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      const source = new TextDecoder("utf8", { fatal: true }).decode(bytes)
      let body: unknown = {}
      if (source !== "") {
        try {
          body = JSON.parse(source)
        } catch {
          throw new Error("native Vercel API response body is not valid JSON")
        }
      }
      return { body, status: response.status }
    },
    blackBoxRequest: async (httpRequest: NativeBlackBoxHttpRequest): Promise<Response> => {
      const owner = await startRequest(
        httpRequest.url,
        {
          ...(httpRequest.body !== undefined ? { body: JSON.stringify(httpRequest.body) } : {}),
          headers: httpRequest.headers,
          method: httpRequest.method,
          redirect: "manual",
        },
        httpRequest.timeoutMs,
      )
      return wrapResponseBody(owner.response, owner)
    },
    withTimeout: nativeWithTimeout,
  }
}

export function createNativeBoundedDatabase(pool: {
  readonly query: (sql: string, params: readonly unknown[]) => Promise<{ readonly rows: unknown[] }>
}) {
  if (typeof pool?.query !== "function") {
    throw new Error("native bounded database requires a query function")
  }
  return {
    query: async (request: NativeBlackBoxDatabaseRequest) => {
      if (
        typeof request.sql !== "string" ||
        request.sql.length === 0 ||
        !Array.isArray(request.params)
      ) {
        throw new Error("native bounded database query is malformed")
      }
      const result = await nativeWithTimeout(
        "database query",
        request.timeoutMs,
        Promise.resolve().then(() => pool.query(request.sql, request.params)),
      )
      if (!result || !Array.isArray(result.rows)) {
        throw new Error("native bounded database query result is malformed")
      }
      return result
    },
  }
}

interface NativePostgresPool {
  readonly end: () => Promise<void>
  readonly on: (event: "error", listener: () => void) => unknown
  readonly query: (config: {
    readonly query_timeout: number
    readonly text: string
    readonly values: readonly unknown[]
  }) => Promise<{ readonly rows: unknown[] }>
}

interface NativePostgresPoolConstructor {
  new (options: {
    readonly connectionString: string
    readonly connectionTimeoutMillis: 10_000
    readonly idleTimeoutMillis: 30_000
    readonly max: 2
    readonly query_timeout: 5_000
    readonly statement_timeout: 5_000
  }): NativePostgresPool
}

export async function createNativePostgresDatabase(
  databaseUrl: string,
  loadPool: () => Promise<{ readonly Pool: NativePostgresPoolConstructor }> = async () => {
    const { Pool } = await import("pg")
    return { Pool: Pool as unknown as NativePostgresPoolConstructor }
  },
): Promise<{
  readonly close: () => Promise<void>
  readonly database: ReturnType<typeof createNativeBoundedDatabase>
}> {
  if (!databaseUrl) throw new Error("native Vercel database URL must be nonempty")
  const { Pool } = await loadPool()
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    max: 2,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  })
  pool.on("error", () => undefined)
  return {
    close: () => pool.end(),
    database: {
      query: async (request) => {
        if (
          typeof request.sql !== "string" ||
          request.sql.length === 0 ||
          !Array.isArray(request.params) ||
          !Number.isSafeInteger(request.timeoutMs) ||
          request.timeoutMs <= 0
        ) {
          throw new Error("native bounded database query is malformed")
        }
        let result: { readonly rows: unknown[] }
        try {
          result = await nativeWithTimeout(
            "database query",
            request.timeoutMs,
            Promise.resolve().then(() =>
              pool.query({
                query_timeout: Math.min(5_000, request.timeoutMs),
                text: request.sql,
                values: [...request.params],
              }),
            ),
          )
        } catch {
          throw new Error("native bounded database query failed or exceeded its deadline")
        }
        if (!result || !Array.isArray(result.rows)) {
          throw new Error("native bounded database query result is malformed")
        }
        return { rows: result.rows }
      },
    },
  }
}

export interface AtomicJsonFileOps {
  readonly randomSuffix: () => string
  readonly remove: (path: string) => Promise<void>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly writeFile: (path: string, contents: string) => Promise<void>
}

const DEFAULT_ATOMIC_JSON_FILE_OPS: AtomicJsonFileOps = {
  randomSuffix: () => randomBytes(8).toString("hex"),
  remove: async (path) => rm(path, { force: true }),
  rename,
  writeFile: async (path, contents) =>
    writeFile(path, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }),
}

export async function writeAtomicJson(
  path: string,
  value: unknown,
  fileOps: AtomicJsonFileOps = DEFAULT_ATOMIC_JSON_FILE_OPS,
): Promise<void> {
  assertPlainJsonValue(value)
  const encoded = JSON.stringify(value, null, 2)
  if (encoded === undefined) throw new Error("atomic JSON value is not JSON-serializable")
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${fileOps.randomSuffix()}.tmp`,
  )
  try {
    await fileOps.writeFile(tempPath, `${encoded}\n`)
    await fileOps.rename(tempPath, path)
  } catch (error) {
    await fileOps.remove(tempPath).catch(() => undefined)
    throw error
  }
}

export interface VercelNativeReceiptV1 {
  readonly schemaVersion: 1
  readonly cliVersion: "58.9.0"
  readonly projectBindingVerified: true
  readonly kinds: readonly ["source", "prebuilt"]
  readonly deployments: readonly [
    VercelDeploymentReceiptV1<"source">,
    VercelDeploymentReceiptV1<"prebuilt">,
  ]
}

export interface VercelDeploymentReceiptV1<Kind extends "source" | "prebuilt"> {
  readonly kind: Kind
  readonly deploymentId: string
  readonly canonicalOrigin: string
  readonly apiBindingVerified: true
  readonly config: { readonly fluid: true; readonly sha256: string }
  readonly readyState: "READY"
  readonly routes: {
    readonly unknownRoute404: true
    readonly state: true
    readonly stream: true
    readonly release: true
  }
  readonly state: {
    readonly visits: readonly [1, 2]
    readonly markersInOrder: true
    readonly generatedReadMatched: true
    readonly physicalCheckpoint: true
  }
  readonly middleware: {
    readonly missingHeader401: true
    readonly wrongHeader401: true
    readonly selectiveRelease: true
    readonly sentinelUnreleased: true
  }
  readonly stream: {
    readonly status: 200
    readonly contentType: "text/event-stream"
    readonly noRedirect: true
    readonly beforeFrameIndex: number
    readonly preReleaseQuietMs: 1000
    readonly authorizedReleaseAfterBeforeFrame: true
    readonly afterFrameIndex: number
    readonly doneFrameIndex: number
    readonly eofAfterDone: true
  }
  readonly laterRequest: { readonly succeeded: true; readonly logMarkerSeen: true }
  readonly logs: {
    readonly pollIntervalMs: 2000
    readonly quietIntervalMs: 30000
    readonly queryStartIso: string
    readonly queryEndIso: string
    readonly uniqueRowVersions: number
    readonly exactDeploymentOnly: true
    readonly noTruncation: true
    readonly noErrors: true
  }
  readonly reconciliation: {
    readonly markerPersistedBeforeSpawn: true
    readonly apiBindingVerified: true
    readonly expectedCardinality: true
  }
  readonly cleanup: { readonly deploymentAbsent: true; readonly databaseRowsAbsent: true }
  readonly provenance: Kind extends "source"
    ? {
        readonly cleanSource: true
        readonly prebuiltOutputAbsent: true
        readonly remoteBuildObserved: true
      }
    : {
        readonly localOutputValidated: true
        readonly prebuiltDeployObserved: true
        readonly remoteSourceBuildAbsent: true
      }
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  path: string,
  expected: readonly string[],
): void {
  const expectedSet = new Set(expected)
  const missing = expected.filter((key) => !Object.hasOwn(value, key))
  const additional = Object.keys(value).filter((key) => !expectedSet.has(key))
  if (missing.length > 0 || additional.length > 0) {
    throw new Error(
      `${path} has invalid keys` +
        `${missing.length > 0 ? `; missing ${missing.length}` : ""}` +
        `${additional.length > 0 ? `; additional ${additional.length}` : ""}`,
    )
  }
}

function exactLiteral(value: unknown, expected: unknown, path: string): void {
  if (value !== expected) throw new Error(`${path} must be ${JSON.stringify(expected)}`)
}

function exactTuple(value: unknown, expected: readonly unknown[], path: string): void {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error(`${path} must be an array of length ${expected.length}`)
  }
  for (const [index, item] of expected.entries())
    exactLiteral(value[index], item, `${path}[${index}]`)
}

function nonnegativeIndex(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a finite nonnegative integer`)
  }
  return value as number
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${path} must be a positive integer`)
  }
  return value as number
}

function isoTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be an ISO timestamp`)
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${path} must be a canonical ISO timestamp`)
  }
  return value
}

function validateTrueObject(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  const record = recordAt(value, path)
  exactKeys(record, path, keys)
  for (const key of keys) exactLiteral(record[key], true, `${path}.${key}`)
  return record
}

function validateDeployment(value: unknown, kind: "source" | "prebuilt", path: string): void {
  const deployment = recordAt(value, path)
  exactKeys(deployment, path, [
    "kind",
    "deploymentId",
    "canonicalOrigin",
    "apiBindingVerified",
    "config",
    "readyState",
    "routes",
    "state",
    "middleware",
    "stream",
    "laterRequest",
    "logs",
    "reconciliation",
    "cleanup",
    "provenance",
  ])
  exactLiteral(deployment.kind, kind, `${path}.kind`)
  if (typeof deployment.deploymentId !== "string")
    throw new Error(`${path}.deploymentId must be a string`)
  assertDeploymentId(deployment.deploymentId)
  if (typeof deployment.canonicalOrigin !== "string") {
    throw new Error(`${path}.canonicalOrigin must be a string`)
  }
  if (canonicalizeVercelOrigin(deployment.canonicalOrigin) !== deployment.canonicalOrigin) {
    throw new Error(`${path}.canonicalOrigin must already be canonical`)
  }
  exactLiteral(deployment.apiBindingVerified, true, `${path}.apiBindingVerified`)
  exactLiteral(deployment.readyState, "READY", `${path}.readyState`)

  const config = recordAt(deployment.config, `${path}.config`)
  exactKeys(config, `${path}.config`, ["fluid", "sha256"])
  exactLiteral(config.fluid, true, `${path}.config.fluid`)
  if (typeof config.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(config.sha256)) {
    throw new Error(`${path}.config.sha256 must be 64 lowercase hexadecimal characters`)
  }

  validateTrueObject(deployment.routes, `${path}.routes`, [
    "unknownRoute404",
    "state",
    "stream",
    "release",
  ])
  const state = recordAt(deployment.state, `${path}.state`)
  exactKeys(state, `${path}.state`, [
    "visits",
    "markersInOrder",
    "generatedReadMatched",
    "physicalCheckpoint",
  ])
  exactTuple(state.visits, [1, 2], `${path}.state.visits`)
  for (const key of ["markersInOrder", "generatedReadMatched", "physicalCheckpoint"] as const) {
    exactLiteral(state[key], true, `${path}.state.${key}`)
  }
  validateTrueObject(deployment.middleware, `${path}.middleware`, [
    "missingHeader401",
    "wrongHeader401",
    "selectiveRelease",
    "sentinelUnreleased",
  ])

  const stream = recordAt(deployment.stream, `${path}.stream`)
  exactKeys(stream, `${path}.stream`, [
    "status",
    "contentType",
    "noRedirect",
    "beforeFrameIndex",
    "preReleaseQuietMs",
    "authorizedReleaseAfterBeforeFrame",
    "afterFrameIndex",
    "doneFrameIndex",
    "eofAfterDone",
  ])
  exactLiteral(stream.status, 200, `${path}.stream.status`)
  exactLiteral(stream.contentType, "text/event-stream", `${path}.stream.contentType`)
  exactLiteral(stream.noRedirect, true, `${path}.stream.noRedirect`)
  exactLiteral(stream.preReleaseQuietMs, 1000, `${path}.stream.preReleaseQuietMs`)
  exactLiteral(
    stream.authorizedReleaseAfterBeforeFrame,
    true,
    `${path}.stream.authorizedReleaseAfterBeforeFrame`,
  )
  exactLiteral(stream.eofAfterDone, true, `${path}.stream.eofAfterDone`)
  const before = nonnegativeIndex(stream.beforeFrameIndex, `${path}.stream.beforeFrameIndex`)
  const after = nonnegativeIndex(stream.afterFrameIndex, `${path}.stream.afterFrameIndex`)
  const done = nonnegativeIndex(stream.doneFrameIndex, `${path}.stream.doneFrameIndex`)
  if (!(before < after && after < done)) {
    throw new Error(`${path}.stream frame indexes must satisfy before < after < done`)
  }

  validateTrueObject(deployment.laterRequest, `${path}.laterRequest`, [
    "succeeded",
    "logMarkerSeen",
  ])
  const logs = recordAt(deployment.logs, `${path}.logs`)
  exactKeys(logs, `${path}.logs`, [
    "pollIntervalMs",
    "quietIntervalMs",
    "queryStartIso",
    "queryEndIso",
    "uniqueRowVersions",
    "exactDeploymentOnly",
    "noTruncation",
    "noErrors",
  ])
  exactLiteral(logs.pollIntervalMs, 2000, `${path}.logs.pollIntervalMs`)
  exactLiteral(logs.quietIntervalMs, 30000, `${path}.logs.quietIntervalMs`)
  const start = isoTimestamp(logs.queryStartIso, `${path}.logs.queryStartIso`)
  const end = isoTimestamp(logs.queryEndIso, `${path}.logs.queryEndIso`)
  if (Date.parse(start) > Date.parse(end)) throw new Error(`${path}.logs ISO bounds are reversed`)
  positiveInteger(logs.uniqueRowVersions, `${path}.logs.uniqueRowVersions`)
  for (const key of ["exactDeploymentOnly", "noTruncation", "noErrors"] as const) {
    exactLiteral(logs[key], true, `${path}.logs.${key}`)
  }
  validateTrueObject(deployment.reconciliation, `${path}.reconciliation`, [
    "markerPersistedBeforeSpawn",
    "apiBindingVerified",
    "expectedCardinality",
  ])
  validateTrueObject(deployment.cleanup, `${path}.cleanup`, [
    "deploymentAbsent",
    "databaseRowsAbsent",
  ])

  const provenance = recordAt(deployment.provenance, `${path}.provenance`)
  const provenanceKeys =
    kind === "source"
      ? (["cleanSource", "prebuiltOutputAbsent", "remoteBuildObserved"] as const)
      : (["localOutputValidated", "prebuiltDeployObserved", "remoteSourceBuildAbsent"] as const)
  exactKeys(provenance, `${path}.provenance`, provenanceKeys)
  for (const key of provenanceKeys) exactLiteral(provenance[key], true, `${path}.provenance.${key}`)
}

export function parseNativeReceipt(value: unknown): VercelNativeReceiptV1 {
  const projectedValue = cloneOwnJsonData(value, "receipt")
  const receipt = recordAt(projectedValue, "receipt")
  exactKeys(receipt, "receipt", [
    "schemaVersion",
    "cliVersion",
    "projectBindingVerified",
    "kinds",
    "deployments",
  ])
  exactLiteral(receipt.schemaVersion, 1, "receipt.schemaVersion")
  exactLiteral(receipt.cliVersion, "58.9.0", "receipt.cliVersion")
  exactLiteral(receipt.projectBindingVerified, true, "receipt.projectBindingVerified")
  exactTuple(receipt.kinds, ["source", "prebuilt"], "receipt.kinds")
  if (!Array.isArray(receipt.deployments) || receipt.deployments.length !== 2) {
    throw new Error("receipt.deployments must be a two-item tuple")
  }
  validateDeployment(receipt.deployments[0], "source", "receipt.deployments[0]")
  validateDeployment(receipt.deployments[1], "prebuilt", "receipt.deployments[1]")
  const source = recordAt(receipt.deployments[0], "receipt.deployments[0]")
  const prebuilt = recordAt(receipt.deployments[1], "receipt.deployments[1]")
  if (source.deploymentId === prebuilt.deploymentId) {
    throw new Error("source and prebuilt receipt deploymentId values must differ")
  }
  if (source.canonicalOrigin === prebuilt.canonicalOrigin) {
    throw new Error("source and prebuilt receipt canonicalOrigin values must differ")
  }
  assertPlainJsonValue(projectedValue, "receipt")
  return projectedValue as VercelNativeReceiptV1
}

export async function writeFinalReceipt(
  path: string,
  value: unknown,
  protectedValues: readonly string[],
): Promise<void> {
  const receipt = parseNativeReceipt(value)
  createSecretRedactor(protectedValues).assertSafe("final Vercel receipt", receipt)
  await writeAtomicJson(path, receipt)
}

export interface NativeVercelChildRequest {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly executable: string
  readonly timeoutMs: number
}

export type NativeVercelChildRunner = (
  request: NativeVercelChildRequest,
) => Promise<NativeLocalCommandResult>

export interface NativePinnedVercelBoundaryOptions {
  readonly cliPackageRoot: string
  readonly databaseUrl: string
  readonly fixtureRoots: readonly [string, string]
  readonly globalConfigDir: string
  readonly jobRoot: string
  readonly orgId: string
  readonly parentEnv: NodeJS.ProcessEnv
  readonly projectId: string
  readonly releaseCredential: string
  readonly runChild: NativeVercelChildRunner
  readonly token: string
}

export interface NativePinnedVercelBoundary {
  readonly assertVersion: () => Promise<void>
  readonly deploy: (options: {
    readonly fixtureRoot: string
    readonly kind: "source" | "prebuilt"
    readonly localConfigPath: string
    readonly marker: string
  }) => Promise<{
    readonly canonicalOrigin: string
    readonly commandEvidence: NativeDeployCommandEvidence
    readonly deploymentId: string
  }>
  readonly inspectBuildLogs: (options: { readonly deploymentId: string }) => Promise<{
    readonly evidence: NativeVercelBuildLogEvidence
    readonly redactedTranscript: string
  }>
  readonly inspect: (options: {
    readonly canonicalOrigin: string
    readonly deploymentId: string
  }) => Promise<{ readonly readyState: "READY" }>
  readonly logs: (options: {
    readonly deploymentId: string
    readonly queryEndIso: string
    readonly queryStartIso: string
  }) => Promise<string>
}

export interface NativeDeployCommandEvidence {
  readonly command: "deploy"
  readonly positionalPathAbsent: true
  readonly prebuiltFlagCount: 0 | 1
}

const NATIVE_VERCEL_CHILD_TIMEOUT_MS = 120_000
const NATIVE_VERCEL_API_TIMEOUT_MS = 30_000

function pathIsInsideOrEqual(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
}

async function assertOwnerOnlyDirectoryChain(
  jobRoot: string,
  target: string,
  forbiddenRoots: readonly string[],
): Promise<void> {
  if (!isAbsolute(jobRoot) || !isAbsolute(target)) {
    throw new Error("native Vercel global config paths must be absolute")
  }
  const canonicalJobRoot = await realpath(jobRoot)
  if (canonicalJobRoot !== jobRoot) {
    throw new Error("native Vercel job root must be canonical and non-symlinked")
  }
  const lexicalRelative = relative(jobRoot, target)
  if (
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative)
  ) {
    throw new Error("native Vercel global config directory must be inside the job root")
  }

  const segments = lexicalRelative === "" ? [] : lexicalRelative.split(sep)
  let current = jobRoot
  for (const segment of ["", ...segments]) {
    if (segment) current = join(current, segment)
    const stats = await lstat(current).catch(() => {
      throw new Error("native Vercel global config directory must already exist")
    })
    if (stats.isSymbolicLink() || !stats.isDirectory() || (stats.mode & 0o077) !== 0) {
      throw new Error(
        "native Vercel global config path chain must be owner-only regular directories",
      )
    }
  }
  const canonicalTarget = await realpath(target)
  if (canonicalTarget !== target) {
    throw new Error("native Vercel global config path chain must not contain symlinks")
  }
  for (const forbiddenRoot of forbiddenRoots) {
    const canonicalForbidden = await realpath(forbiddenRoot)
    if (pathIsInsideOrEqual(canonicalForbidden, canonicalTarget)) {
      throw new Error("native Vercel global config directory must be outside both fixtures")
    }
  }

  if ((await readdir(canonicalTarget)).length !== 0) {
    throw new Error("native Vercel global config directory must start empty")
  }
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

function protectedChildError(
  result: NativeLocalCommandResult,
  label: string,
  redactor: SecretRedactor,
): Error {
  const output = redactor.redact(result.stderr || result.stdout)
  return new Error(`${label} failed with exit ${result.exitCode}${output ? `: ${output}` : ""}`)
}

function assertPinnedLogProgress(
  stderr: string,
  deploymentId: string,
  projectId: string,
  redactor: SecretRedactor,
): void {
  const normalized = stripVTControlCharacters(stderr).replace(/\r\n?/g, "\n")
  const lines = normalized.split("\n")
  while (lines.at(-1) === "") lines.pop()
  if (
    lines.some(
      (line) =>
        line === "" ||
        [...line].some((character) => {
          const codePoint = character.codePointAt(0)
          return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
        }),
    ) ||
    JSON.stringify(lines) !==
      JSON.stringify([
        `Resolving deployment "${deploymentId}"`,
        `Fetching project "${projectId}"`,
        `Fetching project "${projectId}"`,
        "Fetching logs...",
      ])
  ) {
    throw new Error("native Vercel deployment logs emitted unexpected progress stderr")
  }
  const sanitized = redactor.redact(normalized)
  redactor.assertSafe("sanitized native Vercel deployment logs progress", sanitized)
}

export async function createNativePinnedVercelBoundary(
  options: NativePinnedVercelBoundaryOptions,
): Promise<NativePinnedVercelBoundary> {
  if (process.versions.node.split(".", 1)[0] !== "24") {
    throw new Error(
      `native Vercel CLI boundary requires Node 24, received ${process.versions.node}`,
    )
  }
  if (!isAbsolute(options.cliPackageRoot)) {
    throw new Error("native Vercel CLI package root must be absolute")
  }
  await assertOwnerOnlyDirectoryChain(
    options.jobRoot,
    options.globalConfigDir,
    options.fixtureRoots,
  )
  const cliPath = join(options.cliPackageRoot, "node_modules", ".bin", "vercel")
  const cliStats = await lstat(cliPath)
  if (!cliStats.isFile() || cliStats.isSymbolicLink()) {
    throw new Error("native Vercel CLI must be the absolute package-local executable")
  }
  const redactor = createSecretRedactor([
    options.token,
    options.orgId,
    options.projectId,
    options.databaseUrl,
    options.releaseCredential,
  ])
  const inherited = sanitizeChildEnvironment(options.parentEnv, {})
  const runtimeDir = dirname(process.execPath)
  const baseEnv = stringEnvironment({
    ...inherited,
    PATH: inherited.PATH ? `${runtimeDir}${delimiter}${inherited.PATH}` : runtimeDir,
    NO_UPDATE_NOTIFIER: "1",
    VERCEL_TELEMETRY_DISABLED: "1",
  })
  let versionVerified = false

  const run = async (
    label: string,
    request: Omit<NativeVercelChildRequest, "executable" | "timeoutMs">,
    validateSuccessStderr?: (stderr: string) => void,
  ): Promise<NativeLocalCommandResult> => {
    let result: NativeLocalCommandResult
    try {
      result = await options.runChild({
        ...request,
        executable: cliPath,
        timeoutMs: NATIVE_VERCEL_CHILD_TIMEOUT_MS,
      })
    } catch {
      throw new Error(`${label} child transport failed`)
    }
    if (result.exitCode !== 0) throw protectedChildError(result, label, redactor)
    if (validateSuccessStderr) validateSuccessStderr(result.stderr)
    else redactor.assertSafe(`${label} stderr`, result.stderr)
    return result
  }
  const credentialEnv = (includeDatabase: boolean): Record<string, string> =>
    stringEnvironment({
      ...baseEnv,
      ...(includeDatabase ? { DATABASE_URL: options.databaseUrl } : {}),
      VERCEL_ORG_ID: options.orgId,
      VERCEL_PROJECT_ID: options.projectId,
      VERCEL_TOKEN: options.token,
    })

  return {
    assertVersion: async () => {
      const result = await run("native Vercel version check", {
        args: ["--version", "--global-config", options.globalConfigDir],
        cwd: options.jobRoot,
        env: baseEnv,
      })
      const expectedStderr = `Vercel CLI 58.9.0 (Node.js ${process.versions.node})\n`
      if (result.stderr !== expectedStderr || result.stdout !== "58.9.0\n") {
        throw new Error('native Vercel CLI version must be exactly "58.9.0"')
      }
      versionVerified = true
    },
    deploy: async ({ fixtureRoot, kind, localConfigPath, marker }) => {
      if (!versionVerified)
        throw new Error("native Vercel CLI version must be verified before deploy")
      if (kind !== "source" && kind !== "prebuilt") {
        throw new Error("native Vercel deploy kind must be source or prebuilt")
      }
      if (!options.fixtureRoots.includes(fixtureRoot)) {
        throw new Error("native Vercel deploy cwd must be one of the isolated fixture roots")
      }
      if (!isAbsolute(localConfigPath) || localConfigPath !== join(fixtureRoot, "vercel.json")) {
        throw new Error("native Vercel local config must be the absolute fixture vercel.json")
      }
      const configStats = await lstat(localConfigPath)
      if (configStats.isSymbolicLink() || !configStats.isFile()) {
        throw new Error("native Vercel local config must be a regular non-symlink file")
      }
      assertReconciliationMarker(marker)
      const args = [
        "deploy",
        ...(kind === "prebuilt" ? ["--prebuilt"] : []),
        "--target",
        "preview",
        "--meta",
        `dawnVercelRun=${marker}`,
        "--scope",
        options.orgId,
        "--non-interactive",
        "--yes",
        "--no-wait",
        "--json",
        "--global-config",
        options.globalConfigDir,
        "--local-config",
        localConfigPath,
        "--env",
        "DATABASE_URL",
      ]
      const result = await run(`native Vercel ${kind} deploy`, {
        args,
        cwd: fixtureRoot,
        env: credentialEnv(true),
      })
      return {
        ...parseNativeVercelDeploymentReceipt(result.stdout),
        commandEvidence: {
          command: "deploy",
          positionalPathAbsent: true,
          prebuiltFlagCount: kind === "prebuilt" ? 1 : 0,
        },
      }
    },
    inspect: async ({ canonicalOrigin, deploymentId }) => {
      if (!versionVerified) {
        throw new Error("native Vercel CLI version must be verified before inspect")
      }
      assertDeploymentId(deploymentId)
      const expectedOrigin = canonicalizeVercelOrigin(canonicalOrigin)
      const result = await run("native Vercel deployment inspect", {
        args: [
          "inspect",
          deploymentId,
          "--scope",
          options.orgId,
          "--wait",
          "--json",
          "--non-interactive",
          "--global-config",
          options.globalConfigDir,
        ],
        cwd: options.jobRoot,
        env: credentialEnv(false),
      })
      return parseNativeVercelInspectReceipt(result.stdout, {
        canonicalOrigin: expectedOrigin,
        deploymentId,
      })
    },
    inspectBuildLogs: async ({ deploymentId }) => {
      if (!versionVerified) {
        throw new Error("native Vercel CLI version must be verified before inspect build logs")
      }
      assertDeploymentId(deploymentId)
      const result = await run("native Vercel deployment build logs", {
        args: [
          "inspect",
          deploymentId,
          "--logs",
          "--scope",
          options.orgId,
          "--non-interactive",
          "--global-config",
          options.globalConfigDir,
        ],
        cwd: options.jobRoot,
        env: credentialEnv(false),
      })
      const evidence = parseNativeVercelBuildLogTranscript({
        deploymentId,
        stderr: result.stderr,
        stdout: result.stdout,
      })
      const redactedTranscript = redactor.redact(result.stderr)
      redactor.assertSafe("redacted native Vercel deployment build logs", redactedTranscript)
      return { evidence, redactedTranscript }
    },
    logs: async ({ deploymentId, queryEndIso, queryStartIso }) => {
      if (!versionVerified) {
        throw new Error("native Vercel CLI version must be verified before logs")
      }
      assertDeploymentId(deploymentId)
      const queryStartMs = Date.parse(queryStartIso)
      const queryEndMs = Date.parse(queryEndIso)
      if (
        !Number.isFinite(queryStartMs) ||
        !Number.isFinite(queryEndMs) ||
        new Date(queryStartMs).toISOString() !== queryStartIso ||
        new Date(queryEndMs).toISOString() !== queryEndIso ||
        queryStartMs > queryEndMs
      ) {
        throw new Error("native Vercel log bounds must be ordered canonical ISO timestamps")
      }
      const result = await run(
        "native Vercel deployment logs",
        {
          args: [
            "logs",
            "--project",
            options.projectId,
            "--deployment",
            deploymentId,
            "--json",
            "--since",
            queryStartIso,
            "--until",
            queryEndIso,
            "--limit",
            "1000",
            "--scope",
            options.orgId,
            "--non-interactive",
            "--global-config",
            options.globalConfigDir,
          ],
          cwd: options.jobRoot,
          env: credentialEnv(false),
        },
        (stderr) => assertPinnedLogProgress(stderr, deploymentId, options.projectId, redactor),
      )
      return result.stdout
    },
  }
}

function own(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key)
}

function assertNoOtherDeploymentCandidates(value: unknown, accepted: object): void {
  if (!value || typeof value !== "object") return
  if (value !== accepted && (own(value, "id") || own(value, "url"))) {
    throw new Error("native Vercel deploy stdout contains an unknown or conflicting candidate")
  }
  for (const entry of Object.values(value)) {
    assertNoOtherDeploymentCandidates(entry, accepted)
  }
}

export function parseNativeVercelDeploymentReceipt(stdout: string): {
  readonly canonicalOrigin: string
  readonly deploymentId: string
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    throw new Error("native Vercel deploy stdout must be exactly one JSON document")
  }
  const root = recordAt(parsed, "native Vercel deploy stdout")
  let candidate: Record<string, unknown>
  if (own(root, "id") || own(root, "url")) {
    if (!own(root, "id") || !own(root, "url") || own(root, "deployment")) {
      throw new Error("native Vercel deploy stdout has conflicting top-level candidates")
    }
    candidate = root
  } else {
    if (root.status !== "ok" || !own(root, "deployment")) {
      throw new Error("native Vercel deploy stdout does not match a pinned receipt shape")
    }
    candidate = recordAt(root.deployment, "native Vercel deploy stdout deployment")
    if (!own(candidate, "id") || !own(candidate, "url")) {
      throw new Error("native Vercel nested deployment must own id and url")
    }
  }
  if (typeof candidate.id !== "string" || typeof candidate.url !== "string") {
    throw new Error("native Vercel deployment id and url must be strings")
  }
  assertNoOtherDeploymentCandidates(root, candidate)
  return {
    canonicalOrigin: canonicalizeVercelOrigin(candidate.url),
    deploymentId: assertDeploymentId(candidate.id),
  }
}

export interface NativeAttemptCoordinates {
  readonly githubJob: string
  readonly githubRepositoryId: string
  readonly githubRunAttempt: string
  readonly githubRunId: string
  readonly kind: "source" | "prebuilt"
  readonly logicalAttemptIndex: string
}

export interface NativeAttemptEvidence {
  readonly attemptLowerBoundMs: number
  readonly attemptStartMs: number
  readonly kind: "source" | "prebuilt"
  readonly marker: string
  readonly preimage: readonly [string, string, string, string, string, string, string]
  readonly spawnStarted: true
}

export function deriveNativeAttemptEvidence(
  coordinates: NativeAttemptCoordinates,
  attemptStartMs: number,
): NativeAttemptEvidence {
  const coordinateValues = [
    coordinates.githubRepositoryId,
    coordinates.githubRunId,
    coordinates.githubRunAttempt,
    coordinates.githubJob,
  ]
  if (coordinateValues.some((value) => value.length === 0 || value !== value.trim())) {
    throw new Error("native Vercel marker coordinates must be nonempty canonical strings")
  }
  if (coordinates.kind !== "source" && coordinates.kind !== "prebuilt") {
    throw new Error("native Vercel marker kind must be source or prebuilt")
  }
  if (
    !/^(?:0|[1-9][0-9]*)$/.test(coordinates.logicalAttemptIndex) ||
    !Number.isSafeInteger(Number(coordinates.logicalAttemptIndex))
  ) {
    throw new Error("native Vercel logical attempt index must be a canonical safe integer")
  }
  if (
    !Number.isSafeInteger(attemptStartMs) ||
    attemptStartMs < 300_000 ||
    !Number.isSafeInteger(attemptStartMs + 300_000)
  ) {
    throw new Error("native Vercel attempt start must be a bounded safe-integer timestamp")
  }
  const preimage = [
    "dawn-vercel-marker-v1",
    coordinates.githubRepositoryId,
    coordinates.githubRunId,
    coordinates.githubRunAttempt,
    coordinates.githubJob,
    coordinates.kind,
    coordinates.logicalAttemptIndex,
  ] as const
  const marker = `vclrun_${createHash("sha256")
    .update(JSON.stringify(preimage), "utf8")
    .digest("hex")
    .slice(0, 32)}`
  assertReconciliationMarker(marker)
  return {
    attemptLowerBoundMs: attemptStartMs - 300_000,
    attemptStartMs,
    kind: coordinates.kind,
    marker,
    preimage,
    spawnStarted: true,
  }
}

export async function runNativeDeployAttempt(options: {
  readonly apiClient: NativeVercelApiClient
  readonly attemptStartMs: number
  readonly boundary: Pick<NativePinnedVercelBoundary, "assertVersion" | "deploy" | "inspect">
  readonly coordinates: NativeAttemptCoordinates
  readonly fixtureRoot: string
  readonly localConfigPath: string
  readonly orgId: string
  readonly persistAttempt: (evidence: NativeAttemptEvidence) => Promise<void>
  readonly persistProjectBindingVerified?: () => Promise<void>
  readonly persistStage?: (
    stage: "config" | "deploy" | "readiness",
    evidence: unknown,
  ) => Promise<void>
  readonly persistDeploymentBinding: (evidence: NativeDeploymentBindingEvidence) => Promise<void>
  readonly persistDeploymentReceipt: (evidence: {
    readonly canonicalOrigin: string
    readonly deploymentId: string
  }) => Promise<void>
  readonly projectId: string
  readonly readConfigEvidence?: (path: string) => Promise<NativeVercelConfigEvidence>
}): Promise<{
  readonly attempt: NativeAttemptEvidence
  readonly binding: NativeDeploymentBindingEvidence
  readonly canonicalOrigin: string
  readonly commandEvidence: NativeDeployCommandEvidence
  readonly config: NativeVercelConfigEvidence
  readonly deploymentId: string
  readonly readyState: "READY"
}> {
  if (!/^team_[A-Za-z0-9]+$/.test(options.orgId) || !/^prj_[A-Za-z0-9]+$/.test(options.projectId)) {
    throw new Error(
      "native Vercel deployment scope must use canonical organization and project IDs",
    )
  }
  const attempt = deriveNativeAttemptEvidence(options.coordinates, options.attemptStartMs)
  await options.boundary.assertVersion()
  const projectResponse = await options.apiClient.request(
    "GET",
    `/v9/projects/${encodeURIComponent(options.projectId)}?teamId=${encodeURIComponent(options.orgId)}`,
  )
  if (projectResponse.status !== 200) {
    throw new Error(`native Vercel project preflight failed with status ${projectResponse.status}`)
  }
  parseNativeVercelProjectBinding(projectResponse.body, {
    orgId: options.orgId,
    projectId: options.projectId,
  })
  if (options.persistProjectBindingVerified) {
    await options.persistProjectBindingVerified()
  }
  const config = await (options.readConfigEvidence ?? readNativeVercelConfigEvidence)(
    options.localConfigPath,
  )
  await options.persistStage?.("config", config)
  await options.persistAttempt(attempt)
  const deployed = await options.boundary.deploy({
    fixtureRoot: options.fixtureRoot,
    kind: options.coordinates.kind,
    localConfigPath: options.localConfigPath,
    marker: attempt.marker,
  })
  const { commandEvidence, ...deployment } = deployed
  await options.persistDeploymentReceipt(deployment)
  await options.persistStage?.("deploy", { ...deployment, commandEvidence })
  const bindingResponse = await options.apiClient.request(
    "GET",
    `/v13/deployments/${encodeURIComponent(deployment.deploymentId)}?teamId=${encodeURIComponent(options.orgId)}`,
  )
  if (bindingResponse.status !== 200) {
    throw new Error(
      `native Vercel authoritative deployment read failed with status ${bindingResponse.status}`,
    )
  }
  const binding = parseNativeVercelDeploymentBinding(bindingResponse.body, {
    attemptLowerBoundMs: attempt.attemptLowerBoundMs,
    attemptUpperBoundMs: options.attemptStartMs + 300_000,
    canonicalOrigin: deployment.canonicalOrigin,
    deploymentId: deployment.deploymentId,
    marker: attempt.marker,
    orgId: options.orgId,
    projectId: options.projectId,
  })
  await options.persistDeploymentBinding(binding)
  const ready = await options.boundary.inspect(deployment)
  await options.persistStage?.("readiness", ready)
  return { attempt, binding, commandEvidence, config, ...deployment, ...ready }
}

export function parseNativeVercelProjectBinding(
  value: unknown,
  expected: { readonly orgId: string; readonly projectId: string },
): { readonly projectBindingVerified: true; readonly rootDirectory: null } {
  if (
    !/^team_[A-Za-z0-9]+$/.test(expected.orgId) ||
    !/^prj_[A-Za-z0-9]+$/.test(expected.projectId)
  ) {
    throw new Error("native Vercel project binding expectation is malformed")
  }
  const project = recordAt(
    cloneOwnJsonData(value, "native Vercel project"),
    "native Vercel project",
  )
  if (
    !own(project, "id") ||
    !own(project, "accountId") ||
    project.id !== expected.projectId ||
    project.accountId !== expected.orgId
  ) {
    throw new Error("native Vercel project response does not match the expected project and owner")
  }
  if (own(project, "rootDirectory") && project.rootDirectory !== null) {
    throw new Error("native Vercel project rootDirectory must be absent or null")
  }
  return { projectBindingVerified: true, rootDirectory: null }
}

export interface NativeVercelConfigEvidence {
  readonly fluid: true
  readonly sha256: string
}

export async function readNativeVercelConfigEvidence(
  path: string,
): Promise<NativeVercelConfigEvidence> {
  if (!isAbsolute(path)) throw new Error("native Vercel config path must be absolute")
  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("native Vercel config must be a regular non-symlink file")
  }
  const source = await readFile(path, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error("native Vercel config must contain valid JSON")
  }
  const config = recordAt(parsed, "native Vercel config")
  exactKeys(config, "native Vercel config", ["$schema", "buildCommand", "fluid"])
  exactLiteral(config.$schema, RECOMMENDED_VERCEL_CONFIG.$schema, "native Vercel config.$schema")
  exactLiteral(
    config.buildCommand,
    RECOMMENDED_VERCEL_CONFIG.buildCommand,
    "native Vercel config.buildCommand",
  )
  exactLiteral(config.fluid, true, "native Vercel config.fluid")
  return {
    fluid: true,
    sha256: createHash("sha256").update(source, "utf8").digest("hex"),
  }
}

export interface NativeDeploymentBindingExpectation {
  readonly attemptLowerBoundMs: number
  readonly attemptUpperBoundMs: number
  readonly canonicalOrigin: string
  readonly deploymentId: string
  readonly marker: string
  readonly orgId: string
  readonly projectId: string
}

export interface NativeDeploymentBindingEvidence {
  readonly canonicalOrigin: string
  readonly createdAt: number
  readonly deploymentId: string
  readonly marker: string
  readonly ownerIdMatched: true
  readonly projectIdMatched: true
  readonly target: "preview"
}

export function parseNativeVercelDeploymentBinding(
  value: unknown,
  expected: NativeDeploymentBindingExpectation,
): NativeDeploymentBindingEvidence {
  assertDeploymentId(expected.deploymentId)
  const expectedOrigin = canonicalizeVercelOrigin(expected.canonicalOrigin)
  assertReconciliationMarker(expected.marker)
  if (
    !/^team_[A-Za-z0-9]+$/.test(expected.orgId) ||
    !/^prj_[A-Za-z0-9]+$/.test(expected.projectId) ||
    !Number.isSafeInteger(expected.attemptLowerBoundMs) ||
    !Number.isSafeInteger(expected.attemptUpperBoundMs) ||
    expected.attemptLowerBoundMs > expected.attemptUpperBoundMs
  ) {
    throw new Error("native Vercel deployment binding expectation is malformed")
  }
  const deployment = recordAt(
    cloneOwnJsonData(value, "native Vercel deployment"),
    "native Vercel deployment",
  )
  const expectedHostname = new URL(expectedOrigin).hostname
  if (
    deployment.id !== expected.deploymentId ||
    deployment.url !== expectedHostname ||
    deployment.projectId !== expected.projectId ||
    deployment.ownerId !== expected.orgId ||
    (deployment.target !== null && deployment.target !== "preview") ||
    !Number.isSafeInteger(deployment.createdAt) ||
    (deployment.createdAt as number) < expected.attemptLowerBoundMs ||
    (deployment.createdAt as number) > expected.attemptUpperBoundMs
  ) {
    throw new Error("native Vercel deployment response does not match its authoritative binding")
  }
  const meta = recordAt(deployment.meta, "native Vercel deployment meta")
  if (meta.dawnVercelRun !== expected.marker) {
    throw new Error("native Vercel deployment marker does not match its attempt")
  }
  return {
    canonicalOrigin: expectedOrigin,
    createdAt: deployment.createdAt as number,
    deploymentId: expected.deploymentId,
    marker: expected.marker,
    ownerIdMatched: true,
    projectIdMatched: true,
    target: "preview",
  }
}

export function parseNativeVercelInspectReceipt(
  stdout: string,
  expected: { readonly canonicalOrigin: string; readonly deploymentId: string },
): { readonly readyState: "READY" } {
  assertDeploymentId(expected.deploymentId)
  const expectedOrigin = canonicalizeVercelOrigin(expected.canonicalOrigin)
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    throw new Error("native Vercel inspect stdout must be exactly one JSON document")
  }
  const receipt = recordAt(parsed, "native Vercel inspect receipt")
  if (
    receipt.id !== expected.deploymentId ||
    typeof receipt.url !== "string" ||
    canonicalizeVercelOrigin(receipt.url) !== expectedOrigin ||
    receipt.readyState !== "READY"
  ) {
    throw new Error("native Vercel inspect receipt does not match the ready deployment")
  }
  for (const field of [
    "error",
    "buildError",
    "bootError",
    "protection",
    "passwordProtection",
    "ssoProtection",
  ]) {
    if (receipt[field]) throw new Error(`native Vercel inspect reported ${field}`)
  }
  return { readyState: "READY" }
}

export interface NativeVercelApiRequest {
  readonly headers: Readonly<Record<string, string>>
  readonly method: "DELETE" | "GET"
  readonly redirect: "manual"
  readonly timeoutMs: number
  readonly url: string
}

export interface NativeVercelApiResponse {
  readonly body: unknown
  readonly status: number
}

export type NativeVercelApiTransport = (
  request: NativeVercelApiRequest,
) => Promise<NativeVercelApiResponse>

export interface NativeVercelApiClient {
  readonly request: (method: "DELETE" | "GET", path: string) => Promise<NativeVercelApiResponse>
}

export interface NativeClock {
  readonly now: () => number
  readonly sleep: (milliseconds: number) => Promise<void>
}

export interface NativeMarkerReconciliationEvidence {
  readonly deployments: readonly NativeDeploymentBindingEvidence[]
  readonly expectedCardinality: boolean
  readonly pollIntervalMs: 2000
  readonly quietIntervalMs: 30000
}

export interface NativeDeploymentCleanupRecord {
  readonly binding?: NativeDeploymentBindingEvidence
  readonly deleteReceipt?: {
    readonly state: "DELETED"
    readonly uid: string
  }
  readonly deploymentId: string
}

const NATIVE_RECONCILIATION_POLL_INTERVAL_MS = 2_000
const NATIVE_RECONCILIATION_QUIET_INTERVAL_MS = 30_000
const NATIVE_RECONCILIATION_DEADLINE_MS = 180_000
const NATIVE_DEPLOYMENT_ABSENCE_DEADLINE_MS = 60_000
const NATIVE_RECONCILIATION_PAGE_LIMIT = 100

function assertNativeVercelScope(orgId: string, projectId: string): void {
  if (!/^team_[A-Za-z0-9]+$/.test(orgId) || !/^prj_[A-Za-z0-9]+$/.test(projectId)) {
    throw new Error("native Vercel scope must use canonical organization and project IDs")
  }
}

function validateNativeAttemptEvidence(value: NativeAttemptEvidence): NativeAttemptEvidence {
  const attempt = recordAt(
    cloneOwnJsonData(value, "native Vercel attempt evidence"),
    "native Vercel attempt evidence",
  )
  exactKeys(attempt, "native Vercel attempt evidence", [
    "attemptLowerBoundMs",
    "attemptStartMs",
    "kind",
    "marker",
    "preimage",
    "spawnStarted",
  ])
  if (
    !Array.isArray(attempt.preimage) ||
    attempt.preimage.length !== 7 ||
    attempt.preimage.some((entry) => typeof entry !== "string") ||
    (attempt.kind !== "source" && attempt.kind !== "prebuilt") ||
    !Number.isSafeInteger(attempt.attemptStartMs)
  ) {
    throw new Error("native Vercel persisted attempt evidence is malformed")
  }
  const preimage = attempt.preimage as string[]
  const derived = deriveNativeAttemptEvidence(
    {
      githubRepositoryId: preimage[1] as string,
      githubRunId: preimage[2] as string,
      githubRunAttempt: preimage[3] as string,
      githubJob: preimage[4] as string,
      kind: attempt.kind,
      logicalAttemptIndex: preimage[6] as string,
    },
    attempt.attemptStartMs as number,
  )
  exactTuple(preimage, derived.preimage, "native Vercel attempt evidence preimage")
  if (
    attempt.marker !== derived.marker ||
    attempt.attemptLowerBoundMs !== derived.attemptLowerBoundMs ||
    attempt.spawnStarted !== true
  ) {
    throw new Error("native Vercel persisted attempt evidence does not match its derivation")
  }
  return derived
}

function validateNativeBindingEvidence(
  value: NativeDeploymentBindingEvidence,
  expectedDeploymentId?: string,
): NativeDeploymentBindingEvidence {
  const binding = recordAt(
    cloneOwnJsonData(value, "native Vercel deployment binding evidence"),
    "native Vercel deployment binding evidence",
  )
  exactKeys(binding, "native Vercel deployment binding evidence", [
    "canonicalOrigin",
    "createdAt",
    "deploymentId",
    "marker",
    "ownerIdMatched",
    "projectIdMatched",
    "target",
  ])
  if (typeof binding.deploymentId !== "string") {
    throw new Error("native Vercel deployment binding ID must be a string")
  }
  const deploymentId = assertDeploymentId(binding.deploymentId)
  if (expectedDeploymentId !== undefined && deploymentId !== expectedDeploymentId) {
    throw new Error("native Vercel cleanup record and binding deployment IDs mismatch")
  }
  if (
    typeof binding.canonicalOrigin !== "string" ||
    typeof binding.marker !== "string" ||
    !Number.isSafeInteger(binding.createdAt) ||
    (binding.createdAt as number) < 0 ||
    binding.ownerIdMatched !== true ||
    binding.projectIdMatched !== true ||
    binding.target !== "preview"
  ) {
    throw new Error("native Vercel deployment binding evidence is malformed")
  }
  return {
    canonicalOrigin: canonicalizeVercelOrigin(binding.canonicalOrigin),
    createdAt: binding.createdAt as number,
    deploymentId,
    marker: assertReconciliationMarker(binding.marker),
    ownerIdMatched: true,
    projectIdMatched: true,
    target: "preview",
  }
}

function sameNativeBinding(
  left: NativeDeploymentBindingEvidence,
  right: NativeDeploymentBindingEvidence,
): boolean {
  return (
    left.canonicalOrigin === right.canonicalOrigin &&
    left.createdAt === right.createdAt &&
    left.deploymentId === right.deploymentId &&
    left.marker === right.marker &&
    left.ownerIdMatched === right.ownerIdMatched &&
    left.projectIdMatched === right.projectIdMatched &&
    left.target === right.target
  )
}

function nativeClockNow(clock: NativeClock, label: string): number {
  const value = clock.now()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must return a nonnegative safe-integer timestamp`)
  }
  return value
}

async function assertNativeProjectPreflight(options: {
  readonly apiClient: NativeVercelApiClient
  readonly orgId: string
  readonly projectId: string
}): Promise<void> {
  const response = await options.apiClient.request(
    "GET",
    `/v9/projects/${options.projectId}?teamId=${options.orgId}`,
  )
  if (response.status !== 200) {
    throw new Error(`native Vercel project preflight failed with status ${response.status}`)
  }
  parseNativeVercelProjectBinding(response.body, options)
}

interface NativeReconciliationRow {
  readonly canonicalOrigin: string
  readonly createdAt: number
  readonly deploymentId: string
  readonly deleted: boolean
}

function parseNativeReconciliationRow(
  value: unknown,
  options: {
    readonly attempt: NativeAttemptEvidence
    readonly pollUpperBoundMs: number
  },
): NativeReconciliationRow {
  const row = recordAt(
    cloneOwnJsonData(value, "native Vercel v6 deployment row"),
    "native Vercel v6 deployment row",
  )
  if (
    typeof row.uid !== "string" ||
    typeof row.url !== "string" ||
    !Number.isSafeInteger(row.created) ||
    (row.created as number) < options.attempt.attemptLowerBoundMs ||
    (row.created as number) > options.pollUpperBoundMs
  ) {
    throw new Error("native Vercel v6 deployment row is malformed or outside its attempt window")
  }
  const deploymentId = assertDeploymentId(row.uid)
  const canonicalOrigin = canonicalizeVercelOrigin(row.url)
  if (new URL(canonicalOrigin).hostname !== row.url) {
    throw new Error("native Vercel v6 deployment row URL must be a bare hostname")
  }
  const meta = recordAt(row.meta, "native Vercel v6 deployment row metadata")
  if (meta.dawnVercelRun !== options.attempt.marker) {
    throw new Error("native Vercel v6 deployment row marker mismatch")
  }
  if (own(row, "state") && typeof row.state !== "string") {
    throw new Error("native Vercel v6 deployment row state must be a string when present")
  }
  return {
    canonicalOrigin,
    createdAt: row.created as number,
    deploymentId,
    deleted: row.state === "DELETED",
  }
}

export async function reconcileNativeMarker(options: {
  readonly apiClient: NativeVercelApiClient
  readonly attempt: NativeAttemptEvidence
  readonly clock: NativeClock
  readonly orgId: string
  readonly persistDeploymentBinding: (evidence: NativeDeploymentBindingEvidence) => Promise<void>
  readonly projectId: string
}): Promise<NativeMarkerReconciliationEvidence> {
  assertNativeVercelScope(options.orgId, options.projectId)
  const attempt = validateNativeAttemptEvidence(options.attempt)
  const overallStartMs = nativeClockNow(options.clock, "native Vercel reconciliation clock")
  if (!Number.isSafeInteger(overallStartMs + NATIVE_RECONCILIATION_DEADLINE_MS)) {
    throw new Error("native Vercel reconciliation deadline is outside the safe timestamp range")
  }
  await assertNativeProjectPreflight(options)
  const assertBeforeOverallDeadline = (): void => {
    if (
      nativeClockNow(options.clock, "native Vercel reconciliation clock") - overallStartMs >=
      NATIVE_RECONCILIATION_DEADLINE_MS
    ) {
      throw new Error("native Vercel marker reconciliation exceeded its 180-second deadline")
    }
  }
  assertBeforeOverallDeadline()

  const bindings = new Map<string, NativeDeploymentBindingEvidence>()
  const observedRows = new Map<string, NativeReconciliationRow>()
  const observedLiveIds = new Set<string>()

  const pollAllPages = async (pollStartMs: number): Promise<number> => {
    const pollUpperBoundMs = pollStartMs + 300_000
    if (!Number.isSafeInteger(pollUpperBoundMs)) {
      throw new Error("native Vercel reconciliation poll window is outside the safe range")
    }
    let pageUntil = pollUpperBoundMs
    let pageCount = 0
    let newlyObservedLive = 0
    const seenCursors = new Set<number>([pageUntil])

    while (true) {
      pageCount += 1
      const path =
        `/v6/deployments?teamId=${options.orgId}&projectId=${options.projectId}` +
        `&meta-dawnVercelRun=${attempt.marker}&since=${attempt.attemptLowerBoundMs}` +
        `&until=${pageUntil}&limit=100`
      const response = await options.apiClient.request("GET", path)
      assertBeforeOverallDeadline()
      if (response.status !== 200) {
        throw new Error(`native Vercel reconciliation list failed with status ${response.status}`)
      }
      const page = recordAt(
        cloneOwnJsonData(response.body, "native Vercel reconciliation page"),
        "native Vercel reconciliation page",
      )
      if (!Array.isArray(page.deployments)) {
        throw new Error("native Vercel reconciliation page deployments must be an array")
      }
      const pagination = recordAt(page.pagination, "native Vercel reconciliation page pagination")

      for (const rawRow of page.deployments) {
        const row = parseNativeReconciliationRow(rawRow, { attempt, pollUpperBoundMs })
        const priorRow = observedRows.get(row.deploymentId)
        if (
          priorRow &&
          (priorRow.canonicalOrigin !== row.canonicalOrigin || priorRow.createdAt !== row.createdAt)
        ) {
          throw new Error("native Vercel reconciliation row changed or conflicts across polls")
        }
        if (!priorRow) observedRows.set(row.deploymentId, row)
        if (row.deleted) continue
        if (!observedLiveIds.has(row.deploymentId)) {
          observedLiveIds.add(row.deploymentId)
          newlyObservedLive += 1
        }
        if (bindings.has(row.deploymentId)) continue

        const bindingResponse = await options.apiClient.request(
          "GET",
          `/v13/deployments/${row.deploymentId}?teamId=${options.orgId}`,
        )
        assertBeforeOverallDeadline()
        if (bindingResponse.status === 404) continue
        if (bindingResponse.status !== 200) {
          throw new Error(
            `native Vercel reconciliation binding failed with status ${bindingResponse.status}`,
          )
        }
        const binding = parseNativeVercelDeploymentBinding(bindingResponse.body, {
          attemptLowerBoundMs: attempt.attemptLowerBoundMs,
          attemptUpperBoundMs: pollUpperBoundMs,
          canonicalOrigin: row.canonicalOrigin,
          deploymentId: row.deploymentId,
          marker: attempt.marker,
          orgId: options.orgId,
          projectId: options.projectId,
        })
        if (binding.createdAt !== row.createdAt) {
          throw new Error("native Vercel v6 and v13 deployment creation times mismatch")
        }
        await options.persistDeploymentBinding(binding)
        assertBeforeOverallDeadline()
        bindings.set(binding.deploymentId, binding)
      }

      if (!own(pagination, "next") || pagination.next === null) break
      if (
        !Number.isSafeInteger(pagination.next) ||
        (pagination.next as number) < attempt.attemptLowerBoundMs ||
        (pagination.next as number) >= pageUntil ||
        seenCursors.has(pagination.next as number)
      ) {
        throw new Error("native Vercel reconciliation pagination cursor is invalid or repeated")
      }
      if (pageCount >= NATIVE_RECONCILIATION_PAGE_LIMIT) {
        throw new Error("native Vercel reconciliation exceeded 100 pages")
      }
      pageUntil = pagination.next as number
      seenCursors.add(pageUntil)
    }
    return newlyObservedLive
  }

  let quietSinceMs: number | undefined
  while (true) {
    const pollStartMs = nativeClockNow(options.clock, "native Vercel reconciliation clock")
    if (pollStartMs - overallStartMs >= NATIVE_RECONCILIATION_DEADLINE_MS) {
      throw new Error("native Vercel marker reconciliation exceeded its 180-second deadline")
    }
    const newlyObservedLive = await pollAllPages(pollStartMs)
    const pollFinishedMs = nativeClockNow(options.clock, "native Vercel reconciliation clock")
    if (pollFinishedMs - overallStartMs >= NATIVE_RECONCILIATION_DEADLINE_MS) {
      throw new Error("native Vercel marker reconciliation exceeded its 180-second deadline")
    }
    if (quietSinceMs === undefined || newlyObservedLive > 0) quietSinceMs = pollFinishedMs

    if (pollFinishedMs - quietSinceMs >= NATIVE_RECONCILIATION_QUIET_INTERVAL_MS) {
      const boundaryStartMs = nativeClockNow(
        options.clock,
        "native Vercel reconciliation boundary clock",
      )
      const boundaryNew = await pollAllPages(boundaryStartMs)
      const boundaryFinishedMs = nativeClockNow(
        options.clock,
        "native Vercel reconciliation boundary clock",
      )
      if (boundaryFinishedMs - overallStartMs >= NATIVE_RECONCILIATION_DEADLINE_MS) {
        throw new Error("native Vercel marker reconciliation exceeded its 180-second deadline")
      }
      if (boundaryNew === 0) {
        const deployments = [...bindings.values()]
        return {
          deployments,
          expectedCardinality: deployments.length <= 1,
          pollIntervalMs: 2_000,
          quietIntervalMs: 30_000,
        }
      }
      quietSinceMs = boundaryFinishedMs
    }

    const beforeSleepMs = nativeClockNow(options.clock, "native Vercel reconciliation clock")
    await options.clock.sleep(NATIVE_RECONCILIATION_POLL_INTERVAL_MS)
    const afterSleepMs = nativeClockNow(options.clock, "native Vercel reconciliation clock")
    if (afterSleepMs <= beforeSleepMs) {
      throw new Error("native Vercel reconciliation clock did not advance during polling")
    }
    if (afterSleepMs - overallStartMs >= NATIVE_RECONCILIATION_DEADLINE_MS) {
      throw new Error("native Vercel marker reconciliation exceeded its 180-second deadline")
    }
  }
}

interface MutableNativeCleanupTarget {
  binding?: NativeDeploymentBindingEvidence
  deleteReceipt?: { readonly state: "DELETED"; readonly uid: string }
  readonly deploymentId: string
}

function validateNativeDeleteReceipt(
  value: { readonly state: "DELETED"; readonly uid: string },
  expectedDeploymentId: string,
): { readonly state: "DELETED"; readonly uid: string } {
  const receipt = recordAt(
    cloneOwnJsonData(value, "native Vercel delete receipt"),
    "native Vercel delete receipt",
  )
  exactKeys(receipt, "native Vercel delete receipt", ["state", "uid"])
  if (receipt.uid !== expectedDeploymentId || receipt.state !== "DELETED") {
    throw new Error("native Vercel cleanup record and delete receipt IDs must match")
  }
  return { state: "DELETED", uid: expectedDeploymentId }
}

function parseNativeDeleteResponse(
  value: unknown,
  expectedDeploymentId: string,
): { readonly state: "DELETED"; readonly uid: string } {
  const response = recordAt(
    cloneOwnJsonData(value, "native Vercel delete response"),
    "native Vercel delete response",
  )
  if (response.uid !== expectedDeploymentId || response.state !== "DELETED") {
    throw new Error("native Vercel delete response must match the exact deployment and state")
  }
  return { state: "DELETED", uid: expectedDeploymentId }
}

function parseNativeCleanupBinding(
  value: unknown,
  binding: NativeDeploymentBindingEvidence,
  orgId: string,
  projectId: string,
): NativeDeploymentBindingEvidence {
  return parseNativeVercelDeploymentBinding(value, {
    attemptLowerBoundMs: binding.createdAt,
    attemptUpperBoundMs: binding.createdAt,
    canonicalOrigin: binding.canonicalOrigin,
    deploymentId: binding.deploymentId,
    marker: binding.marker,
    orgId,
    projectId,
  })
}

export async function cleanupNativeDeployments(options: {
  readonly apiClient: NativeVercelApiClient
  readonly clock: NativeClock
  readonly manifest: readonly NativeDeploymentCleanupRecord[]
  readonly orgId: string
  readonly persistDeploymentAbsent: (deploymentId: string) => Promise<void>
  readonly persistDeleteReceipt: (receipt: {
    readonly state: "DELETED"
    readonly uid: string
  }) => Promise<void>
  readonly projectId: string
  readonly reconciliation: NativeMarkerReconciliationEvidence
}): Promise<{ readonly deploymentAbsent: true; readonly deploymentIds: readonly string[] }> {
  assertNativeVercelScope(options.orgId, options.projectId)
  if (
    options.reconciliation.pollIntervalMs !== 2_000 ||
    options.reconciliation.quietIntervalMs !== 30_000 ||
    typeof options.reconciliation.expectedCardinality !== "boolean" ||
    !Array.isArray(options.reconciliation.deployments)
  ) {
    throw new Error("native Vercel reconciliation evidence is malformed")
  }
  if (
    options.reconciliation.expectedCardinality !==
    options.reconciliation.deployments.length <= 1
  ) {
    throw new Error("native Vercel reconciliation expected cardinality is inconsistent")
  }

  const targets = new Map<string, MutableNativeCleanupTarget>()
  const failures: unknown[] = []
  const addTarget = (recordValue: NativeDeploymentCleanupRecord): void => {
    const record = recordAt(
      cloneOwnJsonData(recordValue, "native Vercel cleanup record"),
      "native Vercel cleanup record",
    )
    const recordKeys = [
      "deploymentId",
      ...(own(record, "binding") ? ["binding"] : []),
      ...(own(record, "deleteReceipt") ? ["deleteReceipt"] : []),
    ]
    exactKeys(record, "native Vercel cleanup record", recordKeys)
    if (typeof record.deploymentId !== "string") {
      throw new Error("native Vercel cleanup deployment ID must be a string")
    }
    const deploymentId = assertDeploymentId(record.deploymentId)
    const binding = own(record, "binding")
      ? validateNativeBindingEvidence(
          record.binding as NativeDeploymentBindingEvidence,
          deploymentId,
        )
      : undefined
    const deleteReceipt = own(record, "deleteReceipt")
      ? validateNativeDeleteReceipt(
          record.deleteReceipt as { readonly state: "DELETED"; readonly uid: string },
          deploymentId,
        )
      : undefined
    if (!binding && !deleteReceipt) {
      throw new Error("native Vercel cleanup target lacks validated ownership authority")
    }

    const existing = targets.get(deploymentId)
    if (!existing) {
      targets.set(deploymentId, {
        ...(binding ? { binding } : {}),
        ...(deleteReceipt ? { deleteReceipt } : {}),
        deploymentId,
      })
      return
    }
    if (binding) {
      if (existing.binding && !sameNativeBinding(existing.binding, binding)) {
        throw new Error("native Vercel cleanup contains conflicting deployment bindings")
      }
      existing.binding = binding
    }
    if (deleteReceipt) existing.deleteReceipt = deleteReceipt
  }

  for (const record of options.manifest) {
    try {
      addTarget(record)
    } catch (error) {
      failures.push(error)
    }
  }
  for (const binding of options.reconciliation.deployments) {
    try {
      const validated = validateNativeBindingEvidence(binding)
      addTarget({ binding: validated, deploymentId: validated.deploymentId })
    } catch (error) {
      failures.push(error)
    }
  }
  if (targets.size === 0 && failures.length > 0) {
    const details = failures
      .map((error) => (error instanceof Error ? error.message : "unknown cleanup record failure"))
      .join("; ")
    throw new AggregateError(failures, `native Vercel cleanup records are invalid: ${details}`)
  }

  await assertNativeProjectPreflight(options)

  const confirmExactAbsence = async (path: string): Promise<void> => {
    const followUp = await options.apiClient.request("GET", path)
    if (followUp.status !== 404) {
      throw new Error(
        `native Vercel exact-ID 404 follow-up did not prove absence (status ${followUp.status})`,
      )
    }
  }

  const cleanupOne = async (target: MutableNativeCleanupTarget): Promise<void> => {
    const path = `/v13/deployments/${target.deploymentId}?teamId=${options.orgId}`
    if (target.deleteReceipt) {
      await confirmExactAbsence(path)
      await options.persistDeploymentAbsent(target.deploymentId)
      return
    }
    const binding = target.binding
    if (!binding) throw new Error("native Vercel cleanup target lacks ownership validation")

    const beforeDelete = await options.apiClient.request("GET", path)
    if (beforeDelete.status === 404) {
      await confirmExactAbsence(path)
      await options.persistDeploymentAbsent(target.deploymentId)
      return
    }
    if (beforeDelete.status !== 200) {
      throw new Error(`native Vercel pre-delete binding failed with status ${beforeDelete.status}`)
    }
    parseNativeCleanupBinding(beforeDelete.body, binding, options.orgId, options.projectId)

    const deletion = await options.apiClient.request("DELETE", path)
    if (deletion.status === 404) {
      await confirmExactAbsence(path)
      await options.persistDeploymentAbsent(target.deploymentId)
      return
    }
    if (deletion.status !== 200) {
      throw new Error(`native Vercel exact-ID delete failed with status ${deletion.status}`)
    }
    const deleteReceipt = parseNativeDeleteResponse(deletion.body, target.deploymentId)
    await options.persistDeleteReceipt(deleteReceipt)

    const pollStartMs = nativeClockNow(options.clock, "native Vercel cleanup clock")
    while (true) {
      const response = await options.apiClient.request("GET", path)
      const responseCompletedMs = nativeClockNow(options.clock, "native Vercel cleanup clock")
      if (responseCompletedMs - pollStartMs > NATIVE_DEPLOYMENT_ABSENCE_DEADLINE_MS) {
        throw new Error("native Vercel deployment absence polling exceeded its 60-second timeout")
      }
      if (response.status === 404) {
        await options.persistDeploymentAbsent(target.deploymentId)
        return
      }
      if (response.status !== 200) {
        throw new Error(`native Vercel absence poll failed with status ${response.status}`)
      }
      parseNativeCleanupBinding(response.body, binding, options.orgId, options.projectId)
      const pollNowMs = responseCompletedMs
      if (pollNowMs - pollStartMs >= NATIVE_DEPLOYMENT_ABSENCE_DEADLINE_MS) {
        throw new Error("native Vercel deployment absence polling exceeded its 60-second timeout")
      }
      await options.clock.sleep(NATIVE_RECONCILIATION_POLL_INTERVAL_MS)
      const afterSleepMs = nativeClockNow(options.clock, "native Vercel cleanup clock")
      if (afterSleepMs <= pollNowMs) {
        throw new Error("native Vercel cleanup clock did not advance during polling")
      }
      if (afterSleepMs - pollStartMs > NATIVE_DEPLOYMENT_ABSENCE_DEADLINE_MS) {
        throw new Error("native Vercel deployment absence polling exceeded its 60-second timeout")
      }
    }
  }

  for (const target of targets.values()) {
    try {
      await cleanupOne(target)
    } catch (error) {
      failures.push(error)
    }
  }
  if (!options.reconciliation.expectedCardinality) {
    failures.push(new Error("native Vercel marker reconciliation failed expected cardinality"))
  }
  if (failures.length > 0) {
    const message = failures
      .map((error) => (error instanceof Error ? error.message : "unknown cleanup failure"))
      .join("; ")
    throw new AggregateError(failures, `native Vercel cleanup failed: ${message}`)
  }
  return { deploymentAbsent: true, deploymentIds: [...targets.keys()] }
}

export interface NativeSseReadResult {
  readonly done: boolean
  readonly value?: Uint8Array
}

export interface NativeSseByteReader {
  readonly read: () => Promise<NativeSseReadResult>
}

export interface NativeSseFrame {
  readonly data: unknown
  readonly event: "chunk" | "done"
  readonly index: number
}

export interface NativeSseFrameReader {
  readonly nextMeaningfulFrame: () => Promise<NativeSseFrame | null>
}

export function createNativeSseFrameReader(reader: NativeSseByteReader): NativeSseFrameReader {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let buffer = ""
  let carriageReturnPending = false
  let ended = false
  let frameIndex = 0
  let activeRead: Promise<NativeSseFrame | null> | undefined

  const normalizeNewlines = (value: string, final: boolean): string => {
    let source = `${carriageReturnPending ? "\r" : ""}${value}`
    carriageReturnPending = false
    if (!final && source.endsWith("\r")) {
      carriageReturnPending = true
      source = source.slice(0, -1)
    }
    return source.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  }

  const parseFrame = (source: string): NativeSseFrame | undefined => {
    const dataLines: string[] = []
    let event: string | undefined
    let meaningful = false
    for (const line of source.split("\n")) {
      if (line === "" || line.startsWith(":")) continue
      meaningful = true
      const separator = line.indexOf(":")
      const field = separator === -1 ? line : line.slice(0, separator)
      let fieldValue = separator === -1 ? "" : line.slice(separator + 1)
      if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1)
      if (field === "event") {
        if (event !== undefined)
          throw new Error("native public SSE frame has duplicate event fields")
        event = fieldValue
      } else if (field === "data") {
        dataLines.push(fieldValue)
      } else {
        throw new Error(`native public SSE frame contains unknown field ${field}`)
      }
    }
    if (!meaningful) return undefined
    if (event !== "chunk" && event !== "done") {
      throw new Error(
        "native public SSE event must be chunk or done; internal events are forbidden",
      )
    }
    if (dataLines.length === 0) throw new Error("native public SSE frame is missing data")
    let data: unknown
    try {
      data = JSON.parse(dataLines.join("\n"))
    } catch {
      throw new Error("native public SSE frame data must be valid JSON")
    }
    if (!Number.isSafeInteger(frameIndex)) throw new Error("native public SSE frame index overflow")
    const frame: NativeSseFrame = { data, event, index: frameIndex }
    frameIndex += 1
    return frame
  }

  const readNext = async (): Promise<NativeSseFrame | null> => {
    while (true) {
      const boundary = buffer.indexOf("\n\n")
      if (boundary !== -1) {
        const source = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const frame = parseFrame(source)
        if (frame) return frame
        continue
      }
      if (ended) {
        if (buffer.trim() !== "") {
          throw new Error("native public SSE stream ended with an incomplete frame")
        }
        buffer = ""
        return null
      }

      let result: NativeSseReadResult
      try {
        result = await reader.read()
      } catch {
        throw new Error("native public SSE body read failed")
      }
      if (typeof result.done !== "boolean") {
        throw new Error("native public SSE reader returned a malformed result")
      }
      if (result.done) {
        let decoded: string
        try {
          decoded = decoder.decode()
        } catch {
          throw new Error("native public SSE stream ended with incomplete UTF-8")
        }
        buffer += normalizeNewlines(decoded, true)
        ended = true
        continue
      }
      if (!(result.value instanceof Uint8Array) || result.value.byteLength === 0) {
        throw new Error("native public SSE reader must return nonempty byte chunks")
      }
      let decoded: string
      try {
        decoded = decoder.decode(result.value, { stream: true })
      } catch {
        throw new Error("native public SSE stream contains invalid UTF-8")
      }
      buffer += normalizeNewlines(decoded, false)
    }
  }

  return {
    nextMeaningfulFrame: () => {
      if (activeRead) {
        return Promise.reject(new Error("native public SSE reader already has a pending read"))
      }
      const operation = readNext().finally(() => {
        if (activeRead === operation) activeRead = undefined
      })
      activeRead = operation
      return operation
    },
  }
}

function assertNativeSseFrameIndex(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must have a nonnegative safe-integer frame index`)
  }
}

export function assertNativePreReleaseSseFrame(frame: NativeSseFrame | null): NativeSseFrame {
  if (!frame) throw new Error("native causal SSE reached EOF before release authorization")
  assertNativeSseFrameIndex(frame.index, "native causal SSE before-release frame")
  if (frame.event !== "chunk" || frame.data !== "before-release") {
    throw new Error("native causal SSE must expose only before-release before authorization")
  }
  return frame
}

export function assertNativePostReleaseSseFrames(options: {
  readonly after: NativeSseFrame | null
  readonly barrierId: string
  readonly before: NativeSseFrame
  readonly done: NativeSseFrame | null
  readonly eof: NativeSseFrame | null
}): {
  readonly afterFrameIndex: number
  readonly doneFrameIndex: number
  readonly eofAfterDone: true
} {
  const before = assertNativePreReleaseSseFrame(options.before)
  assertBarrierId(options.barrierId)
  if (!options.after) throw new Error("native causal SSE reached EOF before after-release")
  if (!options.done) throw new Error("native causal SSE reached EOF before done")
  assertNativeSseFrameIndex(options.after.index, "native causal SSE after-release frame")
  assertNativeSseFrameIndex(options.done.index, "native causal SSE done frame")
  if (
    options.after.event !== "chunk" ||
    options.after.data !== "after-release" ||
    options.after.index <= before.index
  ) {
    throw new Error("native causal SSE after-release frame is malformed or out of order")
  }
  if (options.done.event !== "done" || options.done.index <= options.after.index) {
    throw new Error("native causal SSE done frame is malformed or out of order")
  }
  const doneData = recordAt(
    cloneOwnJsonData(options.done.data, "native causal SSE done data"),
    "native causal SSE done data",
  )
  exactKeys(doneData, "native causal SSE done data", ["output"])
  const output = recordAt(doneData.output, "native causal SSE done output")
  exactKeys(output, "native causal SSE done output", ["barrierId", "released"])
  if (output.barrierId !== options.barrierId || output.released !== true) {
    throw new Error("native causal SSE done output does not match the released barrier")
  }
  if (options.eof !== null) throw new Error("native causal SSE emitted a frame after done")
  return {
    afterFrameIndex: options.after.index,
    doneFrameIndex: options.done.index,
    eofAfterDone: true,
  }
}

export interface NativeRuntimeLogVersion {
  readonly fingerprint: string
  readonly id: string
  readonly markerOccurrences: number
}

export interface NativeRuntimeLogBatch {
  readonly markerOccurrences: number
  readonly versions: readonly NativeRuntimeLogVersion[]
}

export interface NativeRuntimeLogEvidence {
  readonly exactDeploymentOnly: true
  readonly markerOccurrences: 1
  readonly noErrors: true
  readonly noTruncation: true
  readonly pollIntervalMs: 2000
  readonly queryEndIso: string
  readonly queryStartIso: string
  readonly quietIntervalMs: 30000
  readonly uniqueRowVersions: number
}

export function scanNativeVercelLogJsonl(_options: {
  readonly deploymentId: string
  readonly logMarker: string
  readonly projectId: string
  readonly stdout: string
}): NativeRuntimeLogBatch {
  const options = _options
  assertDeploymentId(options.deploymentId)
  if (!/^prj_[A-Za-z0-9]+$/.test(options.projectId)) {
    throw new Error("native Vercel log project scope is malformed")
  }
  assertLogMarker(options.logMarker)
  if (options.stdout.trim() === "") return { markerOccurrences: 0, versions: [] }

  const source = options.stdout.replace(/(?:\r?\n)+$/, "")
  const lines = source.split(/\r?\n/)
  if (lines.some((line) => line.trim() === "")) {
    throw new Error("native Vercel log JSONL contains an empty row")
  }
  if (lines.length >= 1_000) {
    throw new Error("native Vercel log response saturated the 1,000-row limit")
  }

  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    )
  }
  const messageFailure = (message: string): boolean => {
    if (
      /\b(?:uncaught|unhandled)\b/i.test(message) ||
      /function invocation failed/i.test(message)
    ) {
      return true
    }
    const resource = /\b(?:handler|pool|connection|leak|lifecycle)\b/i.test(message)
    const failure =
      /\b(?:error|fail(?:ed|ure)?|exception|timeout|closed|rejection|terminated|refused|reset|crash(?:ed)?|exhaust(?:ed)?|detected)\b/i.test(
        message,
      ) || /ECONNRESET/i.test(message)
    return resource && failure
  }
  const allStrings: string[] = []
  const inspectValue = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      allStrings.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) inspectValue(entry, `${path}[${index}]`)
      return
    }
    if (!value || typeof value !== "object") return
    for (const [key, entry] of Object.entries(value)) {
      if (key === "messageTruncated" && entry !== false) {
        throw new Error(`${path}.${key} must be absent or exactly false`)
      }
      if (key === "error" || key === "fatal") {
        throw new Error(`${path} contains forbidden ${key} log evidence`)
      }
      if (key === "level") {
        if (typeof entry !== "string") throw new Error(`${path}.level must be a string`)
        if (/^(?:error|fatal)$/i.test(entry)) {
          throw new Error(`${path}.level reports a runtime error`)
        }
      }
      if (key === "message") {
        if (typeof entry !== "string") throw new Error(`${path}.message must be a string`)
        if (messageFailure(entry)) throw new Error(`${path}.message reports a runtime error`)
      }
      inspectValue(entry, `${path}.${key}`)
    }
  }
  const countMarkerInString = (value: string): number => {
    let count = 0
    let offset = 0
    while (true) {
      const index = value.indexOf(options.logMarker, offset)
      if (index === -1) break
      count += 1
      offset = index + options.logMarker.length
    }
    return count
  }
  const countMarker = (strings: readonly string[]): number =>
    strings.reduce((count, value) => count + countMarkerInString(value), 0)

  const versions: NativeRuntimeLogVersion[] = []
  const seenVersions = new Set<string>()
  let markerOccurrences = 0
  for (const [lineIndex, line] of lines.entries()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`native Vercel log row ${lineIndex} is not valid JSON`)
    }
    const cloned = cloneOwnJsonData(parsed, `native Vercel log row ${lineIndex}`)
    assertPlainJsonValue(cloned, `native Vercel log row ${lineIndex}`)
    const row = recordAt(cloned, `native Vercel log row ${lineIndex}`)
    if (typeof row.id !== "string" || row.id.trim() === "") {
      throw new Error("native Vercel log row ID must be a nonempty string")
    }
    if (row.deploymentId !== options.deploymentId || row.projectId !== options.projectId) {
      throw new Error("native Vercel log row does not match deployment and project scope")
    }
    const responseStatusCode = row.responseStatusCode
    if (
      !own(row, "responseStatusCode") ||
      !Number.isSafeInteger(responseStatusCode) ||
      (responseStatusCode !== 0 &&
        ((responseStatusCode as number) < 100 || (responseStatusCode as number) > 599))
    ) {
      throw new Error("native Vercel log response status code is missing or malformed")
    }
    if ((responseStatusCode as number) >= 500) {
      throw new Error("native Vercel log row reports a 5xx response status")
    }
    if (typeof row.level !== "string" || typeof row.message !== "string") {
      throw new Error("native Vercel log row must contain string level and message fields")
    }
    if (!Array.isArray(row.logs)) throw new Error("native Vercel log row logs must be an array")
    for (const entry of row.logs) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("native Vercel nested log entry must be an object")
      }
      const nested = entry as Record<string, unknown>
      if (typeof nested.level !== "string" || typeof nested.message !== "string") {
        throw new Error("native Vercel nested log entry must contain string level and message")
      }
    }
    allStrings.length = 0
    inspectValue(row, `native Vercel log row ${lineIndex}`)
    let rowMarkerOccurrences = countMarker(allStrings)
    if (
      typeof row.message === "string" &&
      Array.isArray(row.logs) &&
      row.logs.some(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).message === row.message,
      )
    ) {
      rowMarkerOccurrences -= countMarkerInString(row.message)
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(canonicalize(row)), "utf8")
      .digest("hex")
    const versionIdentity = `${row.id}\0${fingerprint}`
    if (seenVersions.has(versionIdentity)) continue
    seenVersions.add(versionIdentity)
    markerOccurrences += rowMarkerOccurrences
    versions.push({
      fingerprint,
      id: row.id,
      markerOccurrences: rowMarkerOccurrences,
    })
  }
  return { markerOccurrences, versions }
}

export async function pollNativeVercelRuntimeLogs(options: {
  readonly clock: NativeClock
  readonly deploymentId: string
  readonly logBoundary: Pick<NativePinnedVercelBoundary, "logs">
  readonly logMarker: string
  readonly orgId: string
  readonly projectId: string
  readonly queryStartMs: number
  readonly persistSnapshot?: (stdout: string) => Promise<void>
}): Promise<NativeRuntimeLogEvidence> {
  assertNativeVercelScope(options.orgId, options.projectId)
  assertDeploymentId(options.deploymentId)
  assertLogMarker(options.logMarker)
  if (
    !options.logBoundary ||
    typeof options.logBoundary.logs !== "function" ||
    !Number.isSafeInteger(options.queryStartMs) ||
    options.queryStartMs < 0
  ) {
    throw new Error("native Vercel pinned log boundary or start time is malformed")
  }
  const queryStartDate = new Date(options.queryStartMs)
  if (!Number.isFinite(queryStartDate.getTime())) {
    throw new Error("native Vercel log query start is outside the ISO date range")
  }
  const queryStartIso = queryStartDate.toISOString()
  const overallStartMs = nativeClockNow(options.clock, "native Vercel log polling clock")
  const seenVersions = new Set<string>()
  let markerOccurrences = 0
  let quietSinceMs: number | undefined

  const pollOnce = async (): Promise<{
    readonly completedMs: number
    readonly newVersions: number
    readonly queryEndIso: string
    readonly snapshotMarkerOccurrences: number
    readonly snapshotVersions: number
  }> => {
    const pollStartMs = nativeClockNow(options.clock, "native Vercel log polling clock")
    if (pollStartMs - overallStartMs >= NATIVE_RECONCILIATION_DEADLINE_MS) {
      throw new Error("native Vercel log polling exceeded its 180-second deadline")
    }
    const queryEndDate = new Date(pollStartMs)
    if (!Number.isFinite(queryEndDate.getTime()) || pollStartMs < options.queryStartMs) {
      throw new Error("native Vercel log query end is outside its bounded time window")
    }
    const queryEndIso = queryEndDate.toISOString()
    let stdout: string
    try {
      stdout = await options.logBoundary.logs({
        deploymentId: options.deploymentId,
        queryEndIso,
        queryStartIso,
      })
    } catch {
      throw new Error("native Vercel pinned log boundary failed")
    }
    const completedMs = nativeClockNow(options.clock, "native Vercel log polling clock")
    if (completedMs - overallStartMs >= NATIVE_RECONCILIATION_DEADLINE_MS) {
      throw new Error("native Vercel log polling exceeded its 180-second deadline")
    }
    if (typeof stdout !== "string") throw new Error("native Vercel pinned log stdout is malformed")
    if (options.persistSnapshot) await options.persistSnapshot(stdout)
    const batch = scanNativeVercelLogJsonl({
      deploymentId: options.deploymentId,
      logMarker: options.logMarker,
      projectId: options.projectId,
      stdout,
    })
    let newVersions = 0
    for (const version of batch.versions) {
      const identity = `${version.id}\0${version.fingerprint}`
      if (seenVersions.has(identity)) continue
      seenVersions.add(identity)
      markerOccurrences += version.markerOccurrences
      newVersions += 1
    }
    if (markerOccurrences > 1) {
      throw new Error("native Vercel logs contain more than one benign marker occurrence")
    }
    return {
      completedMs,
      newVersions,
      queryEndIso,
      snapshotMarkerOccurrences: batch.markerOccurrences,
      snapshotVersions: batch.versions.length,
    }
  }

  while (true) {
    const poll = await pollOnce()
    if (poll.snapshotVersions === 0 || poll.snapshotMarkerOccurrences !== 1) {
      quietSinceMs = undefined
    } else if (markerOccurrences === 1 && (quietSinceMs === undefined || poll.newVersions > 0)) {
      quietSinceMs = poll.completedMs
    }
    if (
      markerOccurrences === 1 &&
      quietSinceMs !== undefined &&
      poll.completedMs - quietSinceMs >= NATIVE_RECONCILIATION_QUIET_INTERVAL_MS
    ) {
      const boundary = await pollOnce()
      if (
        boundary.snapshotVersions > 0 &&
        boundary.snapshotMarkerOccurrences === 1 &&
        boundary.newVersions === 0
      ) {
        return {
          exactDeploymentOnly: true,
          markerOccurrences: 1,
          noErrors: true,
          noTruncation: true,
          pollIntervalMs: 2_000,
          queryEndIso: boundary.queryEndIso,
          queryStartIso,
          quietIntervalMs: 30_000,
          uniqueRowVersions: seenVersions.size,
        }
      }
      quietSinceMs =
        boundary.snapshotVersions > 0 && boundary.snapshotMarkerOccurrences === 1
          ? boundary.completedMs
          : undefined
    }
    const beforeSleepMs = nativeClockNow(options.clock, "native Vercel log polling clock")
    await options.clock.sleep(NATIVE_RECONCILIATION_POLL_INTERVAL_MS)
    const afterSleepMs = nativeClockNow(options.clock, "native Vercel log polling clock")
    if (afterSleepMs <= beforeSleepMs) {
      throw new Error("native Vercel log polling clock did not advance")
    }
    if (afterSleepMs - overallStartMs >= NATIVE_RECONCILIATION_DEADLINE_MS) {
      throw new Error("native Vercel log polling exceeded its 180-second deadline")
    }
  }
}

export interface NativeBlackBoxHttpRequest {
  readonly body?: unknown
  readonly headers: Headers
  readonly method: "GET" | "POST"
  readonly redirect: "manual"
  readonly timeoutMs: number
  readonly url: string
}

export interface NativeBlackBoxDatabaseRequest {
  readonly params: readonly unknown[]
  readonly sql: string
  readonly timeoutMs: number
}

export interface NativeBlackBoxIds {
  readonly laterThreadId: string
  readonly logMarker: string
  readonly releaseThreadId: string
  readonly sentinelBarrierId: string
  readonly stateMarkers: readonly [string, string]
  readonly stateThreadId: string
  readonly streamThreadId: string
  readonly targetBarrierId: string
  readonly unknownThreadId: string
}

export interface NativeBlackBoxEvidence {
  readonly laterRequest: { readonly logMarkerSeen: true; readonly succeeded: true }
  readonly logs: Omit<NativeRuntimeLogEvidence, "markerOccurrences">
  readonly middleware: {
    readonly missingHeader401: true
    readonly selectiveRelease: true
    readonly sentinelUnreleased: true
    readonly wrongHeader401: true
  }
  readonly routes: {
    readonly release: true
    readonly state: true
    readonly stream: true
    readonly unknownRoute404: true
  }
  readonly state: {
    readonly generatedReadMatched: true
    readonly markersInOrder: true
    readonly physicalCheckpoint: true
    readonly visits: readonly [1, 2]
  }
  readonly stream: {
    readonly afterFrameIndex: number
    readonly authorizedReleaseAfterBeforeFrame: true
    readonly beforeFrameIndex: number
    readonly contentType: "text/event-stream"
    readonly doneFrameIndex: number
    readonly eofAfterDone: true
    readonly noRedirect: true
    readonly preReleaseQuietMs: 1000
    readonly status: 200
  }
}

type NativeFunctionalStage = "logs" | "routes" | "state" | "stream"

const NATIVE_BLACK_BOX_OPERATION_TIMEOUT_MS = 30_000

const NATIVE_CHECKPOINT_COUNT_SQL = [
  "SELECT COUNT(*)::integer AS checkpoint_count",
  "FROM public.dawn_checkpoints",
  "WHERE thread_id = $1",
].join("\n")

const NATIVE_BARRIER_INSERT_SQL = [
  "INSERT INTO public.dawn_vercel_test_barriers (barrier_id, released)",
  "VALUES ($1, false), ($2, false)",
].join("\n")

const NATIVE_BARRIER_CREATE_SQL = [
  "CREATE TABLE IF NOT EXISTS public.dawn_vercel_test_barriers (",
  "  barrier_id text PRIMARY KEY,",
  "  released boolean NOT NULL DEFAULT false",
  ")",
].join("\n")

const NATIVE_BARRIER_STATE_SQL = [
  "SELECT barrier_id, released",
  "FROM public.dawn_vercel_test_barriers",
  "WHERE barrier_id = ANY($1::text[])",
  "ORDER BY barrier_id",
].join("\n")

function assertDistinctNativeBlackBoxIds(ids: NativeBlackBoxIds): void {
  const threadIds = [
    ids.unknownThreadId,
    ids.stateThreadId,
    ids.releaseThreadId,
    ids.streamThreadId,
    ids.laterThreadId,
  ]
  for (const threadId of threadIds) assertThreadId(threadId)
  if (new Set(threadIds).size !== threadIds.length) {
    throw new Error("native Vercel black-box thread IDs must be distinct")
  }
  assertBarrierId(ids.targetBarrierId)
  assertBarrierId(ids.sentinelBarrierId)
  if (ids.targetBarrierId === ids.sentinelBarrierId) {
    throw new Error("native Vercel black-box barrier IDs must be distinct")
  }
  for (const marker of [...ids.stateMarkers, ids.logMarker]) assertLogMarker(marker)
  if (new Set([...ids.stateMarkers, ids.logMarker]).size !== 3) {
    throw new Error("native Vercel black-box state and log markers must be distinct")
  }
}

function assertNativeStateOutput(
  value: unknown,
  expectedVisits: number,
  expectedMarkers: readonly string[],
  label: string,
): void {
  const state = recordAt(cloneOwnJsonData(value, label), label)
  if (state.visits !== expectedVisits) throw new Error(`${label}.visits is incorrect`)
  if (
    !Array.isArray(state.markers) ||
    state.markers.length !== expectedMarkers.length ||
    state.markers.some((marker, index) => marker !== expectedMarkers[index])
  ) {
    throw new Error(`${label}.markers are not the exact ordered markers`)
  }
}

export async function runNativeVercelBlackBox(options: {
  readonly canonicalOrigin: string
  readonly clock: NativeClock
  readonly database: {
    readonly query: (
      request: NativeBlackBoxDatabaseRequest,
    ) => Promise<{ readonly rows: unknown[] }>
  }
  readonly deploymentId: string
  readonly ids: NativeBlackBoxIds
  readonly logBoundary: Pick<NativePinnedVercelBoundary, "logs">
  readonly orgId: string
  readonly persistBarrier: (record: {
    readonly barrierId: string
    readonly role: "sentinel" | "target"
  }) => Promise<void>
  readonly persistDispatch: (
    dispatch: "later" | "release" | "state" | "stream" | "unknown",
  ) => Promise<void>
  readonly persistRuntimeLogSnapshot?: (stdout: string) => Promise<void>
  readonly persistStage?: <Stage extends NativeFunctionalStage>(
    stage: Stage,
    evidence: NativeBlackBoxEvidence[Stage],
  ) => Promise<void>
  readonly persistSseEvidence?: (evidence: {
    readonly after?: NativeSseFrame
    readonly before: NativeSseFrame
    readonly done?: NativeSseFrame
    readonly eof?: true
  }) => Promise<void>
  readonly persistThread: (threadId: string) => Promise<void>
  readonly projectId: string
  readonly releaseAuthorization: NativeReleaseAuthorization
  readonly request: (request: NativeBlackBoxHttpRequest) => Promise<Response> | Response
  readonly withTimeout: <T>(label: string, timeoutMs: number, operation: Promise<T>) => Promise<T>
}): Promise<NativeBlackBoxEvidence> {
  const canonicalOrigin = canonicalizeVercelOrigin(options.canonicalOrigin)
  assertDeploymentId(options.deploymentId)
  assertNativeVercelScope(options.orgId, options.projectId)
  assertDistinctNativeBlackBoxIds(options.ids)
  for (const callback of [
    options.database?.query,
    options.persistBarrier,
    options.persistDispatch,
    ...(options.persistStage ? [options.persistStage] : []),
    options.persistThread,
    options.request,
    options.withTimeout,
    options.releaseAuthorization?.apply,
  ]) {
    if (typeof callback !== "function") {
      throw new Error("native Vercel black-box injected operation is malformed")
    }
  }
  const queryStartMs = nativeClockNow(options.clock, "native Vercel black-box clock")
  const assertReleaseSafe = (label: string, value: unknown): void => {
    options.releaseAuthorization.assertSafe(`native Vercel black-box ${label}`, value)
  }

  const bounded = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
    try {
      return await options.withTimeout(
        label,
        NATIVE_BLACK_BOX_OPERATION_TIMEOUT_MS,
        Promise.resolve().then(operation),
      )
    } catch {
      throw new Error(`native Vercel black-box ${label} failed`)
    }
  }
  const cancelResponseBody = async (label: string, response: Response): Promise<void> => {
    const body = response.body
    if (!body || body.locked) return
    await bounded(`${label} response body cancellation`, () => body.cancel())
  }
  const cancelResponseBodyAfterFailure = async (
    label: string,
    response: Response,
  ): Promise<void> => {
    try {
      await cancelResponseBody(label, response)
    } catch {
      // Preserve the already-sanitized primary failure after a bounded cleanup attempt.
    }
  }
  const persistThread = async (threadId: string): Promise<void> => {
    assertReleaseSafe("thread evidence", threadId)
    await bounded("thread evidence persistence", () => options.persistThread(threadId))
  }
  const persistDispatch = async (
    dispatch: "later" | "release" | "state" | "stream" | "unknown",
  ): Promise<void> => {
    assertReleaseSafe("dispatch evidence", dispatch)
    await bounded(`${dispatch} dispatch evidence persistence`, () =>
      options.persistDispatch(dispatch),
    )
  }
  const persistFunctionalStage = async <Stage extends NativeFunctionalStage>(
    stage: Stage,
    evidence: NativeBlackBoxEvidence[Stage],
  ): Promise<void> => {
    if (!options.persistStage) return
    assertReleaseSafe(`${stage} functional stage evidence`, evidence)
    await bounded(
      `${stage} functional stage evidence persistence`,
      () => options.persistStage?.(stage, evidence) as Promise<void>,
    )
  }
  const query = async (
    label: string,
    sql: string,
    params: readonly unknown[],
  ): Promise<readonly unknown[]> => {
    assertReleaseSafe(`${label} database request`, { params, sql })
    const result = await bounded(`${label} database operation`, () =>
      options.database.query({
        params,
        sql,
        timeoutMs: NATIVE_BLACK_BOX_OPERATION_TIMEOUT_MS,
      }),
    )
    if (!result || !Array.isArray(result.rows)) {
      throw new Error(`native Vercel black-box ${label} database result is malformed`)
    }
    assertReleaseSafe(`${label} database result`, result.rows)
    return result.rows
  }
  const send = async (
    label: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    headers = new Headers(),
  ): Promise<Response> => {
    if (method === "POST") headers.set("content-type", "application/json")
    const url = new URL(path, canonicalOrigin).toString()
    assertReleaseSafe(`${label} HTTP request`, { body, method, url })
    const response = await bounded(`${label} HTTP request`, () =>
      Promise.resolve(
        options.request({
          ...(body !== undefined ? { body } : {}),
          headers,
          method,
          redirect: "manual",
          timeoutMs: NATIVE_BLACK_BOX_OPERATION_TIMEOUT_MS,
          url,
        }),
      ),
    )
    try {
      let responseUrl: URL
      try {
        responseUrl = new URL(response.url)
      } catch {
        throw new Error(`native Vercel black-box ${label} response URL is malformed`)
      }
      if (
        response.redirected ||
        responseUrl.origin !== canonicalOrigin ||
        responseUrl.toString() !== url
      ) {
        throw new Error(`native Vercel black-box ${label} response redirected or changed origin`)
      }
      assertReleaseSafe(`${label} HTTP response metadata`, {
        headers: Object.fromEntries(response.headers),
        redirected: response.redirected,
        status: response.status,
        url: response.url,
      })
      return response
    } catch (error) {
      await cancelResponseBodyAfterFailure(label, response)
      throw error
    }
  }
  const readJson = async (label: string, response: Response): Promise<unknown> => {
    try {
      let contentType: MIMEType
      try {
        contentType = new MIMEType(response.headers.get("content-type") ?? "")
      } catch {
        throw new Error(`native Vercel black-box ${label} JSON content type is malformed`)
      }
      if (contentType.essence !== "application/json") {
        throw new Error(`native Vercel black-box ${label} must return application/json`)
      }
      const value = await bounded(`${label} JSON body read`, () => response.json())
      const cloned = cloneOwnJsonData(value, `native Vercel black-box ${label}`)
      assertPlainJsonValue(cloned, `native Vercel black-box ${label}`)
      assertReleaseSafe(`${label} JSON response`, cloned)
      return cloned
    } catch (error) {
      await cancelResponseBodyAfterFailure(label, response)
      throw error
    }
  }
  const requireStatus = async (
    response: Response,
    expected: number,
    label: string,
  ): Promise<void> => {
    if (response.status !== expected) {
      await cancelResponseBodyAfterFailure(label, response)
      throw new Error(`native Vercel black-box ${label} must return HTTP ${expected}`)
    }
  }
  const readBarrierState = async (
    label: string,
  ): Promise<{
    readonly sentinelReleased: boolean
    readonly targetReleased: boolean
  }> => {
    const rows = await query(label, NATIVE_BARRIER_STATE_SQL, [
      [options.ids.targetBarrierId, options.ids.sentinelBarrierId],
    ])
    if (rows.length !== 2) {
      throw new Error(`native Vercel black-box ${label} must return both exact barriers`)
    }
    const byId = new Map<string, boolean>()
    for (const [index, value] of rows.entries()) {
      const row = recordAt(value, `native Vercel black-box ${label} row ${index}`)
      exactKeys(row, `native Vercel black-box ${label} row ${index}`, ["barrier_id", "released"])
      if (
        (row.barrier_id !== options.ids.targetBarrierId &&
          row.barrier_id !== options.ids.sentinelBarrierId) ||
        typeof row.released !== "boolean" ||
        byId.has(row.barrier_id)
      ) {
        throw new Error(`native Vercel black-box ${label} barrier row is malformed`)
      }
      byId.set(row.barrier_id, row.released)
    }
    return {
      sentinelReleased: byId.get(options.ids.sentinelBarrierId) as boolean,
      targetReleased: byId.get(options.ids.targetBarrierId) as boolean,
    }
  }

  await persistThread(options.ids.unknownThreadId)
  const unknownPath = `/threads/${options.ids.unknownThreadId}/runs/wait`
  const unknown = await send("unknown route", "POST", unknownPath, {
    input: {},
    route: "/unknown#agent",
  })
  await requireStatus(unknown, 404, "unknown route")
  await cancelResponseBody("unknown route", unknown)
  await persistDispatch("unknown")

  await persistThread(options.ids.stateThreadId)
  const stateRunPath = `/threads/${options.ids.stateThreadId}/runs/wait`
  const firstStateResponse = await send(
    "first state run",
    "POST",
    stateRunPath,
    nativeAgentRunBody("/state#agent", options.ids.stateMarkers[0]),
  )
  await requireStatus(firstStateResponse, 200, "first state run")
  assertNativeStateOutput(
    await readJson("first state run", firstStateResponse),
    1,
    [options.ids.stateMarkers[0]],
    "native Vercel black-box first state run",
  )
  const secondStateResponse = await send(
    "second state run",
    "POST",
    stateRunPath,
    nativeAgentRunBody("/state#agent", options.ids.stateMarkers[1]),
  )
  await requireStatus(secondStateResponse, 200, "second state run")
  assertNativeStateOutput(
    await readJson("second state run", secondStateResponse),
    2,
    options.ids.stateMarkers,
    "native Vercel black-box second state run",
  )
  const generatedStateResponse = await send(
    "generated state read",
    "GET",
    `/threads/${options.ids.stateThreadId}/state`,
  )
  await requireStatus(generatedStateResponse, 200, "generated state read")
  const generatedState = recordAt(
    await readJson("generated state read", generatedStateResponse),
    "native Vercel black-box generated state",
  )
  assertNativeStateOutput(
    generatedState.values,
    2,
    options.ids.stateMarkers,
    "native Vercel black-box generated state.values",
  )
  const checkpointRows = await query("physical checkpoint", NATIVE_CHECKPOINT_COUNT_SQL, [
    options.ids.stateThreadId,
  ])
  if (
    checkpointRows.length !== 1 ||
    !Number.isSafeInteger(
      recordAt(checkpointRows[0], "physical checkpoint row").checkpoint_count,
    ) ||
    (recordAt(checkpointRows[0], "physical checkpoint row").checkpoint_count as number) < 1
  ) {
    throw new Error("native Vercel black-box physical checkpoint is missing")
  }
  await persistDispatch("state")
  const stateEvidence: NativeBlackBoxEvidence["state"] = {
    generatedReadMatched: true,
    markersInOrder: true,
    physicalCheckpoint: true,
    visits: [1, 2],
  }
  await persistFunctionalStage("state", stateEvidence)

  await bounded("target barrier evidence persistence", () => {
    const record = { barrierId: options.ids.targetBarrierId, role: "target" as const }
    assertReleaseSafe("target barrier evidence", record)
    return options.persistBarrier(record)
  })
  await bounded("sentinel barrier evidence persistence", () => {
    const record = { barrierId: options.ids.sentinelBarrierId, role: "sentinel" as const }
    assertReleaseSafe("sentinel barrier evidence", record)
    return options.persistBarrier(record)
  })
  const created = await query("barrier table creation", NATIVE_BARRIER_CREATE_SQL, [])
  if (created.length !== 0) {
    throw new Error("native Vercel black-box barrier table creation returned unexpected rows")
  }
  const inserted = await query("barrier insert", NATIVE_BARRIER_INSERT_SQL, [
    options.ids.targetBarrierId,
    options.ids.sentinelBarrierId,
  ])
  if (inserted.length !== 0) {
    throw new Error("native Vercel black-box barrier insert returned unexpected rows")
  }

  await persistThread(options.ids.releaseThreadId)
  const releasePath = `/threads/${options.ids.releaseThreadId}/runs/wait`
  const releaseBody = {
    input: { barrierId: options.ids.targetBarrierId },
    route: "/release#graph",
  }
  const missingRelease = await send("missing-header release", "POST", releasePath, releaseBody)
  await requireStatus(missingRelease, 401, "missing-header release")
  await cancelResponseBody("missing-header release", missingRelease)
  const afterMissingState = await readBarrierState("missing-header barrier state")
  if (afterMissingState.targetReleased || afterMissingState.sentinelReleased) {
    throw new Error("native Vercel black-box missing-header release mutated a barrier")
  }
  const wrongHeaders = new Headers()
  wrongHeaders.set("x-dawn-vercel-release", "incorrect-release-credential")
  const wrongRelease = await send(
    "wrong-header release",
    "POST",
    releasePath,
    releaseBody,
    wrongHeaders,
  )
  await requireStatus(wrongRelease, 401, "wrong-header release")
  await cancelResponseBody("wrong-header release", wrongRelease)
  const afterWrongState = await readBarrierState("wrong-header barrier state")
  if (afterWrongState.targetReleased || afterWrongState.sentinelReleased) {
    throw new Error("native Vercel black-box wrong-header release mutated a barrier")
  }

  await persistThread(options.ids.streamThreadId)
  const streamPath = `/threads/${options.ids.streamThreadId}/runs/stream`
  const streamResponse = await send(
    "causal stream",
    "POST",
    streamPath,
    nativeAgentRunBody("/stream#agent", options.ids.targetBarrierId),
    new Headers({ accept: "text/event-stream" }),
  )
  await requireStatus(streamResponse, 200, "causal stream")
  const routesEvidence: NativeBlackBoxEvidence["routes"] = {
    release: true,
    state: true,
    stream: true,
    unknownRoute404: true,
  }
  let streamEvidence: NativeBlackBoxEvidence["stream"] | undefined
  let streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    let contentType: MIMEType
    try {
      contentType = new MIMEType(streamResponse.headers.get("content-type") ?? "")
    } catch {
      throw new Error("native Vercel black-box causal stream content type is malformed")
    }
    if (contentType.essence !== "text/event-stream") {
      throw new Error("native Vercel black-box causal stream must be text/event-stream")
    }
    const streamBody = streamResponse.body
    if (!streamBody) throw new Error("native Vercel black-box causal stream body is missing")
    const reader = streamBody.getReader()
    streamReader = reader
    const rawDecoder = new TextDecoder("utf-8", { fatal: true })
    let rawSseText = ""
    let rawSseBytes = 0
    const frames = createNativeSseFrameReader({
      read: async () => {
        const result = await reader.read()
        try {
          if (result.done) {
            rawSseText += rawDecoder.decode()
          } else {
            rawSseBytes += result.value.byteLength
            if (rawSseBytes > 1_048_576) {
              throw new Error("native Vercel black-box SSE exceeds its one-megabyte evidence cap")
            }
            rawSseText += rawDecoder.decode(result.value, { stream: true })
          }
        } catch {
          throw new Error("native Vercel black-box raw SSE is malformed")
        }
        assertReleaseSafe("raw SSE", rawSseText)
        return result
      },
    })
    const before = assertNativePreReleaseSseFrame(
      await bounded("before-release frame read", () => frames.nextMeaningfulFrame()),
    )
    assertReleaseSafe("before-release SSE frame", before)
    if (options.persistSseEvidence) {
      await bounded(
        "before-release SSE evidence persistence",
        () => options.persistSseEvidence?.({ before }) as Promise<void>,
      )
    }
    const preReleaseState = await readBarrierState("pre-release barrier state")
    if (preReleaseState.targetReleased || preReleaseState.sentinelReleased) {
      throw new Error("native Vercel black-box target released before authorization")
    }
    const pendingAfter = frames.nextMeaningfulFrame()
    const quietStartMs = nativeClockNow(options.clock, "native Vercel black-box quiet clock")
    const quietWinner = await Promise.race([
      pendingAfter.then(() => "frame" as const),
      (async () => {
        await options.clock.sleep(1_000)
        const quietEndMs = nativeClockNow(options.clock, "native Vercel black-box quiet clock")
        if (quietEndMs - quietStartMs < 1_000) {
          throw new Error(
            "native Vercel black-box pre-release quiet timer was shorter than one second",
          )
        }
        return "timer" as const
      })(),
    ])
    if (quietWinner !== "timer") {
      throw new Error("native Vercel black-box stream advanced before authorized release")
    }

    const privateHeaders = new Headers()
    options.releaseAuthorization.apply(privateHeaders)
    const authorizedRelease = await send(
      "authorized release",
      "POST",
      releasePath,
      releaseBody,
      privateHeaders,
    )
    await requireStatus(authorizedRelease, 200, "authorized release")
    const releaseOutput = recordAt(
      await readJson("authorized release", authorizedRelease),
      "native Vercel black-box authorized release",
    )
    exactKeys(releaseOutput, "native Vercel black-box authorized release", [
      "barrierId",
      "released",
    ])
    if (
      releaseOutput.barrierId !== options.ids.targetBarrierId ||
      releaseOutput.released !== true
    ) {
      throw new Error("native Vercel black-box authorized release output is incorrect")
    }
    const authorizedState = await readBarrierState("authorized barrier state")
    if (!authorizedState.targetReleased || authorizedState.sentinelReleased) {
      throw new Error("native Vercel black-box authorized release state is incorrect")
    }
    await persistDispatch("release")

    const after = await bounded("after-release frame read", () => pendingAfter)
    assertReleaseSafe("after-release SSE frame", after)
    if (options.persistSseEvidence) {
      await bounded(
        "after-release SSE evidence persistence",
        () =>
          options.persistSseEvidence?.({ after: after as NativeSseFrame, before }) as Promise<void>,
      )
    }
    const done = await bounded("done frame read", () => frames.nextMeaningfulFrame())
    assertReleaseSafe("done SSE frame", done)
    if (options.persistSseEvidence) {
      await bounded(
        "done SSE evidence persistence",
        () =>
          options.persistSseEvidence?.({
            after: after as NativeSseFrame,
            before,
            done: done as NativeSseFrame,
          }) as Promise<void>,
      )
    }
    const eof = await bounded("post-done EOF read", () => frames.nextMeaningfulFrame())
    const postRelease = assertNativePostReleaseSseFrames({
      after: after as NativeSseFrame,
      barrierId: options.ids.targetBarrierId,
      before,
      done: done as NativeSseFrame,
      eof,
    })
    if (options.persistSseEvidence) {
      await bounded(
        "SSE evidence persistence",
        () =>
          options.persistSseEvidence?.({
            after: after as NativeSseFrame,
            before,
            done: done as NativeSseFrame,
            eof: true,
          }) as Promise<void>,
      )
    }
    await persistDispatch("stream")
    streamEvidence = {
      afterFrameIndex: postRelease.afterFrameIndex,
      authorizedReleaseAfterBeforeFrame: true,
      beforeFrameIndex: before.index,
      contentType: "text/event-stream",
      doneFrameIndex: postRelease.doneFrameIndex,
      eofAfterDone: true,
      noRedirect: true,
      preReleaseQuietMs: 1_000,
      status: 200,
    }
    await persistFunctionalStage("routes", routesEvidence)
    await persistFunctionalStage("stream", streamEvidence)
  } catch (error) {
    if (streamReader) {
      const readerToCancel = streamReader
      try {
        await bounded("causal stream body cancellation", () => readerToCancel.cancel())
      } catch {
        // Preserve the already-sanitized primary failure after a bounded cleanup attempt.
      }
    } else {
      await cancelResponseBodyAfterFailure("causal stream", streamResponse)
    }
    throw error
  } finally {
    try {
      streamReader?.releaseLock()
    } catch {
      // A failed cancellation may leave the reader locked; the primary failure still owns exit.
    }
  }
  if (!streamEvidence) throw new Error("native Vercel black-box stream evidence is missing")

  await persistThread(options.ids.laterThreadId)
  const laterResponse = await send(
    "later marker request",
    "POST",
    `/threads/${options.ids.laterThreadId}/runs/wait`,
    nativeAgentRunBody("/state#agent", options.ids.logMarker),
  )
  await requireStatus(laterResponse, 200, "later marker request")
  assertNativeStateOutput(
    await readJson("later marker request", laterResponse),
    1,
    [options.ids.logMarker],
    "native Vercel black-box later marker request",
  )
  const runtimeLogs = await pollNativeVercelRuntimeLogs({
    clock: options.clock,
    deploymentId: options.deploymentId,
    logBoundary: {
      logs: async (request) => {
        const stdout = await options.logBoundary.logs(request)
        assertReleaseSafe("runtime log JSONL", stdout)
        return stdout
      },
    },
    logMarker: options.ids.logMarker,
    orgId: options.orgId,
    projectId: options.projectId,
    queryStartMs,
    ...(options.persistRuntimeLogSnapshot
      ? { persistSnapshot: options.persistRuntimeLogSnapshot }
      : {}),
  })
  if (runtimeLogs.markerOccurrences !== 1) {
    throw new Error("native Vercel black-box later log marker was not seen exactly once")
  }
  await persistDispatch("later")
  const { markerOccurrences: _markerOccurrences, ...logs } = runtimeLogs
  await persistFunctionalStage("logs", logs)

  const evidence: NativeBlackBoxEvidence = {
    laterRequest: { logMarkerSeen: true, succeeded: true },
    logs,
    middleware: {
      missingHeader401: true,
      selectiveRelease: true,
      sentinelUnreleased: true,
      wrongHeader401: true,
    },
    routes: routesEvidence,
    state: stateEvidence,
    stream: streamEvidence,
  }
  assertReleaseSafe("final functional evidence", evidence)
  return evidence
}

const NATIVE_DATABASE_CLEANUP_TABLES = [
  "public.dawn_vercel_test_barriers",
  "public.dawn_writes",
  "public.dawn_checkpoints",
  "public.dawn_threads",
] as const

type NativeDatabaseCleanupTable = (typeof NATIVE_DATABASE_CLEANUP_TABLES)[number]

const NATIVE_DATABASE_TO_REGCLASS_SQL =
  "SELECT CASE WHEN to_regclass($1) IS NULL THEN NULL ELSE $1::text END AS relation"

function nativeDatabaseDeleteSql(
  table: NativeDatabaseCleanupTable,
  column: "barrier_id" | "thread_id",
): string {
  return `DELETE FROM ${table} WHERE ${column} = $1`
}

function nativeDatabaseVerifySql(
  table: NativeDatabaseCleanupTable,
  column: "barrier_id" | "thread_id",
): string {
  return `SELECT COUNT(*)::integer AS remaining FROM ${table} WHERE ${column} = $1`
}

export async function cleanupNativeDatabase(options: {
  readonly barrierIds: readonly string[]
  readonly database: {
    readonly query: (
      request: NativeBlackBoxDatabaseRequest,
    ) => Promise<{ readonly rows: unknown[] }>
  }
  readonly persistBarrierCleaned: (barrierId: string) => Promise<void>
  readonly persistThreadCleaned: (threadId: string) => Promise<void>
  readonly threadIds: readonly string[]
}): Promise<{ readonly databaseRowsAbsent: true }> {
  const barrierIds = [...options.barrierIds]
  const threadIds = [...options.threadIds]
  for (const barrierId of barrierIds) assertBarrierId(barrierId)
  for (const threadId of threadIds) assertThreadId(threadId)
  if (new Set(barrierIds).size !== barrierIds.length) {
    throw new Error("native Vercel database cleanup barrier IDs must be unique")
  }
  if (new Set(threadIds).size !== threadIds.length) {
    throw new Error("native Vercel database cleanup thread IDs must be unique")
  }
  if (
    typeof options.database?.query !== "function" ||
    typeof options.persistBarrierCleaned !== "function" ||
    typeof options.persistThreadCleaned !== "function"
  ) {
    throw new Error("native Vercel database cleanup operations are malformed")
  }

  const failures: Error[] = []
  const query = async (sql: string, params: readonly unknown[]): Promise<readonly unknown[]> => {
    const result = await Promise.resolve().then(() =>
      options.database.query({
        params,
        sql,
        timeoutMs: NATIVE_BLACK_BOX_OPERATION_TIMEOUT_MS,
      }),
    )
    if (!result || !Array.isArray(result.rows)) {
      throw new Error("native Vercel database cleanup query result is malformed")
    }
    return result.rows
  }
  const tableState = new Map<NativeDatabaseCleanupTable, "exists" | "failed" | "missing">()
  for (const table of NATIVE_DATABASE_CLEANUP_TABLES) {
    try {
      const rows = await query(NATIVE_DATABASE_TO_REGCLASS_SQL, [table])
      if (rows.length !== 1) throw new Error("existence query returned the wrong row count")
      const row = recordAt(rows[0], "native Vercel database cleanup existence row")
      exactKeys(row, "native Vercel database cleanup existence row", ["relation"])
      if (row.relation !== null && row.relation !== table) {
        throw new Error("existence query returned a different relation")
      }
      tableState.set(table, row.relation === null ? "missing" : "exists")
    } catch {
      tableState.set(table, "failed")
      failures.push(new Error(`native Vercel database cleanup ${table} existence check failed`))
    }
  }

  const verifyAbsent = async (
    table: NativeDatabaseCleanupTable,
    column: "barrier_id" | "thread_id",
    id: string,
  ): Promise<void> => {
    const rows = await query(nativeDatabaseVerifySql(table, column), [id])
    if (rows.length !== 1) throw new Error("verification returned the wrong row count")
    const row = recordAt(rows[0], "native Vercel database cleanup verification row")
    exactKeys(row, "native Vercel database cleanup verification row", ["remaining"])
    if (!Number.isSafeInteger(row.remaining) || (row.remaining as number) !== 0) {
      throw new Error("database cleanup verification found remaining rows")
    }
  }
  const deleteAndVerify = async (
    table: NativeDatabaseCleanupTable,
    column: "barrier_id" | "thread_id",
    id: string,
    label: string,
  ): Promise<boolean> => {
    let succeeded = true
    try {
      const rows = await query(nativeDatabaseDeleteSql(table, column), [id])
      if (rows.length !== 0) throw new Error("delete returned unexpected rows")
    } catch {
      succeeded = false
      failures.push(new Error(`native Vercel database cleanup ${label} delete failed`))
    }
    try {
      await verifyAbsent(table, column, id)
    } catch {
      succeeded = false
      failures.push(new Error(`native Vercel database cleanup ${label} verification failed`))
    }
    return succeeded
  }

  const barrierTable = "public.dawn_vercel_test_barriers" as const
  for (const barrierId of barrierIds) {
    const state = tableState.get(barrierTable)
    let succeeded = state === "missing"
    if (state === "exists") {
      succeeded = await deleteAndVerify(barrierTable, "barrier_id", barrierId, "barrier")
    }
    if (succeeded) {
      try {
        await Promise.resolve().then(() => options.persistBarrierCleaned(barrierId))
      } catch {
        failures.push(new Error("native Vercel database cleanup barrier persistence failed"))
      }
    }
  }

  const threadTables = [
    "public.dawn_writes",
    "public.dawn_checkpoints",
    "public.dawn_threads",
  ] as const
  for (const threadId of threadIds) {
    let succeeded = true
    for (const table of threadTables) {
      const state = tableState.get(table)
      if (state === "failed") {
        succeeded = false
        continue
      }
      if (state === "exists") {
        const tableSucceeded = await deleteAndVerify(table, "thread_id", threadId, "thread")
        succeeded = tableSucceeded && succeeded
      }
    }
    if (succeeded) {
      try {
        await Promise.resolve().then(() => options.persistThreadCleaned(threadId))
      } catch {
        failures.push(new Error("native Vercel database cleanup thread persistence failed"))
      }
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "native Vercel database cleanup failed")
  }
  return { databaseRowsAbsent: true }
}

export async function runNativeCleanupWithPrimaryFailure(options: {
  readonly cleanupOperations: readonly {
    readonly label: string
    readonly run: () => Promise<void>
  }[]
  readonly primaryFailure?: unknown
}): Promise<void> {
  const primaryWasProvided = own(options, "primaryFailure") && options.primaryFailure !== undefined
  const primaryError = primaryWasProvided
    ? options.primaryFailure instanceof Error
      ? options.primaryFailure
      : new Error("native Vercel primary execution failed")
    : undefined
  const failures: Error[] = primaryError ? [primaryError] : []
  for (const operation of options.cleanupOperations) {
    if (!/^[a-z][a-z -]{0,63}$/.test(operation.label) || typeof operation.run !== "function") {
      throw new Error("native Vercel cleanup operation is malformed")
    }
  }
  for (const operation of options.cleanupOperations) {
    try {
      await Promise.resolve().then(operation.run)
    } catch {
      failures.push(new Error(`native Vercel ${operation.label} failed`))
    }
  }
  if (failures.length === 0) return
  throw new AggregateError(
    failures,
    "native Vercel execution or cleanup failed",
    ...(primaryError ? [{ cause: primaryError }] : []),
  )
}

export interface NativeVercelBuildLogEvidence {
  readonly events: readonly {
    readonly createdAtIso: string
    readonly text: string
  }[]
  readonly readyState: "READY"
}

export function parseNativeVercelBuildLogTranscript(options: {
  readonly deploymentId: string
  readonly stderr: string
  readonly stdout: string
}): NativeVercelBuildLogEvidence {
  const deploymentId = assertDeploymentId(options.deploymentId)
  if (options.stdout !== "") {
    throw new Error("native Vercel inspect build logs must not emit stdout")
  }
  const normalized = stripVTControlCharacters(options.stderr).replace(/\r\n?/g, "\n")
  if (!normalized.endsWith("\n")) {
    throw new Error("native Vercel inspect build log transcript must end with a newline")
  }
  const lines = normalized.slice(0, -1).split("\n")
  if (lines.length < 3) {
    throw new Error("native Vercel inspect build log transcript is incomplete")
  }
  if (lines[0] !== `Vercel CLI 58.9.0 (Node.js ${process.versions.node})`) {
    throw new Error("native Vercel inspect build log version banner is malformed")
  }
  const fetchLine = lines[1] as string
  const expectedPrefix = `Fetching deployment "${deploymentId}" in `
  const context = fetchLine.startsWith(expectedPrefix) ? fetchLine.slice(expectedPrefix.length) : ""
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(context)) {
    throw new Error("native Vercel inspect build log fetch line is malformed")
  }
  if (lines.at(-1) !== "status\t● Ready") {
    throw new Error("native Vercel inspect build log final status must be Ready")
  }
  const events: Array<{ readonly createdAtIso: string; readonly text: string }> = []
  for (const [index, line] of lines.slice(2, -1).entries()) {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) {2}(.*)$/.exec(line)
    if (!match) {
      throw new Error(`native Vercel inspect build log event ${index} is malformed`)
    }
    const createdAtIso = match[1] as string
    const text = match[2] as string
    if (
      new Date(Date.parse(createdAtIso)).toISOString() !== createdAtIso ||
      text !== text.trim() ||
      [...text].some((character) => {
        const codePoint = character.codePointAt(0)
        return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      })
    ) {
      throw new Error(`native Vercel inspect build log event ${index} is malformed`)
    }
    events.push({ createdAtIso, text })
  }
  return { events, readyState: "READY" }
}

const NATIVE_REMOTE_BUILD_SIGNATURE = [
  "Build complete: .dawn/build",
  "3 route(s) compiled",
  "targets: vercel",
  "wrote .vercel/output/config.json",
  "wrote .vercel/output/functions/index.func/.vc-config.json",
  "wrote .vercel/output/functions/index.func/index.mjs",
  "wrote vercel.json",
] as const

export function parseNativeBuildProvenance(options: {
  readonly deployCommand: {
    readonly command: "deploy"
    readonly positionalPathAbsent: true
    readonly prebuiltFlagCount: 0 | 1
  }
  readonly inspectBuildLogs: NativeVercelBuildLogEvidence
  readonly kind: "prebuilt" | "source"
  readonly localOutputValidated: boolean
  readonly protectedValues?: readonly string[]
  readonly sourceTree: {
    readonly dawnAbsent: boolean
    readonly nodeModulesAbsent: boolean
    readonly prebuiltOutputAbsent: boolean
  }
}):
  | {
      readonly cleanSource: true
      readonly prebuiltOutputAbsent: true
      readonly remoteBuildObserved: true
    }
  | {
      readonly localOutputValidated: true
      readonly prebuiltDeployObserved: true
      readonly remoteSourceBuildAbsent: true
    } {
  if (options.kind !== "source" && options.kind !== "prebuilt") {
    throw new Error("native Vercel build provenance command evidence is malformed")
  }
  const deployCommand = recordAt(
    cloneOwnJsonData(
      options.deployCommand,
      "native Vercel build provenance deploy command evidence",
    ),
    "native Vercel build provenance deploy command evidence",
  )
  exactKeys(deployCommand, "native Vercel build provenance deploy command evidence", [
    "command",
    "positionalPathAbsent",
    "prebuiltFlagCount",
  ])
  exactLiteral(
    deployCommand.command,
    "deploy",
    "native Vercel build provenance deploy command evidence.command",
  )
  exactLiteral(
    deployCommand.positionalPathAbsent,
    true,
    "native Vercel build provenance deploy command evidence.positionalPathAbsent",
  )
  if (deployCommand.prebuiltFlagCount !== 0 && deployCommand.prebuiltFlagCount !== 1) {
    throw new Error("native Vercel deploy command evidence prebuilt flag count is malformed")
  }
  const logs = recordAt(
    cloneOwnJsonData(options.inspectBuildLogs, "native Vercel inspect build log evidence"),
    "native Vercel inspect build log evidence",
  )
  exactKeys(logs, "native Vercel inspect build log evidence", ["events", "readyState"])
  exactLiteral(logs.readyState, "READY", "native Vercel inspect build log evidence.readyState")
  if (!Array.isArray(logs.events)) {
    throw new Error("native Vercel inspect build log events must be an array")
  }
  const eventTexts = logs.events.map((value, index) => {
    const event = recordAt(value, `native Vercel inspect build log event ${index}`)
    exactKeys(event, `native Vercel inspect build log event ${index}`, ["createdAtIso", "text"])
    isoTimestamp(event.createdAtIso, `native Vercel inspect build log event ${index}.createdAtIso`)
    if (typeof event.text !== "string" || event.text !== event.text.trim()) {
      throw new Error(`native Vercel inspect build log event ${index}.text is malformed`)
    }
    return event.text
  })
  createSecretRedactor(options.protectedValues ?? []).assertSafe("native Vercel build provenance", {
    deployCommand,
    inspectBuildLogs: logs,
  })
  const prebuiltFlagCount = deployCommand.prebuiltFlagCount as 0 | 1
  const signature = new Set<string>(NATIVE_REMOTE_BUILD_SIGNATURE)
  const signatureIndexes = NATIVE_REMOTE_BUILD_SIGNATURE.map((expected) =>
    eventTexts.flatMap((text, index) => (text === expected ? [index] : [])),
  )
  const exactOrderedSignature =
    signatureIndexes.every((indexes) => indexes.length === 1) &&
    signatureIndexes.every(
      (indexes, index) =>
        index === 0 || (signatureIndexes[index - 1]?.[0] as number) < (indexes[0] as number),
    )

  if (options.kind === "source") {
    if (
      prebuiltFlagCount !== 0 ||
      options.localOutputValidated !== false ||
      options.sourceTree.dawnAbsent !== true ||
      options.sourceTree.nodeModulesAbsent !== true ||
      options.sourceTree.prebuiltOutputAbsent !== true ||
      !exactOrderedSignature
    ) {
      throw new Error("native Vercel source build provenance is incomplete")
    }
    return { cleanSource: true, prebuiltOutputAbsent: true, remoteBuildObserved: true }
  }

  if (
    prebuiltFlagCount !== 1 ||
    options.localOutputValidated !== true ||
    eventTexts.some(
      (text) =>
        signature.has(text as never) ||
        /(?:dawn build|Build complete: \.dawn\/build|route\(s\) compiled|targets: vercel|wrote \.vercel\/output)/i.test(
          text,
        ),
    )
  ) {
    throw new Error("native Vercel prebuilt provenance indicates a remote source build")
  }
  return {
    localOutputValidated: true,
    prebuiltDeployObserved: true,
    remoteSourceBuildAbsent: true,
  }
}

export async function prepareNativeFixtureDeployment<
  Deployment extends {
    readonly canonicalOrigin: string
    readonly commandEvidence: NativeDeployCommandEvidence
    readonly deploymentId: string
  },
>(options: {
  readonly deploy: () => Promise<Deployment>
  readonly expectedTarballs: readonly string[]
  readonly fixtureRoot: string
  readonly kind: "prebuilt" | "source"
  readonly orgId: string
  readonly parentEnv: NodeJS.ProcessEnv
  readonly projectId: string
  readonly protectedValues: readonly string[]
  readonly runBuildChild: NativeVercelChildRunner
  readonly validateOutput: (outputRoot: string) => Promise<void>
  readonly writeDiagnostic: (name: string, contents: string) => Promise<void>
}): Promise<
  Deployment & {
    readonly localOutputValidated: boolean
    readonly sourceTree: {
      readonly dawnAbsent: boolean
      readonly nodeModulesAbsent: boolean
      readonly prebuiltOutputAbsent: boolean
    }
  }
> {
  if (options.kind !== "source" && options.kind !== "prebuilt") {
    throw new Error("native Vercel fixture preparation kind is malformed")
  }
  if (!isAbsolute(options.fixtureRoot)) {
    throw new Error("native Vercel fixture preparation root must be absolute")
  }
  const redactor = createSecretRedactor(options.protectedValues)
  const sourceTree = {
    dawnAbsent: false,
    nodeModulesAbsent: false,
    prebuiltOutputAbsent: false,
  }
  let localOutputValidated = false

  if (options.kind === "source") {
    await rm(join(options.fixtureRoot, "node_modules"), { force: true, recursive: true })
    await assertNativeFixtureUploadIsolation({
      expectedTarballs: options.expectedTarballs,
      kind: "source",
      orgId: options.orgId,
      projectId: options.projectId,
      root: options.fixtureRoot,
    })
    sourceTree.dawnAbsent = true
    sourceTree.nodeModulesAbsent = true
    sourceTree.prebuiltOutputAbsent = true
  } else {
    const executable = join(options.fixtureRoot, "node_modules", ".bin", "dawn")
    const executableStats = await lstat(executable).catch(() => {
      throw new Error("native Vercel prebuilt local Dawn executable is missing")
    })
    if (executableStats.isSymbolicLink() || !executableStats.isFile()) {
      throw new Error("native Vercel prebuilt local Dawn executable must be a regular file")
    }
    const inherited = sanitizeChildEnvironment(options.parentEnv, {})
    const env = stringEnvironment({ ...inherited, NO_UPDATE_NOTIFIER: "1" })
    let result: NativeLocalCommandResult
    try {
      result = await options.runBuildChild({
        args: ["build"],
        cwd: options.fixtureRoot,
        env,
        executable,
        timeoutMs: NATIVE_VERCEL_CHILD_TIMEOUT_MS,
      })
    } catch {
      throw new Error("native Vercel prebuilt local Dawn build transport failed")
    }
    const redactedStdout = redactor.redact(result.stdout)
    const redactedStderr = redactor.redact(result.stderr)
    const diagnostic =
      `stdout:\n${redactedStdout}${redactedStdout && !redactedStdout.endsWith("\n") ? "\n" : ""}` +
      `stderr:\n${redactedStderr}`
    redactor.assertSafe("native Vercel prebuilt local build diagnostic", diagnostic)
    try {
      await options.writeDiagnostic("prebuilt-local-build.log", diagnostic)
    } catch {
      throw new Error("native Vercel prebuilt local build diagnostic persistence failed")
    }
    if (result.exitCode !== 0) {
      throw new Error("native Vercel prebuilt local Dawn build failed")
    }
    const outputRoot = join(options.fixtureRoot, ".vercel", "output")
    try {
      await options.validateOutput(outputRoot)
    } catch {
      throw new Error("native Vercel prebuilt output validation failed")
    }
    const indexPath = join(outputRoot, "functions", "index.func", "index.mjs")
    const indexStats = await lstat(indexPath).catch(() => {
      throw new Error("native Vercel prebuilt index bundle is missing")
    })
    if (indexStats.isSymbolicLink() || !indexStats.isFile()) {
      throw new Error("native Vercel prebuilt index bundle must be a regular file")
    }
    redactor.assertSafe("native Vercel prebuilt index bundle", await readFile(indexPath, "utf8"))
    await assertNativeFixtureUploadIsolation({
      expectedTarballs: options.expectedTarballs,
      kind: "prebuilt",
      orgId: options.orgId,
      projectId: options.projectId,
      root: options.fixtureRoot,
    })
    localOutputValidated = true
  }

  let deployment: Deployment
  try {
    deployment = await options.deploy()
  } catch {
    throw new Error(`native Vercel ${options.kind} deploy attempt failed`)
  }
  assertDeploymentId(deployment.deploymentId)
  canonicalizeVercelOrigin(deployment.canonicalOrigin)
  const command = recordAt(
    cloneOwnJsonData(deployment.commandEvidence, "native Vercel deploy command evidence"),
    "native Vercel deploy command evidence",
  )
  exactKeys(command, "native Vercel deploy command evidence", [
    "command",
    "positionalPathAbsent",
    "prebuiltFlagCount",
  ])
  if (
    command.command !== "deploy" ||
    command.positionalPathAbsent !== true ||
    command.prebuiltFlagCount !== (options.kind === "prebuilt" ? 1 : 0)
  ) {
    throw new Error("native Vercel deploy command evidence does not match the fixture kind")
  }
  return { ...deployment, localOutputValidated, sourceTree }
}

export async function runNativeDeploymentKind(options: {
  readonly deployAttempt: () => Promise<{
    readonly attempt: NativeAttemptEvidence
    readonly binding: NativeDeploymentBindingEvidence
    readonly canonicalOrigin: string
    readonly commandEvidence: NativeDeployCommandEvidence
    readonly config: NativeVercelConfigEvidence
    readonly deploymentId: string
    readonly readyState: "READY"
  }>
  readonly expectedTarballs: readonly string[]
  readonly fixtureRoot: string
  readonly inspectBuildLogs: (options: { readonly deploymentId: string }) => Promise<{
    readonly evidence: NativeVercelBuildLogEvidence
    readonly redactedTranscript: string
  }>
  readonly kind: "prebuilt" | "source"
  readonly orgId: string
  readonly parentEnv: NodeJS.ProcessEnv
  readonly projectId: string
  readonly protectedValues: readonly string[]
  readonly persistStage?: (
    stage: "logs" | "provenance" | "routes" | "state" | "stream",
    evidence: unknown,
  ) => Promise<void>
  readonly reconcile: (
    attempt: NativeAttemptEvidence,
  ) => Promise<NativeMarkerReconciliationEvidence>
  readonly runBlackBox: (options: {
    readonly canonicalOrigin: string
    readonly deploymentId: string
    readonly persistStage: <Stage extends NativeFunctionalStage>(
      stage: Stage,
      evidence: NativeBlackBoxEvidence[Stage],
    ) => Promise<void>
  }) => Promise<NativeBlackBoxEvidence>
  readonly runBuildChild: NativeVercelChildRunner
  readonly validateOutput: (outputRoot: string) => Promise<void>
  readonly writeDiagnostic: (name: string, contents: string) => Promise<void>
}): Promise<Omit<VercelDeploymentReceiptV1<"prebuilt" | "source">, "cleanup">> {
  const prepared = await prepareNativeFixtureDeployment({
    deploy: options.deployAttempt,
    expectedTarballs: options.expectedTarballs,
    fixtureRoot: options.fixtureRoot,
    kind: options.kind,
    orgId: options.orgId,
    parentEnv: options.parentEnv,
    projectId: options.projectId,
    protectedValues: options.protectedValues,
    runBuildChild: options.runBuildChild,
    validateOutput: options.validateOutput,
    writeDiagnostic: options.writeDiagnostic,
  })
  const buildLogs = await options.inspectBuildLogs({ deploymentId: prepared.deploymentId })
  createSecretRedactor(options.protectedValues).assertSafe(
    "native Vercel redacted remote build log transcript",
    buildLogs.redactedTranscript,
  )
  await options.writeDiagnostic(`${options.kind}-build.log`, buildLogs.redactedTranscript)
  const provenance = parseNativeBuildProvenance({
    deployCommand: prepared.commandEvidence,
    inspectBuildLogs: buildLogs.evidence,
    kind: options.kind,
    localOutputValidated: prepared.localOutputValidated,
    protectedValues: options.protectedValues,
    sourceTree: prepared.sourceTree,
  })
  await options.persistStage?.("provenance", provenance)
  const functional = await options.runBlackBox({
    canonicalOrigin: prepared.canonicalOrigin,
    deploymentId: prepared.deploymentId,
    persistStage: async (stage, evidence) => {
      await options.persistStage?.(stage, evidence)
    },
  })
  for (const stage of ["routes", "state", "stream", "logs"] as const) {
    await options.persistStage?.(stage, functional[stage])
  }
  const reconciliation = await options.reconcile(prepared.attempt)
  if (
    reconciliation.pollIntervalMs !== 2_000 ||
    reconciliation.quietIntervalMs !== 30_000 ||
    reconciliation.expectedCardinality !== true ||
    reconciliation.deployments.length !== 1 ||
    !sameNativeBinding(
      reconciliation.deployments[0] as NativeDeploymentBindingEvidence,
      prepared.binding,
    )
  ) {
    throw new Error("native Vercel deployment reconciliation does not match the exact binding")
  }
  const evidence = {
    apiBindingVerified: true as const,
    canonicalOrigin: prepared.canonicalOrigin,
    config: prepared.config,
    deploymentId: prepared.deploymentId,
    kind: options.kind,
    ...functional,
    provenance,
    readyState: prepared.readyState,
    reconciliation: {
      apiBindingVerified: true as const,
      expectedCardinality: true as const,
      markerPersistedBeforeSpawn: prepared.attempt.spawnStarted,
    },
  }
  validateDeployment(
    { ...evidence, cleanup: { databaseRowsAbsent: true, deploymentAbsent: true } },
    options.kind,
    "native Vercel deployment evidence",
  )
  return evidence as Omit<VercelDeploymentReceiptV1<"prebuilt" | "source">, "cleanup">
}

interface NativeCleanupAttemptRecord {
  readonly additionalDeployments?: readonly {
    readonly binding: NativeDeploymentBindingEvidence
    readonly cleaned: boolean
    readonly deleteReceipt?: { readonly state: "DELETED"; readonly uid: string }
  }[]
  readonly attempt: NativeAttemptEvidence
  readonly binding?: NativeDeploymentBindingEvidence
  readonly cleaned: boolean
  readonly deleteReceipt?: { readonly state: "DELETED"; readonly uid: string }
  readonly deploymentReceipt?: {
    readonly canonicalOrigin: string
    readonly deploymentId: string
  }
  readonly reconciliation?: {
    readonly expectedCardinality: boolean
    readonly zeroLive: boolean
  }
}

const NATIVE_DIAGNOSTIC_NAMES = new Set([
  "prebuilt-build.log",
  "prebuilt-events.json",
  "prebuilt-local-build.log",
  "prebuilt-runtime.jsonl",
  "source-build.log",
  "source-events.json",
  "source-runtime.jsonl",
])

interface NativeCleanupManifest {
  readonly attempts: readonly NativeCleanupAttemptRecord[]
  readonly barriers: readonly {
    readonly barrierId: string
    readonly cleaned: boolean
    readonly kind: "prebuilt" | "source"
    readonly role: "sentinel" | "target"
  }[]
  readonly databaseRowsAbsent: boolean
  readonly projectBindingVerified: boolean
  readonly schemaVersion: 1
  readonly threads: readonly {
    readonly cleaned: boolean
    readonly kind: "prebuilt" | "source"
    readonly threadId: string
  }[]
}

type NativeIncompleteDeploymentEvidence = Readonly<Record<string, unknown>>

interface NativePartialReceipt {
  readonly cliVersion: "58.9.0"
  readonly complete: false
  readonly deployments: Partial<
    Readonly<Record<"prebuilt" | "source", NativeIncompleteDeploymentEvidence>>
  >
  readonly kinds: readonly ["source", "prebuilt"]
  readonly projectBindingVerified: boolean
  readonly schemaVersion: 1
  readonly stages: Partial<
    Readonly<
      Record<"prebuilt" | "source", Partial<Readonly<Record<NativeDeploymentStage, unknown>>>>
    >
  >
}

const NATIVE_DEPLOYMENT_STAGES = [
  "deploy",
  "config",
  "readiness",
  "provenance",
  "routes",
  "state",
  "stream",
  "logs",
] as const
type NativeDeploymentStage = (typeof NATIVE_DEPLOYMENT_STAGES)[number]

function initialNativeCleanupManifest(): NativeCleanupManifest {
  return {
    attempts: [],
    barriers: [],
    databaseRowsAbsent: false,
    projectBindingVerified: false,
    schemaVersion: 1,
    threads: [],
  }
}

function initialNativePartialReceipt(): NativePartialReceipt {
  return {
    cliVersion: "58.9.0",
    complete: false,
    deployments: {},
    kinds: ["source", "prebuilt"],
    projectBindingVerified: false,
    schemaVersion: 1,
    stages: {},
  }
}

export function parseNativeCleanupManifest(value: unknown): NativeCleanupManifest {
  try {
    const manifest = recordAt(
      cloneOwnJsonData(value, "native Vercel cleanup manifest"),
      "native Vercel cleanup manifest",
    )
    exactKeys(manifest, "native Vercel cleanup manifest", [
      "attempts",
      "barriers",
      "databaseRowsAbsent",
      "projectBindingVerified",
      "schemaVersion",
      "threads",
    ])
    exactLiteral(manifest.schemaVersion, 1, "native Vercel cleanup manifest.schemaVersion")
    if (
      typeof manifest.projectBindingVerified !== "boolean" ||
      typeof manifest.databaseRowsAbsent !== "boolean" ||
      !Array.isArray(manifest.attempts) ||
      !Array.isArray(manifest.barriers) ||
      !Array.isArray(manifest.threads)
    ) {
      throw new Error("native Vercel cleanup manifest fields are malformed")
    }
    const markers = new Set<string>()
    const deploymentIds = new Set<string>()
    const attempts = manifest.attempts.map((value, index): NativeCleanupAttemptRecord => {
      const record = recordAt(value, `native Vercel cleanup manifest.attempts[${index}]`)
      const expectedKeys = [
        "attempt",
        "cleaned",
        ...(own(record, "additionalDeployments") ? ["additionalDeployments"] : []),
        ...(own(record, "binding") ? ["binding"] : []),
        ...(own(record, "deleteReceipt") ? ["deleteReceipt"] : []),
        ...(own(record, "deploymentReceipt") ? ["deploymentReceipt"] : []),
        ...(own(record, "reconciliation") ? ["reconciliation"] : []),
      ]
      exactKeys(record, `native Vercel cleanup manifest.attempts[${index}]`, expectedKeys)
      const attempt = validateNativeAttemptEvidence(record.attempt as NativeAttemptEvidence)
      if (markers.has(attempt.marker) || typeof record.cleaned !== "boolean") {
        throw new Error("native Vercel cleanup manifest contains a duplicate or malformed attempt")
      }
      markers.add(attempt.marker)
      const deploymentReceipt = own(record, "deploymentReceipt")
        ? (() => {
            const receipt = recordAt(
              record.deploymentReceipt,
              `native Vercel cleanup manifest.attempts[${index}].deploymentReceipt`,
            )
            exactKeys(
              receipt,
              `native Vercel cleanup manifest.attempts[${index}].deploymentReceipt`,
              ["canonicalOrigin", "deploymentId"],
            )
            if (
              typeof receipt.deploymentId !== "string" ||
              typeof receipt.canonicalOrigin !== "string"
            ) {
              throw new Error("native Vercel cleanup manifest deployment receipt is malformed")
            }
            const value = {
              canonicalOrigin: canonicalizeVercelOrigin(receipt.canonicalOrigin),
              deploymentId: assertDeploymentId(receipt.deploymentId),
            }
            if (deploymentIds.has(value.deploymentId)) {
              throw new Error("native Vercel cleanup manifest contains a duplicate deployment")
            }
            deploymentIds.add(value.deploymentId)
            return value
          })()
        : undefined
      const binding = own(record, "binding")
        ? validateNativeBindingEvidence(
            record.binding as NativeDeploymentBindingEvidence,
            deploymentReceipt?.deploymentId,
          )
        : undefined
      if (binding && binding.marker !== attempt.marker) {
        throw new Error("native Vercel cleanup manifest binding marker conflicts with its attempt")
      }
      if (binding && !deploymentReceipt) {
        if (deploymentIds.has(binding.deploymentId)) {
          throw new Error("native Vercel cleanup manifest contains a duplicate deployment")
        }
        deploymentIds.add(binding.deploymentId)
      }
      const deploymentId = deploymentReceipt?.deploymentId ?? binding?.deploymentId
      const reconciliation = own(record, "reconciliation")
        ? (() => {
            const proof = recordAt(
              record.reconciliation,
              `native Vercel cleanup manifest.attempts[${index}].reconciliation`,
            )
            exactKeys(proof, `native Vercel cleanup manifest.attempts[${index}].reconciliation`, [
              "expectedCardinality",
              "zeroLive",
            ])
            if (
              typeof proof.expectedCardinality !== "boolean" ||
              typeof proof.zeroLive !== "boolean" ||
              (!proof.expectedCardinality && proof.zeroLive) ||
              (proof.zeroLive && deploymentId !== undefined)
            ) {
              throw new Error("native Vercel cleanup reconciliation proof is malformed")
            }
            return {
              expectedCardinality: proof.expectedCardinality,
              zeroLive: proof.zeroLive,
            }
          })()
        : undefined
      if (
        deploymentReceipt &&
        binding &&
        (deploymentReceipt.deploymentId !== binding.deploymentId ||
          deploymentReceipt.canonicalOrigin !== binding.canonicalOrigin)
      ) {
        throw new Error("native Vercel cleanup manifest receipt conflicts with its binding")
      }
      const deleteReceipt = own(record, "deleteReceipt")
        ? (() => {
            if (!deploymentId) {
              throw new Error("native Vercel cleanup manifest delete receipt lacks a deployment")
            }
            return validateNativeDeleteReceipt(
              record.deleteReceipt as { readonly state: "DELETED"; readonly uid: string },
              deploymentId,
            )
          })()
        : undefined
      if (
        record.cleaned === true &&
        (!deploymentId || (!binding && !deleteReceipt)) &&
        reconciliation?.zeroLive !== true
      ) {
        throw new Error("native Vercel cleanup manifest cleaned attempt lacks absence authority")
      }
      const additionalDeployments = own(record, "additionalDeployments")
        ? (() => {
            if (!Array.isArray(record.additionalDeployments)) {
              throw new Error("native Vercel cleanup manifest additional deployments are malformed")
            }
            return record.additionalDeployments.map((value, additionalIndex) => {
              const additional = recordAt(
                value,
                `native Vercel cleanup manifest.attempts[${index}].additionalDeployments[${additionalIndex}]`,
              )
              exactKeys(additional, "native Vercel cleanup manifest additional deployment", [
                "binding",
                "cleaned",
                ...(own(additional, "deleteReceipt") ? ["deleteReceipt"] : []),
              ])
              const additionalBinding = validateNativeBindingEvidence(
                additional.binding as NativeDeploymentBindingEvidence,
              )
              if (
                additionalBinding.marker !== attempt.marker ||
                typeof additional.cleaned !== "boolean" ||
                deploymentIds.has(additionalBinding.deploymentId)
              ) {
                throw new Error("native Vercel cleanup manifest additional deployment conflicts")
              }
              deploymentIds.add(additionalBinding.deploymentId)
              const additionalDeleteReceipt = own(additional, "deleteReceipt")
                ? validateNativeDeleteReceipt(
                    additional.deleteReceipt as { readonly state: "DELETED"; readonly uid: string },
                    additionalBinding.deploymentId,
                  )
                : undefined
              return {
                binding: additionalBinding,
                cleaned: additional.cleaned,
                ...(additionalDeleteReceipt ? { deleteReceipt: additionalDeleteReceipt } : {}),
              }
            })
          })()
        : undefined
      if (reconciliation?.zeroLive && additionalDeployments && additionalDeployments.length > 0) {
        throw new Error("native Vercel cleanup zero-live proof conflicts with a deployment")
      }
      return {
        ...(additionalDeployments ? { additionalDeployments } : {}),
        attempt,
        ...(binding ? { binding } : {}),
        cleaned: record.cleaned,
        ...(deleteReceipt ? { deleteReceipt } : {}),
        ...(deploymentReceipt ? { deploymentReceipt } : {}),
        ...(reconciliation ? { reconciliation } : {}),
      }
    })
    const barrierIds = new Set<string>()
    const barriers = manifest.barriers.map((value, index) => {
      const record = recordAt(value, `native Vercel cleanup manifest.barriers[${index}]`)
      exactKeys(record, `native Vercel cleanup manifest.barriers[${index}]`, [
        "barrierId",
        "cleaned",
        "kind",
        "role",
      ])
      if (
        typeof record.barrierId !== "string" ||
        (record.kind !== "source" && record.kind !== "prebuilt") ||
        (record.role !== "target" && record.role !== "sentinel") ||
        typeof record.cleaned !== "boolean"
      ) {
        throw new Error("native Vercel cleanup manifest barrier is malformed")
      }
      const barrierId = assertBarrierId(record.barrierId)
      if (barrierIds.has(barrierId)) {
        throw new Error("native Vercel cleanup manifest contains a duplicate barrier")
      }
      barrierIds.add(barrierId)
      return {
        barrierId,
        cleaned: record.cleaned,
        kind: record.kind as "prebuilt" | "source",
        role: record.role as "sentinel" | "target",
      }
    })
    const threadIds = new Set<string>()
    const threads = manifest.threads.map((value, index) => {
      const record = recordAt(value, `native Vercel cleanup manifest.threads[${index}]`)
      exactKeys(record, `native Vercel cleanup manifest.threads[${index}]`, [
        "cleaned",
        "kind",
        "threadId",
      ])
      if (
        typeof record.threadId !== "string" ||
        (record.kind !== "source" && record.kind !== "prebuilt") ||
        typeof record.cleaned !== "boolean"
      ) {
        throw new Error("native Vercel cleanup manifest thread is malformed")
      }
      const threadId = assertThreadId(record.threadId)
      if (threadIds.has(threadId)) {
        throw new Error("native Vercel cleanup manifest contains a duplicate thread")
      }
      threadIds.add(threadId)
      return {
        cleaned: record.cleaned,
        kind: record.kind as "prebuilt" | "source",
        threadId,
      }
    })
    return {
      attempts,
      barriers,
      databaseRowsAbsent: manifest.databaseRowsAbsent,
      projectBindingVerified: manifest.projectBindingVerified,
      schemaVersion: 1,
      threads,
    }
  } catch (error) {
    throw new Error("native Vercel cleanup manifest is invalid", { cause: error })
  }
}

function parseNativePartialReceipt(value: unknown): NativePartialReceipt {
  const partial = recordAt(
    cloneOwnJsonData(value, "native Vercel partial receipt"),
    "native Vercel partial receipt",
  )
  exactKeys(partial, "native Vercel partial receipt", [
    "cliVersion",
    "complete",
    "deployments",
    "kinds",
    "projectBindingVerified",
    "schemaVersion",
    "stages",
  ])
  exactLiteral(partial.schemaVersion, 1, "native Vercel partial receipt.schemaVersion")
  exactLiteral(partial.cliVersion, "58.9.0", "native Vercel partial receipt.cliVersion")
  exactLiteral(partial.complete, false, "native Vercel partial receipt.complete")
  exactTuple(partial.kinds, ["source", "prebuilt"], "native Vercel partial receipt.kinds")
  if (typeof partial.projectBindingVerified !== "boolean") {
    throw new Error("native Vercel partial receipt project binding is malformed")
  }
  const deployments = recordAt(partial.deployments, "native Vercel partial receipt.deployments")
  const keys = Object.keys(deployments)
  if (keys.some((key) => key !== "source" && key !== "prebuilt")) {
    throw new Error("native Vercel partial receipt has an unknown deployment kind")
  }
  for (const kind of keys as Array<"prebuilt" | "source">) {
    validateDeployment(
      {
        ...recordAt(deployments[kind], `native Vercel partial receipt.${kind}`),
        cleanup: { databaseRowsAbsent: true, deploymentAbsent: true },
      },
      kind,
      `native Vercel partial receipt.${kind}`,
    )
  }
  const stages = recordAt(partial.stages, "native Vercel partial receipt.stages")
  for (const [kind, value] of Object.entries(stages)) {
    if (kind !== "source" && kind !== "prebuilt") {
      throw new Error("native Vercel partial receipt has an unknown staged kind")
    }
    const stagedKind = recordAt(value, `native Vercel partial receipt.stages.${kind}`)
    for (const [stage, evidence] of Object.entries(stagedKind)) {
      if (!(NATIVE_DEPLOYMENT_STAGES as readonly string[]).includes(stage)) {
        throw new Error("native Vercel partial receipt has an unknown deployment stage")
      }
      assertPlainJsonValue(evidence, `native Vercel partial receipt.stages.${kind}.${stage}`)
    }
  }
  return partial as unknown as NativePartialReceipt
}

export interface NativeEvidenceStore {
  readonly artifactDir: string
  readonly finalizeReceipt: () => Promise<VercelNativeReceiptV1>
  readonly persistAttempt: (attempt: NativeAttemptEvidence) => Promise<void>
  readonly persistBarrier: (record: {
    readonly barrierId: string
    readonly kind: "prebuilt" | "source"
    readonly role: "sentinel" | "target"
  }) => Promise<void>
  readonly persistBarrierCleaned: (barrierId: string) => Promise<void>
  readonly persistDatabaseRowsAbsent: () => Promise<void>
  readonly persistDeleteReceipt: (receipt: {
    readonly state: "DELETED"
    readonly uid: string
  }) => Promise<void>
  readonly persistDeploymentBinding: (
    marker: string,
    binding: NativeDeploymentBindingEvidence,
  ) => Promise<void>
  readonly persistDeploymentAbsent: (deploymentId: string) => Promise<void>
  readonly persistDeploymentCleaned: (
    deploymentId: string,
    receipt: { readonly state: "DELETED"; readonly uid: string },
  ) => Promise<void>
  readonly persistDeploymentEvidence: (
    kind: "prebuilt" | "source",
    evidence: NativeIncompleteDeploymentEvidence,
  ) => Promise<void>
  readonly persistDeploymentStage: (
    kind: "prebuilt" | "source",
    stage: NativeDeploymentStage,
    evidence: unknown,
  ) => Promise<void>
  readonly persistDeploymentReceipt: (
    marker: string,
    receipt: { readonly canonicalOrigin: string; readonly deploymentId: string },
  ) => Promise<void>
  readonly persistProjectBindingVerified: () => Promise<void>
  readonly persistReconciliation: (
    marker: string,
    proof: { readonly expectedCardinality: boolean; readonly zeroLive: boolean },
  ) => Promise<void>
  readonly persistThread: (record: {
    readonly kind: "prebuilt" | "source"
    readonly threadId: string
  }) => Promise<void>
  readonly persistThreadCleaned: (threadId: string) => Promise<void>
  readonly readManifest: () => NativeCleanupManifest
  readonly writeDiagnostic: (name: string, contents: string) => Promise<void>
}

export async function createNativeEvidenceStore(options: {
  readonly artifactDir: string
  readonly atomicJsonOps?: AtomicJsonFileOps
  readonly protectedValues: readonly string[]
}): Promise<NativeEvidenceStore> {
  if (!isAbsolute(options.artifactDir)) {
    throw new Error("native Vercel artifact directory must be absolute")
  }
  await mkdir(options.artifactDir, { mode: 0o700, recursive: true })
  const artifactStats = await lstat(options.artifactDir)
  if (artifactStats.isSymbolicLink() || !artifactStats.isDirectory()) {
    throw new Error("native Vercel artifact directory must be a regular non-symlink directory")
  }
  const fileOps = options.atomicJsonOps ?? DEFAULT_ATOMIC_JSON_FILE_OPS
  const manifestPath = join(options.artifactDir, "cleanup-manifest.json")
  const partialPath = join(options.artifactDir, "receipt.partial.json")
  const finalPath = join(options.artifactDir, "receipt.json")
  const historyPath = join(options.artifactDir, "cleanup-history.json")
  const redactor = createSecretRedactor(options.protectedValues)
  const readJsonIfPresent = async (path: string): Promise<unknown | undefined> => {
    try {
      const stats = await lstat(path)
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error("native Vercel control evidence must be a regular non-symlink file")
      }
      return JSON.parse(await readFile(path, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }
  const existingManifest = options.atomicJsonOps ? undefined : await readJsonIfPresent(manifestPath)
  const existingPartial = options.atomicJsonOps ? undefined : await readJsonIfPresent(partialPath)
  let manifest = existingManifest
    ? parseNativeCleanupManifest(existingManifest)
    : initialNativeCleanupManifest()
  let partial = existingPartial
    ? parseNativePartialReceipt(existingPartial)
    : initialNativePartialReceipt()
  redactor.assertSafe("native Vercel existing cleanup manifest", manifest)
  redactor.assertSafe("native Vercel existing partial receipt", partial)
  if (!existingManifest) await writeAtomicJson(manifestPath, manifest, fileOps)
  if (!existingPartial) await writeAtomicJson(partialPath, partial, fileOps)
  const existingHistory = options.atomicJsonOps ? undefined : await readJsonIfPresent(historyPath)
  if (
    existingHistory !== undefined &&
    (!Array.isArray(existingHistory) || existingHistory.length === 0)
  ) {
    throw new Error("native Vercel cleanup history must be a nonempty array")
  }
  let cleanupHistory: NativeCleanupManifest[] = Array.isArray(existingHistory)
    ? existingHistory.map(parseNativeCleanupManifest)
    : [manifest]
  redactor.assertSafe("native Vercel existing cleanup history", cleanupHistory)
  const assertHistoryTransition = (
    previous: NativeCleanupManifest,
    next: NativeCleanupManifest,
  ): void => {
    if (
      (previous.projectBindingVerified && !next.projectBindingVerified) ||
      (previous.databaseRowsAbsent && !next.databaseRowsAbsent)
    ) {
      throw new Error("native Vercel cleanup history regresses a verified postcondition")
    }
    const assertRecords = <T extends { readonly cleaned: boolean }>(
      earlier: readonly T[],
      later: readonly T[],
      identity: (record: T) => string,
    ): void => {
      const laterById = new Map(later.map((record) => [identity(record), record]))
      for (const record of earlier) {
        const current = laterById.get(identity(record))
        if (!current || (record.cleaned && !current.cleaned)) {
          throw new Error("native Vercel cleanup history deletes or regresses a resource")
        }
      }
    }
    assertRecords(previous.threads, next.threads, ({ threadId }) => threadId)
    assertRecords(previous.barriers, next.barriers, ({ barrierId }) => barrierId)
    assertRecords(previous.attempts, next.attempts, ({ attempt }) => attempt.marker)
    const nextAttempts = new Map(next.attempts.map((record) => [record.attempt.marker, record]))
    for (const earlier of previous.attempts) {
      const later = nextAttempts.get(earlier.attempt.marker)
      if (
        earlier.reconciliation?.expectedCardinality === false &&
        later?.reconciliation?.expectedCardinality !== false
      ) {
        throw new Error("native Vercel cleanup history erases a cardinality violation")
      }
    }
  }
  for (let index = 1; index < cleanupHistory.length; index += 1) {
    assertHistoryTransition(
      cleanupHistory[index - 1] as NativeCleanupManifest,
      cleanupHistory[index] as NativeCleanupManifest,
    )
  }
  if (!existingHistory) {
    await writeAtomicJson(historyPath, cleanupHistory, fileOps)
  } else if (JSON.stringify(cleanupHistory.at(-1)) !== JSON.stringify(manifest)) {
    assertHistoryTransition(cleanupHistory.at(-1) as NativeCleanupManifest, manifest)
    cleanupHistory = [...cleanupHistory, manifest]
    await writeAtomicJson(historyPath, cleanupHistory, fileOps)
  }

  const persistManifest = async (next: NativeCleanupManifest): Promise<void> => {
    const validated = parseNativeCleanupManifest(next)
    redactor.assertSafe("native Vercel cleanup manifest", validated)
    assertHistoryTransition(manifest, validated)
    const previousManifest = manifest
    await writeAtomicJson(manifestPath, validated, fileOps)
    manifest = validated
    let nextHistory = cleanupHistory
    if (JSON.stringify(nextHistory.at(-1)) !== JSON.stringify(previousManifest)) {
      nextHistory = [...nextHistory, previousManifest]
    }
    if (JSON.stringify(nextHistory.at(-1)) !== JSON.stringify(validated)) {
      nextHistory = [...nextHistory, validated]
    }
    await writeAtomicJson(historyPath, nextHistory, fileOps)
    cleanupHistory = nextHistory
  }
  const persistPartial = async (next: NativePartialReceipt): Promise<void> => {
    const validated = parseNativePartialReceipt(next)
    redactor.assertSafe("native Vercel partial receipt", validated)
    await writeAtomicJson(partialPath, validated, fileOps)
    partial = validated
  }
  const findAttempt = (marker: string): number => {
    assertReconciliationMarker(marker)
    const index = manifest.attempts.findIndex(({ attempt }) => attempt.marker === marker)
    if (index < 0) throw new Error("native Vercel cleanup manifest attempt is missing")
    return index
  }
  const updateAttempt = async (
    marker: string,
    update: (record: NativeCleanupAttemptRecord) => NativeCleanupAttemptRecord,
  ): Promise<void> => {
    const index = findAttempt(marker)
    const attempts = [...manifest.attempts]
    attempts[index] = update(attempts[index] as NativeCleanupAttemptRecord)
    await persistManifest({ ...manifest, attempts })
  }

  const store: NativeEvidenceStore = {
    artifactDir: options.artifactDir,
    finalizeReceipt: async () => {
      if (
        !manifest.projectBindingVerified ||
        !manifest.databaseRowsAbsent ||
        manifest.attempts.some(({ cleaned }) => !cleaned) ||
        manifest.attempts.some(({ additionalDeployments }) =>
          additionalDeployments?.some(({ cleaned }) => !cleaned),
        ) ||
        manifest.attempts.some(({ reconciliation }) => !reconciliation?.expectedCardinality) ||
        manifest.barriers.some(({ cleaned }) => !cleaned) ||
        manifest.threads.some(({ cleaned }) => !cleaned) ||
        !partial.deployments.source ||
        !partial.deployments.prebuilt
      ) {
        throw new Error(
          "native Vercel final receipt cannot close while evidence or cleanup is dirty",
        )
      }
      const receipt = parseNativeReceipt({
        cliVersion: "58.9.0",
        deployments: [
          {
            ...partial.deployments.source,
            cleanup: { databaseRowsAbsent: true, deploymentAbsent: true },
          },
          {
            ...partial.deployments.prebuilt,
            cleanup: { databaseRowsAbsent: true, deploymentAbsent: true },
          },
        ],
        kinds: ["source", "prebuilt"],
        projectBindingVerified: true,
        schemaVersion: 1,
      })
      redactor.assertSafe("native Vercel final receipt", receipt)
      await writeAtomicJson(finalPath, receipt, fileOps)
      return receipt
    },
    persistAttempt: async (attempt) => {
      const validated = validateNativeAttemptEvidence(attempt)
      if (manifest.attempts.some(({ attempt }) => attempt.marker === validated.marker)) {
        throw new Error("native Vercel cleanup manifest contains a duplicate attempt")
      }
      await persistManifest({
        ...manifest,
        attempts: [...manifest.attempts, { attempt: validated, cleaned: false }],
      })
    },
    persistBarrier: async (record) => {
      const barrierId = assertBarrierId(record.barrierId)
      if (
        (record.kind !== "source" && record.kind !== "prebuilt") ||
        (record.role !== "target" && record.role !== "sentinel") ||
        manifest.barriers.some((entry) => entry.barrierId === barrierId)
      ) {
        throw new Error("native Vercel cleanup manifest barrier is duplicate or malformed")
      }
      await persistManifest({
        ...manifest,
        barriers: [...manifest.barriers, { ...record, barrierId, cleaned: false }],
      })
    },
    persistBarrierCleaned: async (barrierId) => {
      assertBarrierId(barrierId)
      if (!manifest.barriers.some((entry) => entry.barrierId === barrierId)) {
        throw new Error("native Vercel cleanup manifest barrier is missing")
      }
      await persistManifest({
        ...manifest,
        barriers: manifest.barriers.map((entry) =>
          entry.barrierId === barrierId ? { ...entry, cleaned: true } : entry,
        ),
      })
    },
    persistDatabaseRowsAbsent: async () =>
      persistManifest({ ...manifest, databaseRowsAbsent: true }),
    persistDeleteReceipt: async (receipt) => {
      const deploymentId = assertDeploymentId(receipt.uid)
      const target = manifest.attempts.find(
        (entry) =>
          entry.binding?.deploymentId === deploymentId ||
          entry.deploymentReceipt?.deploymentId === deploymentId ||
          entry.additionalDeployments?.some(({ binding }) => binding.deploymentId === deploymentId),
      )
      if (!target) throw new Error("native Vercel cleanup deployment is missing")
      const validated = validateNativeDeleteReceipt(receipt, deploymentId)
      await updateAttempt(target.attempt.marker, (entry) =>
        entry.binding?.deploymentId === deploymentId ||
        entry.deploymentReceipt?.deploymentId === deploymentId
          ? { ...entry, deleteReceipt: validated }
          : {
              ...entry,
              ...(entry.additionalDeployments
                ? {
                    additionalDeployments: entry.additionalDeployments.map((additional) =>
                      additional.binding.deploymentId === deploymentId
                        ? { ...additional, deleteReceipt: validated }
                        : additional,
                    ),
                  }
                : {}),
            },
      )
    },
    persistDeploymentBinding: async (marker, binding) => {
      const validated = validateNativeBindingEvidence(binding)
      if (validated.marker !== marker) {
        throw new Error("native Vercel cleanup binding marker conflicts with its attempt")
      }
      await updateAttempt(marker, (entry) => {
        if (
          entry.additionalDeployments?.some(({ binding }) => sameNativeBinding(binding, validated))
        ) {
          return entry
        }
        if (!entry.binding) {
          if (
            entry.deploymentReceipt &&
            entry.deploymentReceipt.deploymentId !== validated.deploymentId
          ) {
            return {
              ...entry,
              additionalDeployments: [
                ...(entry.additionalDeployments ?? []),
                { binding: validated, cleaned: false },
              ],
            }
          }
          return { ...entry, binding: validated }
        }
        if (sameNativeBinding(entry.binding, validated)) return entry
        return {
          ...entry,
          additionalDeployments: [
            ...(entry.additionalDeployments ?? []),
            { binding: validated, cleaned: false },
          ],
        }
      })
    },
    persistDeploymentAbsent: async (deploymentId) => {
      assertDeploymentId(deploymentId)
      const target = manifest.attempts.find(
        (entry) =>
          entry.binding?.deploymentId === deploymentId ||
          entry.deploymentReceipt?.deploymentId === deploymentId ||
          entry.additionalDeployments?.some(({ binding }) => binding.deploymentId === deploymentId),
      )
      if (!target) {
        throw new Error("native Vercel cleanup deployment absence lacks authority")
      }
      await updateAttempt(target.attempt.marker, (entry) =>
        entry.binding?.deploymentId === deploymentId ||
        entry.deploymentReceipt?.deploymentId === deploymentId
          ? { ...entry, cleaned: true }
          : {
              ...entry,
              ...(entry.additionalDeployments
                ? {
                    additionalDeployments: entry.additionalDeployments.map((additional) =>
                      additional.binding.deploymentId === deploymentId
                        ? { ...additional, cleaned: true }
                        : additional,
                    ),
                  }
                : {}),
            },
      )
    },
    persistDeploymentCleaned: async (deploymentId, receipt) => {
      assertDeploymentId(deploymentId)
      const validated = validateNativeDeleteReceipt(receipt, deploymentId)
      const target = manifest.attempts.find(
        (entry) =>
          entry.binding?.deploymentId === deploymentId ||
          entry.deploymentReceipt?.deploymentId === deploymentId ||
          entry.additionalDeployments?.some(({ binding }) => binding.deploymentId === deploymentId),
      )
      if (!target) throw new Error("native Vercel cleanup deployment is missing")
      await updateAttempt(target.attempt.marker, (entry) =>
        entry.binding?.deploymentId === deploymentId ||
        entry.deploymentReceipt?.deploymentId === deploymentId
          ? { ...entry, cleaned: true, deleteReceipt: validated }
          : {
              ...entry,
              ...(entry.additionalDeployments
                ? {
                    additionalDeployments: entry.additionalDeployments.map((additional) =>
                      additional.binding.deploymentId === deploymentId
                        ? { ...additional, cleaned: true, deleteReceipt: validated }
                        : additional,
                    ),
                  }
                : {}),
            },
      )
    },
    persistDeploymentEvidence: async (kind, evidence) => {
      validateDeployment(
        {
          ...recordAt(evidence, "native Vercel deployment evidence"),
          cleanup: { databaseRowsAbsent: true, deploymentAbsent: true },
        },
        kind,
        "native Vercel deployment evidence",
      )
      await persistPartial({
        ...partial,
        deployments: { ...partial.deployments, [kind]: evidence },
      })
    },
    persistDeploymentStage: async (kind, stage, evidence) => {
      if (
        (kind !== "source" && kind !== "prebuilt") ||
        !(NATIVE_DEPLOYMENT_STAGES as readonly string[]).includes(stage)
      ) {
        throw new Error("native Vercel deployment stage is malformed")
      }
      const cloned = cloneOwnJsonData(evidence, `native Vercel ${kind} ${stage} evidence`)
      assertPlainJsonValue(cloned, `native Vercel ${kind} ${stage} evidence`)
      const existingStages = partial.stages[kind]
      if (existingStages && Object.hasOwn(existingStages, stage)) {
        if (JSON.stringify(existingStages[stage]) !== JSON.stringify(cloned)) {
          throw new Error("native Vercel deployment stage conflicts with persisted evidence")
        }
        return
      }
      await persistPartial({
        ...partial,
        stages: {
          ...partial.stages,
          [kind]: { ...partial.stages[kind], [stage]: cloned },
        },
      })
    },
    persistDeploymentReceipt: async (marker, receipt) => {
      const validated = {
        canonicalOrigin: canonicalizeVercelOrigin(receipt.canonicalOrigin),
        deploymentId: assertDeploymentId(receipt.deploymentId),
      }
      await updateAttempt(marker, (entry) => {
        if (
          entry.deploymentReceipt &&
          (entry.deploymentReceipt.deploymentId !== validated.deploymentId ||
            entry.deploymentReceipt.canonicalOrigin !== validated.canonicalOrigin)
        ) {
          throw new Error(
            "native Vercel cleanup deployment receipt conflicts with persisted evidence",
          )
        }
        return { ...entry, deploymentReceipt: validated }
      })
    },
    persistProjectBindingVerified: async () => {
      await persistManifest({ ...manifest, projectBindingVerified: true })
      await persistPartial({ ...partial, projectBindingVerified: true })
    },
    persistReconciliation: async (marker, proof) => {
      if (
        typeof proof.expectedCardinality !== "boolean" ||
        typeof proof.zeroLive !== "boolean" ||
        (!proof.expectedCardinality && proof.zeroLive)
      ) {
        throw new Error("native Vercel reconciliation proof is malformed")
      }
      await updateAttempt(marker, (entry) => {
        const expectedCardinality =
          entry.reconciliation?.expectedCardinality === false ? false : proof.expectedCardinality
        const hasDeployment = Boolean(
          entry.binding || entry.deploymentReceipt || entry.additionalDeployments?.length,
        )
        const zeroLive = expectedCardinality && proof.zeroLive && !hasDeployment
        return {
          ...entry,
          ...(zeroLive ? { cleaned: true } : {}),
          reconciliation: { expectedCardinality, zeroLive },
        }
      })
    },
    persistThread: async (record) => {
      const threadId = assertThreadId(record.threadId)
      if (
        (record.kind !== "source" && record.kind !== "prebuilt") ||
        manifest.threads.some((entry) => entry.threadId === threadId)
      ) {
        throw new Error("native Vercel cleanup manifest thread is duplicate or conflicting")
      }
      await persistManifest({
        ...manifest,
        threads: [...manifest.threads, { cleaned: false, kind: record.kind, threadId }],
      })
    },
    persistThreadCleaned: async (threadId) => {
      assertThreadId(threadId)
      if (!manifest.threads.some((entry) => entry.threadId === threadId)) {
        throw new Error("native Vercel cleanup manifest thread is missing")
      }
      await persistManifest({
        ...manifest,
        threads: manifest.threads.map((entry) =>
          entry.threadId === threadId ? { ...entry, cleaned: true } : entry,
        ),
      })
    },
    readManifest: () => parseNativeCleanupManifest(manifest),
    writeDiagnostic: async (name, contents) => {
      if (!NATIVE_DIAGNOSTIC_NAMES.has(name)) {
        throw new Error("native Vercel diagnostic path is unsafe")
      }
      const redacted = redactor.redact(contents)
      redactor.assertSafe(`native Vercel diagnostic ${name}`, redacted)
      const target = join(options.artifactDir, name)
      try {
        const existing = await lstat(target)
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw new Error("native Vercel diagnostic target must be a regular non-symlink file")
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      const tempPath = join(
        options.artifactDir,
        `.${name}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
      )
      try {
        await writeFile(tempPath, redacted, { encoding: "utf8", flag: "wx", mode: 0o600 })
        await rename(tempPath, target)
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined)
        throw error
      }
    },
  }
  return store
}

const NATIVE_UPLOAD_ARTIFACT_NAMES = [
  "cleanup-history.json",
  "cleanup-manifest.json",
  "prebuilt-build.log",
  "prebuilt-events.json",
  "prebuilt-local-build.log",
  "prebuilt-runtime.jsonl",
  "receipt.json",
  "receipt.partial.json",
  "source-build.log",
  "source-events.json",
  "source-runtime.jsonl",
  "vitest.json",
] as const

export async function prepareNativeArtifactUpload(options: {
  readonly artifactDir: string
  readonly protectedValues: readonly string[]
}): Promise<{ readonly files: string[]; readonly uploadDir: string }> {
  if (!isAbsolute(options.artifactDir)) {
    throw new Error("native Vercel artifact upload directory must be absolute")
  }
  const rootStats = await lstat(options.artifactDir)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("native Vercel artifact upload root must be a regular directory")
  }
  const redactor = createSecretRedactor(options.protectedValues)
  const files: string[] = []
  for (const name of NATIVE_UPLOAD_ARTIFACT_NAMES) {
    const path = join(options.artifactDir, name)
    let stats: Awaited<ReturnType<typeof lstat>>
    try {
      stats = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`native Vercel artifact ${name} must be a regular non-symlink file`)
    }
    const contents = await readFile(path, "utf8")
    redactor.assertSafe(`native Vercel artifact upload ${name}`, contents)
    files.push(name)
  }
  files.sort()
  const uploadDir = join(options.artifactDir, "upload")
  await rm(uploadDir, { force: true, recursive: true })
  await mkdir(uploadDir, { mode: 0o700 })
  for (const name of files) await copyFile(join(options.artifactDir, name), join(uploadDir, name))
  return { files, uploadDir }
}

export async function cleanupNativeEvidenceStore(options: {
  readonly apiClient: NativeVercelApiClient
  readonly clock: NativeClock
  readonly database: ReturnType<typeof createNativeBoundedDatabase>
  readonly orgId: string
  readonly projectId: string
  readonly store: NativeEvidenceStore
}): Promise<{ readonly databaseRowsAbsent: true; readonly deploymentAbsent: true }> {
  const failures: Error[] = []
  let deploymentAbsent = true
  for (const initialRecord of options.store.readManifest().attempts) {
    if (
      initialRecord.cleaned &&
      !initialRecord.additionalDeployments?.some(({ cleaned }) => !cleaned)
    ) {
      continue
    }
    try {
      const reconciliation = await reconcileNativeMarker({
        apiClient: options.apiClient,
        attempt: initialRecord.attempt,
        clock: options.clock,
        orgId: options.orgId,
        persistDeploymentBinding: (binding) =>
          options.store.persistDeploymentBinding(initialRecord.attempt.marker, binding),
        projectId: options.projectId,
      })
      await options.store.persistReconciliation(initialRecord.attempt.marker, {
        expectedCardinality: reconciliation.expectedCardinality,
        zeroLive: reconciliation.deployments.length === 0,
      })
      const current = options.store
        .readManifest()
        .attempts.find(({ attempt }) => attempt.marker === initialRecord.attempt.marker)
      if (!current) throw new Error("reconciled native Vercel cleanup attempt disappeared")
      const deploymentId = current.cleaned
        ? undefined
        : (current.deploymentReceipt?.deploymentId ?? current.binding?.deploymentId)
      const manifestRecords: NativeDeploymentCleanupRecord[] = deploymentId
        ? [
            {
              ...(current.binding ? { binding: current.binding } : {}),
              ...(current.deleteReceipt ? { deleteReceipt: current.deleteReceipt } : {}),
              deploymentId,
            },
          ]
        : []
      for (const additional of current.additionalDeployments?.filter(({ cleaned }) => !cleaned) ??
        []) {
        manifestRecords.push({
          binding: additional.binding,
          ...(additional.deleteReceipt ? { deleteReceipt: additional.deleteReceipt } : {}),
          deploymentId: additional.binding.deploymentId,
        })
      }
      await cleanupNativeDeployments({
        apiClient: options.apiClient,
        clock: options.clock,
        manifest: manifestRecords,
        orgId: options.orgId,
        persistDeleteReceipt: options.store.persistDeleteReceipt,
        persistDeploymentAbsent: options.store.persistDeploymentAbsent,
        projectId: options.projectId,
        reconciliation,
      })
    } catch {
      deploymentAbsent = false
      failures.push(new Error("native Vercel shared deployment cleanup failed"))
    }
  }

  if (
    options.store
      .readManifest()
      .attempts.some(({ reconciliation }) => reconciliation?.expectedCardinality === false)
  ) {
    deploymentAbsent = false
    failures.push(new Error("native Vercel cleanup retained a marker cardinality violation"))
  }

  let databaseRowsAbsent = options.store.readManifest().databaseRowsAbsent
  if (!databaseRowsAbsent) {
    const manifest = options.store.readManifest()
    try {
      await cleanupNativeDatabase({
        barrierIds: manifest.barriers
          .filter(({ cleaned }) => !cleaned)
          .map(({ barrierId }) => barrierId),
        database: options.database,
        persistBarrierCleaned: options.store.persistBarrierCleaned,
        persistThreadCleaned: options.store.persistThreadCleaned,
        threadIds: manifest.threads
          .filter(({ cleaned }) => !cleaned)
          .map(({ threadId }) => threadId),
      })
      await options.store.persistDatabaseRowsAbsent()
      databaseRowsAbsent = true
    } catch {
      failures.push(new Error("native Vercel shared database cleanup failed"))
    }
  }
  if (failures.length > 0 || !deploymentAbsent || !databaseRowsAbsent) {
    throw new AggregateError(failures, "native Vercel shared evidence cleanup failed")
  }
  return { databaseRowsAbsent: true, deploymentAbsent: true }
}

export async function runNativeVercelOrchestration(options: {
  readonly cleanupDatabase: () => Promise<void>
  readonly cleanupDeployments: () => Promise<void>
  readonly runKind: (kind: "prebuilt" | "source") => Promise<NativeIncompleteDeploymentEvidence>
  readonly store: NativeEvidenceStore
}): Promise<VercelNativeReceiptV1> {
  let primaryFailure: unknown
  for (const kind of ["source", "prebuilt"] as const) {
    try {
      const evidence = await options.runKind(kind)
      await options.store.persistDeploymentEvidence(kind, evidence)
    } catch (error) {
      primaryFailure = error
      break
    }
  }
  const cleanupFailures: Error[] = []
  for (const operation of [options.cleanupDeployments, options.cleanupDatabase]) {
    try {
      await Promise.resolve().then(operation)
    } catch {
      cleanupFailures.push(new Error("native Vercel orchestration cleanup failed"))
    }
  }
  if (primaryFailure !== undefined || cleanupFailures.length > 0) {
    const primaryError =
      primaryFailure instanceof Error
        ? primaryFailure
        : primaryFailure !== undefined
          ? new Error("native Vercel primary execution failed")
          : undefined
    const errors = [...(primaryError ? [primaryError] : []), ...cleanupFailures]
    throw new AggregateError(
      errors,
      "native Vercel execution or cleanup failed",
      ...(primaryError ? [{ cause: primaryError }] : []),
    )
  }
  try {
    return await options.store.finalizeReceipt()
  } catch {
    throw new Error("native Vercel receipt finalization failed")
  }
}

interface NativeLaneRunDeploymentKindOptions {
  readonly expectedTarballs: readonly string[]
  readonly fixtureRoot: string
  readonly kind: "prebuilt" | "source"
  readonly store: NativeEvidenceStore
  readonly defaultOptions?: Parameters<typeof runNativeDeploymentKind>[0]
}

export function createNativeBlackBoxEvidencePersistence(options: {
  readonly kind: "prebuilt" | "source"
  readonly store: NativeEvidenceStore
}) {
  const events: unknown[] = []
  let runtimeJsonl = ""
  const persistEvents = async (): Promise<void> => {
    await options.store.writeDiagnostic(
      `${options.kind}-events.json`,
      `${JSON.stringify(events, null, 2)}\n`,
    )
  }
  return {
    persistDispatch: async (dispatch: "later" | "release" | "state" | "stream" | "unknown") => {
      events.push({ dispatch })
      await persistEvents()
    },
    persistRuntimeLogSnapshot: async (stdout: string) => {
      const separator = runtimeJsonl && stdout && !runtimeJsonl.endsWith("\n") ? "\n" : ""
      if (
        Buffer.byteLength(runtimeJsonl) + Buffer.byteLength(separator) + Buffer.byteLength(stdout) >
        8 * 1024 * 1024
      ) {
        throw new Error("native Vercel runtime diagnostic exceeded its bounded limit")
      }
      runtimeJsonl += `${separator}${stdout}`
      await options.store.writeDiagnostic(`${options.kind}-runtime.jsonl`, runtimeJsonl)
    },
    persistSseEvidence: async (evidence: {
      readonly after?: NativeSseFrame
      readonly before: NativeSseFrame
      readonly done?: NativeSseFrame
      readonly eof?: true
    }) => {
      events.push({ sse: evidence })
      await persistEvents()
    },
  }
}

interface NativeVercelLaneDependencies {
  readonly assembleFixtures: typeof assembleNativeFixtures
  readonly cleanupEvidenceStore: typeof cleanupNativeEvidenceStore
  readonly createDatabase: typeof createNativePostgresDatabase
  readonly createClock: () => NativeClock
  readonly createEvidenceStore: typeof createNativeEvidenceStore
  readonly createFetchAdapters: typeof createNativeFetchAdapters
  readonly createPinnedBoundary: typeof createNativePinnedVercelBoundary
  readonly createBlackBoxEvidencePersistence: typeof createNativeBlackBoxEvidencePersistence
  readonly runDeploymentKind: (
    options: NativeLaneRunDeploymentKindOptions,
  ) => Promise<NativeIncompleteDeploymentEvidence>
  readonly runLocalCommand: NativeLocalCommandRunner
  readonly runBlackBox: typeof runNativeVercelBlackBox
  readonly runVercelChild: NativeVercelChildRunner
  readonly validateOutput: typeof validateVercelOutput
}

export function createNativeVercelLaneDependencies(): NativeVercelLaneDependencies {
  return {
    assembleFixtures: assembleNativeFixtures,
    cleanupEvidenceStore: cleanupNativeEvidenceStore,
    createDatabase: createNativePostgresDatabase,
    createClock: () => ({
      now: Date.now,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    }),
    createEvidenceStore: createNativeEvidenceStore,
    createFetchAdapters: createNativeFetchAdapters,
    createPinnedBoundary: createNativePinnedVercelBoundary,
    createBlackBoxEvidencePersistence: createNativeBlackBoxEvidencePersistence,
    runDeploymentKind:
      runNativeDeploymentKind as unknown as NativeVercelLaneDependencies["runDeploymentKind"],
    runLocalCommand: runNativeLocalChild,
    runBlackBox: runNativeVercelBlackBox,
    runVercelChild: runNativeLocalChild,
    validateOutput: validateVercelOutput,
  }
}

export async function runNativeOwnedOperation<T>(options: {
  readonly close: () => Promise<void>
  readonly closeTimeoutMs?: number
  readonly operation: () => Promise<T>
}): Promise<T> {
  let primaryFailure: unknown
  let result: T | undefined
  try {
    result = await options.operation()
  } catch (error) {
    primaryFailure = error
  }
  let closeFailure: Error | undefined
  try {
    await nativeWithTimeout(
      "resource close",
      options.closeTimeoutMs ?? 10_000,
      Promise.resolve().then(options.close),
    )
  } catch {
    closeFailure = new Error("native resource close failed or exceeded its deadline")
  }
  if (primaryFailure !== undefined) {
    const primaryError =
      primaryFailure instanceof Error ? primaryFailure : new Error("native owned operation failed")
    if (closeFailure) {
      const primaryErrors =
        primaryError instanceof AggregateError
          ? primaryError.errors.map((error) =>
              error instanceof Error ? error : new Error("native owned operation failed"),
            )
          : [primaryError]
      const primaryCause =
        primaryError instanceof AggregateError && primaryError.cause instanceof Error
          ? primaryError.cause
          : primaryErrors[0]
      throw new AggregateError(
        [...primaryErrors, closeFailure],
        "native owned operation and resource close failed",
        { cause: primaryCause },
      )
    }
    throw primaryError
  }
  if (closeFailure) throw closeFailure
  return result as T
}

function randomNativeIdentifier(prefix: "b-vcl-" | "log-vcl-" | "t-vcl-"): string {
  return `${prefix}${randomBytes(16).toString("hex")}`
}

function nativeBlackBoxIds(): NativeBlackBoxIds {
  return {
    laterThreadId: randomNativeIdentifier("t-vcl-"),
    logMarker: randomNativeIdentifier("log-vcl-"),
    releaseThreadId: randomNativeIdentifier("t-vcl-"),
    sentinelBarrierId: randomNativeIdentifier("b-vcl-"),
    stateMarkers: [randomNativeIdentifier("log-vcl-"), randomNativeIdentifier("log-vcl-")],
    stateThreadId: randomNativeIdentifier("t-vcl-"),
    streamThreadId: randomNativeIdentifier("t-vcl-"),
    targetBarrierId: randomNativeIdentifier("b-vcl-"),
    unknownThreadId: randomNativeIdentifier("t-vcl-"),
  }
}

function nativeAttemptCoordinatesFromEnvironment(
  env: NodeJS.ProcessEnv,
  kind: "prebuilt" | "source",
): NativeAttemptCoordinates {
  const values = {
    githubJob: env.GITHUB_JOB,
    githubRepositoryId: env.GITHUB_REPOSITORY_ID,
    githubRunAttempt: env.GITHUB_RUN_ATTEMPT,
    githubRunId: env.GITHUB_RUN_ID,
  }
  if (Object.values(values).some((value) => !value)) {
    throw new Error("native Vercel lane requires the four GitHub marker coordinates")
  }
  return {
    githubJob: values.githubJob as string,
    githubRepositoryId: values.githubRepositoryId as string,
    githubRunAttempt: values.githubRunAttempt as string,
    githubRunId: values.githubRunId as string,
    kind,
    logicalAttemptIndex: kind === "source" ? "0" : "1",
  }
}

export async function runNativeVercelLane(options: {
  readonly dependencies?: Partial<NativeVercelLaneDependencies>
  readonly env: NodeJS.ProcessEnv
}): Promise<VercelNativeReceiptV1> {
  const environment = readNativeLaneEnvironment(options.env)
  const defaults = createNativeVercelLaneDependencies()
  const dependencies = { ...defaults, ...options.dependencies }
  const authorization = createNativeReleaseAuthorization()
  const releaseHeaders = new Headers()
  authorization.apply(releaseHeaders)
  const releaseCredential = releaseHeaders.get("x-dawn-vercel-release")
  if (!releaseCredential) throw new Error("native Vercel release credential generation failed")
  const protectedValues = [
    environment.token,
    environment.orgId,
    environment.projectId,
    environment.databaseUrl,
    releaseCredential,
  ]
  const store = await dependencies.createEvidenceStore({
    artifactDir: environment.artifactDir,
    protectedValues,
  })
  const runRoot = join(environment.artifactDir, "native-run")
  const repoRoot = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))))
  const assembly = await dependencies.assembleFixtures({
    generatedFiles: renderNativeRouteFiles(authorization.digestSha256),
    orgId: environment.orgId,
    projectId: environment.projectId,
    repoRoot,
    runCommand: dependencies.runLocalCommand,
    runRoot,
  })
  const expectedTarballs = assembly.artifacts.map(({ tarballName }) => tarballName)

  let defaultContext:
    | {
        readonly apiClient: NativeVercelApiClient
        readonly boundary: NativePinnedVercelBoundary
        readonly clock: NativeClock
        readonly database: ReturnType<typeof createNativeBoundedDatabase>
        readonly pool: { readonly end: () => Promise<void> }
        readonly request: ReturnType<typeof createNativeFetchAdapters>["blackBoxRequest"]
        readonly withTimeout: ReturnType<typeof createNativeFetchAdapters>["withTimeout"]
      }
    | undefined
  const needsDefaultRun = dependencies.runDeploymentKind === defaults.runDeploymentKind
  const needsDefaultCleanup = dependencies.cleanupEvidenceStore === defaults.cleanupEvidenceStore
  if (needsDefaultRun || needsDefaultCleanup) {
    await chmod(environment.artifactDir, 0o700)
    const globalConfigDir = join(environment.artifactDir, "global-config")
    await mkdir(globalConfigDir, { mode: 0o700 })
    const fetchAdapters = dependencies.createFetchAdapters()
    const apiClient = createNativeVercelApiClient({
      token: environment.token,
      transport: fetchAdapters.apiTransport,
    })
    const postgres = await dependencies.createDatabase(environment.databaseUrl)
    const database = postgres.database
    const cliPackageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
    let boundary: NativePinnedVercelBoundary
    try {
      boundary = await dependencies.createPinnedBoundary({
        cliPackageRoot,
        databaseUrl: environment.databaseUrl,
        fixtureRoots: [assembly.source.root, assembly.prebuilt.root],
        globalConfigDir,
        jobRoot: environment.artifactDir,
        orgId: environment.orgId,
        parentEnv: options.env,
        projectId: environment.projectId,
        releaseCredential,
        runChild: dependencies.runVercelChild,
        token: environment.token,
      })
    } catch (error) {
      return await runNativeOwnedOperation({
        close: postgres.close,
        operation: async () => {
          throw error
        },
      })
    }
    defaultContext = {
      apiClient,
      boundary,
      clock: dependencies.createClock(),
      database,
      pool: { end: postgres.close },
      request: fetchAdapters.blackBoxRequest,
      withTimeout: fetchAdapters.withTimeout,
    }
  }

  const sharedCleanup = async (): Promise<void> => {
    if (dependencies.cleanupEvidenceStore === defaults.cleanupEvidenceStore) {
      if (!defaultContext) throw new Error("native Vercel default cleanup context is missing")
      await cleanupNativeEvidenceStore({
        apiClient: defaultContext.apiClient,
        clock: defaultContext.clock,
        database: defaultContext.database,
        orgId: environment.orgId,
        projectId: environment.projectId,
        store,
      })
      return
    }
    await dependencies.cleanupEvidenceStore({
      apiClient: {} as NativeVercelApiClient,
      clock: {} as NativeClock,
      database: {} as ReturnType<typeof createNativeBoundedDatabase>,
      orgId: environment.orgId,
      projectId: environment.projectId,
      store,
    })
  }

  const runOrchestration = async (): Promise<VercelNativeReceiptV1> =>
    await runNativeVercelOrchestration({
      cleanupDatabase: async () => undefined,
      cleanupDeployments: sharedCleanup,
      runKind: async (kind) => {
        const fixture = kind === "source" ? assembly.source : assembly.prebuilt
        if (dependencies.runDeploymentKind !== defaults.runDeploymentKind) {
          return await dependencies.runDeploymentKind({
            expectedTarballs,
            fixtureRoot: fixture.root,
            kind,
            store,
          })
        }
        if (!defaultContext) throw new Error("native Vercel default deployment context is missing")
        const blackBoxPersistence = dependencies.createBlackBoxEvidencePersistence({ kind, store })
        const defaultOptions: Parameters<typeof runNativeDeploymentKind>[0] = {
          deployAttempt: () =>
            runNativeDeployAttempt({
              apiClient: defaultContext.apiClient,
              attemptStartMs: Date.now(),
              boundary: defaultContext.boundary,
              coordinates: nativeAttemptCoordinatesFromEnvironment(options.env, kind),
              fixtureRoot: fixture.root,
              localConfigPath: join(fixture.root, "vercel.json"),
              orgId: environment.orgId,
              persistAttempt: store.persistAttempt,
              persistDeploymentBinding: (binding) =>
                store.persistDeploymentBinding(binding.marker, binding),
              persistDeploymentReceipt: (receipt) => {
                const manifest = store.readManifest()
                const attempt = manifest.attempts.at(-1)
                if (!attempt || attempt.attempt.kind !== kind) {
                  throw new Error("native Vercel deployment receipt attempt is missing")
                }
                return store.persistDeploymentReceipt(attempt.attempt.marker, receipt)
              },
              persistProjectBindingVerified: store.persistProjectBindingVerified,
              persistStage: (stage, evidence) =>
                store.persistDeploymentStage(kind, stage, evidence),
              projectId: environment.projectId,
            }),
          expectedTarballs,
          fixtureRoot: fixture.root,
          inspectBuildLogs: defaultContext.boundary.inspectBuildLogs,
          kind,
          orgId: environment.orgId,
          parentEnv: options.env,
          projectId: environment.projectId,
          protectedValues,
          reconcile: (attempt) =>
            reconcileNativeMarker({
              apiClient: defaultContext.apiClient,
              attempt,
              clock: defaultContext.clock,
              orgId: environment.orgId,
              persistDeploymentBinding: (binding) =>
                store.persistDeploymentBinding(attempt.marker, binding),
              projectId: environment.projectId,
            }),
          persistStage: (stage, evidence) => store.persistDeploymentStage(kind, stage, evidence),
          runBlackBox: async ({ canonicalOrigin, deploymentId, persistStage }) => {
            return await dependencies.runBlackBox({
              canonicalOrigin,
              clock: defaultContext.clock,
              database: defaultContext.database,
              deploymentId,
              ids: nativeBlackBoxIds(),
              logBoundary: defaultContext.boundary,
              orgId: environment.orgId,
              persistBarrier: (record) => store.persistBarrier({ ...record, kind }),
              persistDispatch: blackBoxPersistence.persistDispatch,
              persistRuntimeLogSnapshot: blackBoxPersistence.persistRuntimeLogSnapshot,
              persistSseEvidence: blackBoxPersistence.persistSseEvidence,
              persistStage,
              persistThread: (threadId) => store.persistThread({ kind, threadId }),
              projectId: environment.projectId,
              releaseAuthorization: authorization,
              request: defaultContext.request,
              withTimeout: defaultContext.withTimeout,
            })
          },
          runBuildChild: dependencies.runVercelChild,
          validateOutput: dependencies.validateOutput,
          writeDiagnostic: store.writeDiagnostic,
        }
        return await runNativeDeploymentKind(defaultOptions)
      },
      store,
    })
  return defaultContext
    ? await runNativeOwnedOperation({ close: defaultContext.pool.end, operation: runOrchestration })
    : await runOrchestration()
}

export function createNativeVercelApiClient(_options: {
  readonly token: string
  readonly transport: NativeVercelApiTransport
}): NativeVercelApiClient {
  const options = _options
  if (!options.token) throw new Error("native Vercel API token must be nonempty")
  return {
    request: async (method, path) => {
      if (method !== "GET" && method !== "DELETE") {
        throw new Error("native Vercel API method must be GET or DELETE")
      }
      if (
        !path.startsWith("/") ||
        path.startsWith("//") ||
        path.includes("\\") ||
        path.includes("#") ||
        /(?:^|\/)(?:\.{1,2}|%(?:2e|2f|5c))(?:\/|$)/i.test(path)
      ) {
        throw new Error("native Vercel API request path is unsafe")
      }
      const pathname = path.split("?", 1)[0] as string
      for (const segment of pathname.split("/")) {
        let decoded: string
        try {
          decoded = decodeURIComponent(segment)
        } catch {
          throw new Error("native Vercel API request path is unsafe")
        }
        if (
          decoded === "." ||
          decoded === ".." ||
          decoded.includes("/") ||
          decoded.includes("\\")
        ) {
          throw new Error("native Vercel API request path is unsafe")
        }
      }
      const url = new URL(path, "https://api.vercel.com")
      if (url.origin !== "https://api.vercel.com") {
        throw new Error("native Vercel API request path escaped the fixed origin")
      }
      try {
        return await options.transport({
          headers: { authorization: `Bearer ${options.token}` },
          method,
          redirect: "manual",
          timeoutMs: NATIVE_VERCEL_API_TIMEOUT_MS,
          url: url.href,
        })
      } catch {
        throw new Error("native Vercel API transport failed")
      }
    },
  }
}
