import { createHash, randomBytes } from "node:crypto"
import {
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
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"

import { RECOMMENDED_VERCEL_CONFIG } from "../../src/lib/build/targets/vercel-config.js"

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
  readonly executable: string
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
    "export const pool = new Pool({",
    "  connectionString: process.env.DATABASE_URL,",
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
  request: NativeLocalCommandRequest,
): Promise<NativeLocalCommandResult> {
  const result = await runCommand(request)
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
  await runSuccessfulLocalCommand(options.runCommand, {
    executable: join(prebuilt.root, "node_modules", ".bin", "dawn"),
    args: ["build"],
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
  await assertNativeFixtureUploadIsolation({
    expectedTarballs,
    kind: "prebuilt",
    orgId: options.orgId,
    projectId: options.projectId,
    root: prebuilt.root,
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

function matchesVendoredIdentity(value: string, packageName: string, ref: string): boolean {
  const identity = `${packageName}@${ref}`
  return (
    value === identity ||
    (value.startsWith(identity) && hasCompletePnpmPeerSuffix(value.slice(identity.length)))
  )
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
        return item === ref || matchesVendoredIdentity(item, name, ref)
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
          dependency.version !== expectedEntry.ref
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
