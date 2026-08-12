import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { builtinModules, createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build, type Metafile, type Plugin } from "esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type tsTypes from "../../core/node_modules/typescript/lib/typescript.js"
import type {
  Expression,
  Node,
  Symbol as TypeScriptSymbol,
} from "../../core/node_modules/typescript/lib/typescript.js"

// Resolve Dawn's supported TS6 compiler from Core's declared dependency, as the
// repository tooling probe does. The root `typescript` export is a TS7 preview
// version shim and does not expose the stable compiler API used by this test.
const coreRequire = createRequire(
  fileURLToPath(new URL("../../core/package.json", import.meta.url)),
)
const ts = coreRequire("typescript") as typeof tsTypes

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const registryPath = resolve(repoRoot, "apps/web/app/components/docs/api-reference.ts")
const packagesRoot = join(repoRoot, "packages")
const NODE_GLOBALS = ["process", "Buffer", "global", "__dirname", "__filename", "require"] as const
const RUNTIME_SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
])

// This is the same app/provider boundary used by the authoritative fetch-entry
// purity test, not a blanket third-party exclusion.
const MODEL_LAYER_EXTERNALS = ["@langchain/*", "langchain", "openai"]
const FULL_GRAPH_EXTERNALS = MODEL_LAYER_EXTERNALS
const COMPUTED_LOAD_BOUNDARIES = [
  // loadMiddleware is injected as a Node fallback. The edge path requires options/modules
  // middleware and never calls this dynamic application-file probe.
  {
    pathSuffix: "/packages/cli/dist/lib/dev/middleware.js",
    enclosing: "loadMiddleware",
    call: "import(path)",
    start: 1464,
  },
  // Model and embedder providers are selected by the application and already form the
  // authoritative model-layer boundary in fetch-entry-purity.
  {
    pathSuffix: "/packages/langchain/dist/openai-embedder.js",
    enclosing: "openaiEmbedder",
    call: "import(s)",
    start: 362,
  },
] as const
const exercisedComputedLoadBoundaries = new Map<string, number>()
const COMPUTED_GLOBAL_BOUNDARIES = [
  // Protobuf stores its Text Encoding implementation under a unique Symbol key.
  // These computed properties cannot resolve to a Node-global string.
  {
    pathSuffix:
      "/node_modules/.pnpm/@bufbuild+protobuf@2.12.1/node_modules/@bufbuild/protobuf/dist/esm/wire/text-encoding.js",
    enclosing: "configureTextEncoding",
    property: "globalThis[symbol]",
    start: 1145,
  },
  {
    pathSuffix:
      "/node_modules/.pnpm/@bufbuild+protobuf@2.12.1/node_modules/@bufbuild/protobuf/dist/esm/wire/text-encoding.js",
    enclosing: "getTextEncoding",
    property: "globalThis[symbol]",
    start: 1226,
  },
  {
    pathSuffix:
      "/node_modules/.pnpm/@bufbuild+protobuf@2.12.1/node_modules/@bufbuild/protobuf/dist/esm/wire/text-encoding.js",
    enclosing: "getTextEncoding",
    property: "globalThis[symbol]",
    start: 1389,
  },
  {
    pathSuffix:
      "/node_modules/.pnpm/@bufbuild+protobuf@2.12.1/node_modules/@bufbuild/protobuf/dist/esm/wire/text-encoding.js",
    enclosing: "getTextEncoding",
    property: "globalThis[symbol]",
    start: 2126,
  },
] as const
const exercisedComputedGlobalBoundaries = new Set<number>()

const GUARD_IDS = [
  "edge-import-bundle",
  "dependency-free-import-graph",
  "node-import-bundle",
  "browser-import-negative-control",
  "node-operated-bundle",
  "browser-operated-negative-control",
] as const
type GuardId = (typeof GUARD_IDS)[number]

interface ImportArtifact {
  readonly kind: "import"
  readonly packageName: string
  readonly subpath: string
  readonly surfaceKind: "typescript-runtime"
  readonly runtime: "edge-safe" | "node-only"
  readonly purity: "dependency-free" | "not-claimed"
  readonly guardIds: readonly GuardId[]
}

interface OperatedArtifact {
  readonly kind: "operated"
  readonly packageName: string
  readonly selector: string
  readonly manifestTarget: string
  readonly runtime: "node-only"
  readonly guardIds: readonly GuardId[]
}

type RuntimeArtifact = ImportArtifact | OperatedArtifact

interface GlobalReference {
  readonly global: string
  readonly guarded: boolean
  readonly line: number
  readonly text: string
}

interface RuntimeLoadOccurrence {
  readonly call: string
  readonly enclosing: string
  readonly start: number
}

interface GlobalPropertyOccurrence {
  readonly guarded: boolean
  readonly enclosing: string
  readonly property: string
  readonly start: number
}

interface SourceHazards {
  readonly globalProperties: readonly string[]
  readonly unresolvedLoads: readonly string[]
}

interface DetailedSourceHazards extends SourceHazards {
  readonly globalOccurrences: readonly GlobalPropertyOccurrence[]
  readonly loadOccurrences: readonly RuntimeLoadOccurrence[]
}

interface SymbolFacts {
  mayGlobal: boolean
  mayRequire: boolean
  readonly nodeGlobals: Set<string>
  readonly strings: Set<string>
  mayOther: boolean
}

const packageDirectoryByName = new Map<string, string>()
let packageFixtureRoot = ""

beforeAll(async () => {
  packageFixtureRoot = await mkdtemp(join(tmpdir(), "dawn-api-compatibility-"))
  const nodeModules = join(packageFixtureRoot, "node_modules")
  await mkdir(join(nodeModules, "@dawn-ai"), { recursive: true })

  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const packageRoot = join(packagesRoot, entry.name)
    try {
      const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
        readonly name?: string
      }
      if (!manifest.name) continue
      packageDirectoryByName.set(manifest.name, packageRoot)
      const target = manifest.name.startsWith("@dawn-ai/")
        ? join(nodeModules, "@dawn-ai", manifest.name.slice("@dawn-ai/".length))
        : join(nodeModules, manifest.name)
      await symlink(packageRoot, target, "dir")
    } catch {
      // Not a package directory.
    }
  }
})

afterAll(async () => {
  if (packageFixtureRoot) await rm(packageFixtureRoot, { recursive: true, force: true })
})

async function loadRuntimeArtifacts(): Promise<readonly RuntimeArtifact[]> {
  const { tsImport } = await import("tsx/esm/api")
  const module = (await tsImport(registryPath, import.meta.url)) as {
    readonly ARTIFACT_REGISTRY: readonly Record<string, unknown>[]
  }
  return module.ARTIFACT_REGISTRY.filter(
    (artifact): artifact is Record<string, unknown> & RuntimeArtifact =>
      artifact.kind === "operated" ||
      (artifact.kind === "import" && artifact.surfaceKind === "typescript-runtime"),
  )
}

async function packageDirectory(packageName: string): Promise<string> {
  const packageRoot = packageDirectoryByName.get(packageName)
  if (!packageRoot) throw new Error(`No package directory for ${packageName}`)
  return packageRoot
}

function packageSpecifier(artifact: ImportArtifact): string {
  return artifact.subpath === "."
    ? artifact.packageName
    : `${artifact.packageName}/${artifact.subpath.slice(2)}`
}

function addressFor(artifact: RuntimeArtifact): string {
  return artifact.kind === "import"
    ? `import:${artifact.packageName}:${artifact.subpath}`
    : `operated:${artifact.packageName}:${artifact.selector}`
}

async function operatedTarget(artifact: OperatedArtifact): Promise<string> {
  return join(await packageDirectory(artifact.packageName), artifact.manifestTarget)
}

function syntheticImport(specifier: string): string {
  return `import * as boundary from ${JSON.stringify(specifier)}; export { boundary }`
}

async function bundleSpecifier(options: {
  readonly conditions: readonly string[]
  readonly define?: Record<string, string>
  readonly external?: readonly string[]
  readonly metafile?: boolean
  readonly platform: "browser" | "neutral" | "node"
  readonly plugins?: readonly Plugin[]
  readonly specifier: string
}): Promise<{ readonly code: string; readonly metafile?: Metafile }> {
  const result = await build({
    absWorkingDir: packageFixtureRoot,
    bundle: true,
    conditions: [...options.conditions],
    ...(options.define ? { define: options.define } : {}),
    external: [...(options.external ?? [])],
    format: "esm",
    logLevel: "silent",
    mainFields: ["module", "main"],
    metafile: options.metafile ?? false,
    outfile: join(packageFixtureRoot, "boundary.bundle.mjs"),
    platform: options.platform,
    plugins: [...(options.plugins ?? [])],
    stdin: {
      contents: syntheticImport(options.specifier),
      loader: "js",
      resolveDir: packageFixtureRoot,
      sourcefile: "api-reference-boundary.mjs",
    },
    write: false,
  })
  return {
    code: result.outputFiles?.[0]?.text ?? "",
    ...(result.metafile ? { metafile: result.metafile } : {}),
  }
}

function sentinel(name: string): string {
  return `__DAWN_API_NODE_GLOBAL_${name}__`
}

const GLOBAL_SENTINEL_DEFINES: Record<string, string> = Object.fromEntries(
  NODE_GLOBALS.map((name) => [name, sentinel(name)]),
)

function isTypeofGuarded(line: string, at: number, sentinelName: string): boolean {
  const statementStart = Math.max(
    line.lastIndexOf(";", at),
    line.lastIndexOf("{", at),
    line.lastIndexOf("}", at),
  )
  const statement = line.slice(statementStart + 1, at + sentinelName.length)
  return new RegExp(`typeof\\s+${sentinelName}`).test(statement)
}

function findNodeGlobalReferences(code: string): GlobalReference[] {
  const found: GlobalReference[] = []
  code.split("\n").forEach((text, index) => {
    for (const name of NODE_GLOBALS) {
      const marker = sentinel(name)
      for (
        let at = text.indexOf(marker);
        at !== -1;
        at = text.indexOf(marker, at + marker.length)
      ) {
        found.push({
          global: name,
          guarded: isTypeofGuarded(text, at, marker),
          line: index + 1,
          text: text.trim().slice(0, 200),
        })
      }
    }
  })
  return found
}

const externalizeNonDawn: Plugin = {
  name: "externalize-non-dawn",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith("@dawn-ai/") ? null : { external: true, path: args.path },
    )
  },
}

async function fullGraphGlobalReferences(artifact: ImportArtifact): Promise<GlobalReference[]> {
  const { code } = await bundleSpecifier({
    conditions: ["dawn-static-provider-imports", "workerd", "worker", "browser", "import"],
    define: GLOBAL_SENTINEL_DEFINES,
    external: [...FULL_GRAPH_EXTERNALS, "node:*"],
    platform: "browser",
    specifier: packageSpecifier(artifact),
  })
  return findNodeGlobalReferences(code)
}

async function dawnOwnedGlobalReferences(artifact: ImportArtifact): Promise<GlobalReference[]> {
  const { code } = await bundleSpecifier({
    conditions: ["dawn-static-provider-imports", "workerd", "worker", "browser", "import"],
    define: GLOBAL_SENTINEL_DEFINES,
    external: [...FULL_GRAPH_EXTERNALS, "node:*"],
    platform: "browser",
    plugins: [externalizeNonDawn],
    specifier: packageSpecifier(artifact),
  })
  return findNodeGlobalReferences(code)
}

function sourceExtension(file: string): string {
  const dot = file.lastIndexOf(".")
  return dot === -1 ? "" : file.slice(dot)
}

function isStringLiteralLike(node: Node | undefined): boolean {
  return Boolean(node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)))
}

function isSafeOptionalGlobalAccess(node: Expression): boolean {
  const parent = node.parent
  return Boolean(
    parent &&
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === node &&
      parent.questionDotToken,
  )
}

function functionName(node: Node, fallback: string): string {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name.text
  }
  const parent = node.parent
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text
  }
  return fallback
}

function analyzeRuntimeSourceDetailed(
  source: string,
  fileName = "fixture.ts",
): DetailedSourceHazards {
  const analysisFileName = fileName.startsWith("/") ? fileName : `/virtual/${fileName}`
  const compilerOptions = {
    allowJs: true,
    checkJs: false,
    experimentalDecorators: true,
    module: ts.ModuleKind.ESNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
    noEmit: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.ESNext,
    types: [],
  }
  const host = ts.createCompilerHost(compilerOptions, true)
  const sourceFile = ts.createSourceFile(analysisFileName, source, ts.ScriptTarget.Latest, true)
  const originalFileExists = host.fileExists.bind(host)
  const originalGetSourceFile = host.getSourceFile.bind(host)
  const originalReadFile = host.readFile.bind(host)
  host.fileExists = (path) => path === analysisFileName || originalFileExists(path)
  host.readFile = (path) => (path === analysisFileName ? source : originalReadFile(path))
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    path === analysisFileName
      ? sourceFile
      : originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram([analysisFileName], compilerOptions, host)
  const checker = program.getTypeChecker()
  const globalProperties = new Set<string>()
  const globalOccurrences: GlobalPropertyOccurrence[] = []
  const loadOccurrences: RuntimeLoadOccurrence[] = []
  const factsBySymbol = new Map<TypeScriptSymbol, SymbolFacts>()
  const flows: Array<{ readonly source: Expression; readonly target: TypeScriptSymbol }> = []
  const destructureFlows: Array<{
    readonly element: tsTypes.BindingElement
    readonly source: Expression
    readonly target?: TypeScriptSymbol
  }> = []

  const emptyFacts = (): SymbolFacts => ({
    mayGlobal: false,
    mayRequire: false,
    mayOther: false,
    nodeGlobals: new Set(),
    strings: new Set(),
  })
  const mergeFacts = (target: SymbolFacts, incoming: SymbolFacts): boolean => {
    const before = `${target.mayGlobal}:${target.mayRequire}:${target.mayOther}:${[...target.nodeGlobals]}:${[...target.strings]}`
    target.mayGlobal ||= incoming.mayGlobal
    target.mayRequire ||= incoming.mayRequire
    target.mayOther ||= incoming.mayOther
    for (const name of incoming.nodeGlobals) target.nodeGlobals.add(name)
    for (const value of incoming.strings) target.strings.add(value)
    return (
      before !==
      `${target.mayGlobal}:${target.mayRequire}:${target.mayOther}:${[...target.nodeGlobals]}:${[...target.strings]}`
    )
  }
  const unwrap = (expression: Expression): Expression => {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      return unwrap(expression.expression)
    }
    return expression
  }
  const symbolAt = (node: Node): TypeScriptSymbol | undefined => checker.getSymbolAtLocation(node)
  const isIntrinsic = (node: Node, name: string): boolean => {
    if (!ts.isIdentifier(node) || node.text !== name) return false
    const symbol = symbolAt(node)
    return !symbol || (symbol.declarations?.length ?? 0) === 0
  }
  const factsFor = (rawExpression: Expression): SymbolFacts => {
    const expression = unwrap(rawExpression)
    const result = emptyFacts()
    if (isIntrinsic(expression, "globalThis")) {
      result.mayGlobal = true
      return result
    }
    if (isIntrinsic(expression, "require")) {
      result.mayRequire = true
      return result
    }
    if (ts.isIdentifier(expression)) {
      const symbol = symbolAt(expression)
      if (symbol) mergeFacts(result, factsBySymbol.get(symbol) ?? emptyFacts())
      else result.mayOther = true
      return result
    }
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      result.strings.add(expression.text)
      return result
    }
    if (ts.isConditionalExpression(expression)) {
      mergeFacts(result, factsFor(expression.whenTrue))
      mergeFacts(result, factsFor(expression.whenFalse))
      return result
    }
    if (ts.isBinaryExpression(expression)) {
      if (
        expression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        expression.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        mergeFacts(result, factsFor(expression.right))
        if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
          mergeFacts(result, factsFor(expression.left))
        }
        return result
      }
      if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = staticString(expression.left)
        const right = staticString(expression.right)
        if (left !== undefined && right !== undefined) result.strings.add(`${left}${right}`)
        else result.mayOther = true
        return result
      }
      if (
        expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        mergeFacts(result, factsFor(expression.left))
        mergeFacts(result, factsFor(expression.right))
        return result
      }
    }
    if (ts.isTemplateExpression(expression)) {
      let value = expression.head.text
      for (const span of expression.templateSpans) {
        const part = staticString(span.expression)
        if (part === undefined) {
          result.mayOther = true
          return result
        }
        value += part + span.literal.text
      }
      result.strings.add(value)
      return result
    }
    result.mayOther = true
    return result
  }
  const staticString = (expression: Expression | undefined): string | undefined => {
    if (!expression) return undefined
    const facts = factsFor(expression)
    return !facts.mayGlobal &&
      !facts.mayRequire &&
      !facts.mayOther &&
      facts.nodeGlobals.size === 0 &&
      facts.strings.size === 1
      ? [...facts.strings][0]
      : undefined
  }
  const propertyName = (node: Node | undefined): string | undefined => {
    if (!node) return undefined
    if (
      ts.isIdentifier(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    ) {
      return node.text
    }
    if (ts.isComputedPropertyName(node)) return staticString(node.expression)
    return undefined
  }
  const addPatternFlows = (name: Node, initializer: Expression | undefined): void => {
    if (ts.isIdentifier(name)) {
      const target = symbolAt(name)
      if (target && initializer) flows.push({ source: initializer, target })
      return
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        const target = symbolAt(element.name)
        if (initializer) {
          destructureFlows.push({
            element,
            source: initializer,
            ...(target ? { target } : {}),
          })
        }
        addPatternFlows(element.name, initializer)
        if (element.initializer) addPatternFlows(element.name, element.initializer)
      }
      return
    }
    if (ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) addPatternFlows(element.name, element.initializer)
      }
    }
  }
  const collectFlows = (node: Node): void => {
    if (ts.isHeritageClause(node)) {
      if (node.token === ts.SyntaxKind.ExtendsKeyword) {
        for (const type of node.types) collectFlows(type.expression)
      }
      return
    }
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
      return
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      addPatternFlows(node.name, node.initializer)
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    ) {
      const target = symbolAt(node.left)
      if (target) flows.push({ source: node.right, target })
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(node.left)
    ) {
      for (const property of node.left.properties) {
        if (!ts.isShorthandPropertyAssignment(property) && !ts.isPropertyAssignment(property))
          continue
        const targetNode = ts.isShorthandPropertyAssignment(property)
          ? property.name
          : property.initializer
        if (!ts.isIdentifier(targetNode)) continue
        const target = symbolAt(targetNode)
        if (!target) continue
        const syntheticSource = node.right
        destructureFlows.push({
          element: ts.factory.createBindingElement(undefined, property.name, targetNode, undefined),
          source: syntheticSource,
          target,
        })
      }
    }
    ts.forEachChild(node, collectFlows)
  }
  collectFlows(sourceFile)

  for (let changed = true; changed; ) {
    changed = false
    for (const { source: flowSource, target } of flows) {
      const targetFacts = factsBySymbol.get(target) ?? emptyFacts()
      factsBySymbol.set(target, targetFacts)
      changed = mergeFacts(targetFacts, factsFor(flowSource)) || changed
    }
    for (const { element, source: flowSource, target } of destructureFlows) {
      if (!target || !factsFor(flowSource).mayGlobal) continue
      const incoming = emptyFacts()
      const name = propertyName(element.propertyName ?? element.name)
      if (name && NODE_GLOBALS.includes(name as (typeof NODE_GLOBALS)[number])) {
        incoming.nodeGlobals.add(name)
      } else {
        incoming.mayOther = true
      }
      const targetFacts = factsBySymbol.get(target) ?? emptyFacts()
      factsBySymbol.set(target, targetFacts)
      changed = mergeFacts(targetFacts, incoming) || changed
    }
  }

  const seenGlobals = new Set<string>()
  const seenLoads = new Set<string>()
  const addGlobal = (occurrence: GlobalPropertyOccurrence): void => {
    const key = `${occurrence.enclosing}:${occurrence.start}:${occurrence.property}:${occurrence.guarded}`
    if (seenGlobals.has(key)) return
    seenGlobals.add(key)
    globalOccurrences.push(occurrence)
    if (!occurrence.guarded) globalProperties.add(occurrence.property)
  }
  const addLoad = (occurrence: RuntimeLoadOccurrence): void => {
    const key = `${occurrence.enclosing}:${occurrence.start}:${occurrence.call}`
    if (seenLoads.has(key)) return
    seenLoads.add(key)
    loadOccurrences.push(occurrence)
  }
  const addAggregateFacts = (storage: Node, facts: SymbolFacts, enclosing: string): void => {
    if (!facts.mayGlobal && facts.nodeGlobals.size === 0) return
    const stored = [...(facts.mayGlobal ? ["globalThis"] : []), ...facts.nodeGlobals].join("/")
    addGlobal({
      guarded: false,
      enclosing,
      property: `${stored} stored in ${storage.getText(sourceFile)}`,
      start: storage.getStart(sourceFile),
    })
  }
  const addAggregateStorage = (storage: Node, value: Expression, enclosing: string): void => {
    addAggregateFacts(storage, factsFor(value), enclosing)
  }
  const isDestructuringAssignmentProperty = (node: Node): boolean => {
    const object = node.parent
    const assignment = object?.parent
    return Boolean(
      object &&
        ts.isObjectLiteralExpression(object) &&
        assignment &&
        ts.isBinaryExpression(assignment) &&
        assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        assignment.left === object,
    )
  }
  const scan = (node: Node, enclosing: string): void => {
    if (ts.isHeritageClause(node)) {
      if (node.token === ts.SyntaxKind.ExtendsKeyword) {
        for (const type of node.types) scan(type.expression, enclosing)
      }
      return
    }
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
      return
    const nextEnclosing = ts.isFunctionLike(node) ? functionName(node, enclosing) : enclosing
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (ts.isSpreadElement(element))
          addAggregateStorage(element, element.expression, nextEnclosing)
        else addAggregateStorage(element, element, nextEnclosing)
      }
    } else if (ts.isPropertyAssignment(node) && !isDestructuringAssignmentProperty(node)) {
      addAggregateStorage(node, node.initializer, nextEnclosing)
    } else if (ts.isShorthandPropertyAssignment(node) && !isDestructuringAssignmentProperty(node)) {
      const valueSymbol = checker.getShorthandAssignmentValueSymbol(node)
      addAggregateFacts(
        node,
        valueSymbol ? (factsBySymbol.get(valueSymbol) ?? emptyFacts()) : factsFor(node.name),
        nextEnclosing,
      )
    } else if (ts.isSpreadAssignment(node)) {
      addAggregateStorage(node, node.expression, nextEnclosing)
    } else if (ts.isPropertyDeclaration(node) && node.initializer) {
      addAggregateStorage(node, node.initializer, nextEnclosing)
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
    ) {
      addAggregateStorage(node, node.right, nextEnclosing)
    }
    if (ts.isCallExpression(node)) {
      const isImportCall = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequireCall =
        isIntrinsic(node.expression, "require") || factsFor(node.expression).mayRequire
      if ((isImportCall || isRequireCall) && !isStringLiteralLike(node.arguments[0])) {
        addLoad({
          call: node.getText(sourceFile),
          enclosing: nextEnclosing,
          start: node.getStart(sourceFile),
        })
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const rootFacts = factsFor(node.expression)
      if (rootFacts.mayGlobal) {
        const name = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : staticString(node.argumentExpression)
        if (name === undefined) {
          addGlobal({
            guarded: false,
            enclosing: nextEnclosing,
            property: node.getText(sourceFile),
            start: node.getStart(sourceFile),
          })
        } else if (NODE_GLOBALS.includes(name as (typeof NODE_GLOBALS)[number])) {
          addGlobal({
            guarded: isSafeOptionalGlobalAccess(node),
            enclosing: nextEnclosing,
            property: name,
            start: node.getStart(sourceFile),
          })
        }
      }
      for (const name of rootFacts.nodeGlobals) {
        addGlobal({
          guarded: false,
          enclosing: nextEnclosing,
          property: name,
          start: node.getStart(sourceFile),
        })
      }
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      factsFor(node.initializer).mayGlobal
    ) {
      for (const element of node.name.elements) {
        const name = propertyName(element.propertyName ?? element.name)
        if (name && NODE_GLOBALS.includes(name as (typeof NODE_GLOBALS)[number])) {
          addGlobal({
            guarded: false,
            enclosing: nextEnclosing,
            property: name,
            start: element.getStart(sourceFile),
          })
        } else if (name === undefined || element.dotDotDotToken) {
          addGlobal({
            guarded: false,
            enclosing: nextEnclosing,
            property: (element.propertyName ?? element).getText(sourceFile),
            start: element.getStart(sourceFile),
          })
        }
      }
    }
    ts.forEachChild(node, (child) => scan(child, nextEnclosing))
  }
  scan(sourceFile, "<module>")

  return {
    globalProperties: [...globalProperties].sort(),
    globalOccurrences,
    loadOccurrences,
    unresolvedLoads: [...new Set(loadOccurrences.map(({ call }) => call))].sort(),
  }
}

function analyzeRuntimeSource(source: string, fileName = "fixture.ts"): SourceHazards {
  const { globalProperties, unresolvedLoads } = analyzeRuntimeSourceDetailed(source, fileName)
  return { globalProperties, unresolvedLoads }
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/")
}

function isDawnOwnedRuntimePath(path: string): boolean {
  const normalizedPath = normalizePath(path)
  return normalizedPath.includes("/packages/") && !normalizedPath.includes("/node_modules/")
}

function matchesComputedLoadBoundary(
  occurrence: RuntimeLoadOccurrence,
  path: string,
  boundary: {
    readonly call: string
    readonly enclosing: string
    readonly pathSuffix: string
    readonly start: number
  },
): boolean {
  const normalizedPath = normalizePath(path)
  return (
    normalizedPath.endsWith(boundary.pathSuffix) &&
    occurrence.call === boundary.call &&
    occurrence.enclosing === boundary.enclosing &&
    occurrence.start === boundary.start
  )
}

async function analyzeGraphInputs(metafile: Metafile): Promise<SourceHazards> {
  const globalProperties = new Set<string>()
  const unresolvedLoads = new Set<string>()
  for (const input of Object.keys(metafile.inputs)) {
    if (input.endsWith("api-reference-boundary.mjs")) continue
    const absolute = resolve(packageFixtureRoot, input)
    const normalizedAbsolute = absolute.replaceAll("\\", "/")
    if (!RUNTIME_SOURCE_EXTENSIONS.has(sourceExtension(absolute))) continue
    const hazards = analyzeRuntimeSourceDetailed(await readFile(absolute, "utf8"), absolute)
    for (const occurrence of hazards.globalOccurrences) {
      const boundaryIndex = COMPUTED_GLOBAL_BOUNDARIES.findIndex(
        ({ pathSuffix, enclosing, property, start }) =>
          normalizedAbsolute.endsWith(pathSuffix) &&
          occurrence.enclosing === enclosing &&
          occurrence.property === property &&
          occurrence.start === start,
      )
      if (boundaryIndex !== -1) {
        exercisedComputedGlobalBoundaries.add(boundaryIndex)
        continue
      }
      // Dawn's emitted edge code may deliberately use optional Node-global probes.
      // Third-party occurrences still require an exact exception above so dependency
      // upgrades cannot silently broaden the accepted graph.
      if (occurrence.guarded && isDawnOwnedRuntimePath(normalizedAbsolute)) continue
      globalProperties.add(
        `${occurrence.property} in ${occurrence.enclosing}@${occurrence.start} <- ${normalizedAbsolute}`,
      )
    }
    for (const occurrence of hazards.loadOccurrences) {
      const boundary = COMPUTED_LOAD_BOUNDARIES.find((candidate) =>
        matchesComputedLoadBoundary(occurrence, normalizedAbsolute, candidate),
      )
      if (boundary) {
        exercisedComputedLoadBoundaries.set(boundary.pathSuffix, 1)
        continue
      }
      unresolvedLoads.add(
        `${occurrence.call} in ${occurrence.enclosing}@${occurrence.start} <- ${normalizedAbsolute}`,
      )
    }
  }
  return {
    globalProperties: [...globalProperties].sort(),
    unresolvedLoads: [...unresolvedLoads].sort(),
  }
}

function runtimeDependencyEdges(metafile: Metafile): string[] {
  const packageNames = new Set<string>()
  const builtinNames = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
  for (const [file, info] of Object.entries(metafile.inputs)) {
    if (file.endsWith("api-reference-boundary.mjs")) continue
    for (const imported of info.imports) {
      const specifier = imported.original ?? imported.path
      if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) continue
      if (builtinNames.has(specifier)) packageNames.add(specifier)
      else if (specifier.startsWith("@"))
        packageNames.add(specifier.split("/").slice(0, 2).join("/"))
      else packageNames.add(specifier.split("/")[0] ?? specifier)
    }
  }
  return [...packageNames].sort()
}

async function browserGraph(artifact: ImportArtifact): Promise<Metafile> {
  const result = await bundleSpecifier({
    conditions: ["dawn-static-provider-imports", "workerd", "worker", "browser", "import"],
    external: [...FULL_GRAPH_EXTERNALS, "node:*"],
    metafile: true,
    platform: "browser",
    specifier: packageSpecifier(artifact),
  })
  if (!result.metafile) throw new Error(`No metafile for ${addressFor(artifact)}`)
  return result.metafile
}

async function assertEdgeImport(artifact: ImportArtifact): Promise<void> {
  await expect(
    bundleSpecifier({
      conditions: ["dawn-static-provider-imports", "workerd", "worker", "browser", "import"],
      external: FULL_GRAPH_EXTERNALS,
      platform: "browser",
      specifier: packageSpecifier(artifact),
    }),
    addressFor(artifact),
  ).resolves.toBeDefined()

  const fullReferences = await fullGraphGlobalReferences(artifact)
  expect(
    fullReferences.filter((reference) => !reference.guarded),
    `${addressFor(artifact)} has unguarded full-graph Node globals`,
  ).toEqual([])
  expect(
    await dawnOwnedGlobalReferences(artifact),
    `${addressFor(artifact)} has Dawn-owned Node globals`,
  ).toEqual([])

  const hazards = await analyzeGraphInputs(await browserGraph(artifact))
  expect(hazards.globalProperties, `${addressFor(artifact)} has globalThis Node globals`).toEqual(
    [],
  )
  expect(hazards.unresolvedLoads, `${addressFor(artifact)} has computed runtime loads`).toEqual([])
}

async function assertDependencyFree(artifact: ImportArtifact): Promise<void> {
  const metafile = await browserGraph(artifact)
  expect(runtimeDependencyEdges(metafile), addressFor(artifact)).toEqual([])
  const ownerRoot = `${await packageDirectory(artifact.packageName)}/`
  const foreignInputs = Object.keys(metafile.inputs)
    .filter((input) => !input.endsWith("api-reference-boundary.mjs"))
    .map((input) => resolve(packageFixtureRoot, input))
    .filter((input) => !input.startsWith(ownerRoot))
  expect(foreignInputs, addressFor(artifact)).toEqual([])
  expect((await analyzeGraphInputs(metafile)).unresolvedLoads, addressFor(artifact)).toEqual([])
}

async function assertNodeImport(artifact: ImportArtifact): Promise<void> {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(packageSpecifier(artifact))})`,
    ],
    { cwd: packageFixtureRoot, encoding: "utf8", timeout: 30_000 },
  )
  expect(result.status, `${addressFor(artifact)}\n${result.stderr}`).toBe(0)
}

async function assertBrowserImportNegative(artifact: ImportArtifact): Promise<void> {
  try {
    await bundleSpecifier({
      conditions: ["dawn-static-provider-imports", "workerd", "worker", "browser", "import"],
      external: FULL_GRAPH_EXTERNALS,
      platform: "browser",
      specifier: packageSpecifier(artifact),
    })
  } catch {
    return
  }

  const fullReferences = await fullGraphGlobalReferences(artifact)
  const dawnReferences = await dawnOwnedGlobalReferences(artifact)
  const hazards = await analyzeGraphInputs(await browserGraph(artifact))
  const violations = [
    ...fullReferences
      .filter((reference) => !reference.guarded)
      .map((reference) => reference.global),
    ...dawnReferences.map((reference) => reference.global),
    ...hazards.globalProperties,
    ...hazards.unresolvedLoads,
  ]
  expect(
    violations.length,
    `${addressFor(artifact)} lacks an executable browser negative`,
  ).toBeGreaterThan(0)
}

async function assertNodeOperated(artifact: OperatedArtifact): Promise<void> {
  const target = await operatedTarget(artifact)
  const source = await readFile(target, "utf8")
  expect(source.length, addressFor(artifact)).toBeGreaterThan(0)
  const check = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" })
  expect(check.status, `${addressFor(artifact)}\n${check.stderr}`).toBe(0)

  if (artifact.selector.startsWith("bin.")) {
    const isScaffolder = artifact.selector === "bin.create-dawn-ai-app"
    const probe = spawnSync(
      process.execPath,
      [target, isScaffolder ? "--definitely-invalid" : "--help"],
      {
        cwd: await packageDirectory(artifact.packageName),
        encoding: "utf8",
        timeout: 15_000,
      },
    )
    expect(probe.status, `${addressFor(artifact)}\n${probe.stderr}`).toBe(isScaffolder ? 1 : 0)
    expect(isScaffolder ? probe.stderr : probe.stdout, addressFor(artifact)).toMatch(
      isScaffolder ? /Unknown argument "--definitely-invalid"/ : /usage|dawn/i,
    )
    return
  }

  await probeInspector(target, artifact)
}

async function probeInspector(target: string, artifact: OperatedArtifact): Promise<void> {
  let lastError = "Inspector did not become ready"
  for (let allocationAttempt = 0; allocationAttempt < 3; allocationAttempt++) {
    const port = await availablePort()
    let stderr = ""
    const child = spawn(process.execPath, [target], {
      cwd: await packageDirectory(artifact.packageName),
      env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    })
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null) {
          lastError = `Inspector exited before readiness: ${stderr}`
          break
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}/healthz`)
          if (response.status === 200) return
        } catch {
          // Retry while the bounded readiness window remains.
        }
        await delay(50)
      }
    } finally {
      await stopChild(child)
    }
    if (!/EADDRINUSE/.test(stderr)) break
  }
  throw new Error(`${addressFor(artifact)}: ${lastError}`)
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  if (await waitForExit(child, 1_000)) return
  child.kill("SIGKILL")
  if (!(await waitForExit(child, 1_000))) throw new Error("Inspector did not exit after SIGKILL")
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return await new Promise<boolean>((resolveExit) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      resolveExit(false)
    }, timeoutMs)
    const onExit = (): void => {
      clearTimeout(timer)
      resolveExit(true)
    }
    child.once("exit", onExit)
  })
}

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(0, "127.0.0.1", resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Unable to reserve test port")
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  )
  return address.port
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function assertBrowserOperatedNegative(artifact: OperatedArtifact): Promise<void> {
  const target = await operatedTarget(artifact)
  await expect(
    build({
      absWorkingDir: repoRoot,
      bundle: true,
      conditions: ["browser", "import"],
      entryPoints: [target],
      format: "esm",
      logLevel: "silent",
      platform: "browser",
      write: false,
    }),
    addressFor(artifact),
  ).rejects.toThrow()
}

type GuardHandler = (artifact: RuntimeArtifact) => Promise<void>
const GUARD_HANDLERS: Record<GuardId, GuardHandler> = {
  "edge-import-bundle": (artifact) => assertEdgeImport(artifact as ImportArtifact),
  "dependency-free-import-graph": (artifact) => assertDependencyFree(artifact as ImportArtifact),
  "node-import-bundle": (artifact) => assertNodeImport(artifact as ImportArtifact),
  "browser-import-negative-control": (artifact) =>
    assertBrowserImportNegative(artifact as ImportArtifact),
  "node-operated-bundle": (artifact) => assertNodeOperated(artifact as OperatedArtifact),
  "browser-operated-negative-control": (artifact) =>
    assertBrowserOperatedNegative(artifact as OperatedArtifact),
}

async function createConditionalFixture(): Promise<string> {
  const packageRoot = join(packageFixtureRoot, "node_modules", "conditional-api-boundary")
  await mkdir(packageRoot, { recursive: true })
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "conditional-api-boundary",
      type: "module",
      exports: {
        ".": {
          browser: "./browser.js",
          node: "./node.js",
          default: "./default.js",
        },
      },
    }),
  )
  await writeFile(
    join(packageRoot, "browser.js"),
    'import "node:fs"; export const target = "browser"',
  )
  await writeFile(join(packageRoot, "node.js"), 'throw new Error("node condition selected")')
  await writeFile(join(packageRoot, "default.js"), 'export const target = "default"')
  return "conditional-api-boundary"
}

describe("API reference compatibility guards", () => {
  it("follows browser and Node package export conditions instead of default targets", async () => {
    const specifier = await createConditionalFixture()
    await expect(
      bundleSpecifier({
        conditions: ["dawn-static-provider-imports", "workerd", "worker", "browser", "import"],
        platform: "browser",
        specifier,
      }),
    ).rejects.toThrow(/Could not resolve/)

    const nodeResult = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(specifier)})`],
      { cwd: packageFixtureRoot, encoding: "utf8" },
    )
    expect(nodeResult.status).toBe(1)
    expect(nodeResult.stderr).toContain("node condition selected")
  })

  it("detects Node globals and unresolved runtime loads without flagging guarded access", async () => {
    const dirty = analyzeRuntimeSource(
      'const g = globalThis; export const a = globalThis.Buffer; export const b = globalThis.process; export const c = g.process; const z = "zod"; const d = "@dawn-ai/" + "sdk"; const n = "node:" + "fs"; import(z); import(d); require(n)',
    )
    expect(dirty.globalProperties).toEqual(["Buffer", "process"])
    expect(dirty.unresolvedLoads).toEqual(["import(d)", "import(z)", "require(n)"])
    expect(analyzeRuntimeSource("export const env = globalThis.process?.env")).toEqual({
      globalProperties: [],
      unresolvedLoads: [],
    })
    expect(
      analyzeRuntimeSourceDetailed("export const env = globalThis.process?.env").globalOccurrences,
    ).toEqual([expect.objectContaining({ guarded: true, property: "process" })])
    expect(
      analyzeRuntimeSource(
        "let g = globalThis; const h = g; const { Buffer } = h; export const unsafe = h.process",
      ).globalProperties,
    ).toEqual(["Buffer", "process"])
    expect(
      analyzeRuntimeSource('const g = globalThis; const key = "Buffer"; g[key]').globalProperties,
    ).toEqual(["Buffer"])
    expect(
      analyzeRuntimeSource(
        'const { "process": p, ["Buffer"]: B, [`global`]: G } = globalThis; export { p, B, G }',
      ).globalProperties,
    ).toEqual(["Buffer", "global", "process"])
    expect(
      analyzeRuntimeSource(
        'const prefix = "pro"; const key = prefix + "cess"; export const value = globalThis[key]',
      ).globalProperties,
    ).toEqual(["process"])
    expect(
      analyzeRuntimeSource("export function unsafe(key: string) { return globalThis[key] }")
        .globalProperties,
    ).toEqual(["globalThis[key]"])
    expect(
      analyzeRuntimeSource(
        "export function unsafe(key: string) { const { [key]: value } = globalThis; return value }",
      ).globalProperties,
    ).toEqual(["[key]"])
    expect(
      analyzeRuntimeSource("export function safe(globalThis: object) { return globalThis.process }")
        .globalProperties,
    ).toEqual([])
    expect(
      analyzeRuntimeSource(
        "const g = globalThis; export function safe(g: object) { return g.process }",
      ).globalProperties,
    ).toEqual([])
    expect(
      analyzeRuntimeSource("const g = globalThis; export function closure() { return g.process }")
        .globalProperties,
    ).toEqual(["process"])
    expect(
      analyzeRuntimeSource("export function closure() { return g.process } const g = globalThis")
        .globalProperties,
    ).toEqual(["process"])
    expect(
      analyzeRuntimeSource(
        "export function safe() { const globalThis = {}; return globalThis.process }",
      ).globalProperties,
    ).toEqual([])
    expect(
      analyzeRuntimeSource("export function safe(process: object) { return process.env }")
        .globalProperties,
    ).toEqual([])
    expect(
      analyzeRuntimeSource(
        "export function safe(globalThis: object, require: (value: unknown) => unknown, process: object, value: unknown) { globalThis.Buffer; require(value); return process.env }",
      ),
    ).toEqual({ globalProperties: [], unresolvedLoads: [] })
    expect(
      analyzeRuntimeSource(`
        function signature(
          g = globalThis,
          value = g.process,
          loaded = import(specifier),
          required = require(specifier),
        ) {}
        class RuntimeMembers {
          [globalThis.Buffer]() {}
          get [globalThis.process]() { return undefined }
          [import(specifier)]() {}
          field = globalThis.Buffer
        }
      `),
    ).toEqual({
      globalProperties: ["Buffer", "process"],
      unresolvedLoads: ["import(specifier)", "require(specifier)"],
    })
    expect(
      analyzeRuntimeSource(
        "export function destructured({ [globalThis.Buffer]: value } = {}) { return value }",
      ).globalProperties,
    ).toEqual(["Buffer"])
    expect(
      analyzeRuntimeSource(
        "@decorate(globalThis.process, import(specifier)) class Decorated { @field(globalThis.Buffer) value = 0; method(@parameter(globalThis.process) globalThis = {}) {} }",
      ),
    ).toEqual({
      globalProperties: ["Buffer", "process"],
      unresolvedLoads: ["import(specifier)"],
    })
    expect(
      analyzeRuntimeSource(
        "let g = globalThis; function uncalled() { g = {} } export const unsafe = g.process",
      ).globalProperties,
    ).toEqual(["process"])
    expect(
      analyzeRuntimeSource(
        "let g = globalThis; if (false) { g = {} } export const unsafe = g.process",
      ).globalProperties,
    ).toEqual(["process"])
    expect(
      analyzeRuntimeSource(
        "let g = {}; if (false) { g = globalThis } export const safe = g.process",
      ).globalProperties,
    ).toEqual(["process"])
    expect(
      analyzeRuntimeSource("let g = globalThis; if (true) { g = {} } export const safe = g.process")
        .globalProperties,
    ).toEqual(["process"])
    expect(
      analyzeRuntimeSource(
        "let g = globalThis; if (condition) { g = {} } export const unsafe = g.process",
      ).globalProperties,
    ).toEqual(["process"])
    expect(
      analyzeRuntimeSource(
        "let g = {}; if (condition) { g = globalThis } export const unsafe = g.process",
      ).globalProperties,
    ).toEqual(["process"])
    for (const branchedSource of [
      "let g = globalThis; switch (value) { case 1: g = {} } export const unsafe = g.process",
      "let g = globalThis; condition ? (g = {}) : undefined; export const unsafe = g.process",
      "let g = globalThis; condition && (g = {}); export const unsafe = g.process",
      "let g = globalThis; while (condition) { g = {} } export const unsafe = g.process",
      "let g = globalThis; try { g = {} } catch {} export const unsafe = g.process",
    ]) {
      expect(analyzeRuntimeSource(branchedSource).globalProperties).toEqual(["process"])
    }
    expect(
      analyzeRuntimeSource("let g = globalThis; g = {}; export const safe = g.process")
        .globalProperties,
    ).toEqual(["process"])
    expect(
      analyzeRuntimeSource("{ var g = globalThis } export const unsafe = g.process")
        .globalProperties,
    ).toEqual(["process"])
    expect(
      analyzeRuntimeSource(
        "export function safe() { return globalThis.process; { var globalThis = {} } }",
      ).globalProperties,
    ).toEqual([])
    expect(
      analyzeRuntimeSource(
        "export function safe(require: unknown, value = require(specifier)) { return value }",
      ).unresolvedLoads,
    ).toEqual([])
    for (const residualHazard of [
      "let g = globalThis; for (let g = {}; false;) {} export const unsafe = g.process",
      "class C { static { var globalThis = {} } } export const unsafe = globalThis.process",
      "const g = globalThis as typeof globalThis; export const unsafe = g.process",
      "const g = globalThis!; export const unsafe = g.process",
      "const g = globalThis satisfies typeof globalThis; export const unsafe = g.process",
      "const g = <typeof globalThis>globalThis; export const unsafe = g.process",
      "let g = {}; switch (x) { case 0: g = globalThis; case 1: g.process }",
      "let g = {}; try { g = globalThis; throw 1 } catch { g.process }",
      "let g = {}, next = globalThis; while (condition) { g.process; g = next; next = {} }",
      "let g = {}; function hazard() { return g.process } g = globalThis",
    ]) {
      expect(analyzeRuntimeSource(residualHazard).globalProperties).toEqual(["process"])
    }
    expect(
      analyzeRuntimeSource(
        "try {} catch (globalThis) { globalThis.process } try {} catch (require) { require(specifier) }",
      ),
    ).toEqual({ globalProperties: [], unresolvedLoads: [] })
    expect(analyzeRuntimeSource("const load = require; load(specifier)").unresolvedLoads).toEqual([
      "load(specifier)",
    ])
    expect(
      analyzeRuntimeSource("let load; load ||= require; load(specifier)").unresolvedLoads,
    ).toEqual(["load(specifier)"])
    expect(
      analyzeRuntimeSource(
        "let g, h; g = h = globalThis; g.process; class C extends globalThis.Buffer {}; class D extends (load = require)(specifier) {}",
      ),
    ).toEqual({
      globalProperties: ["Buffer", "process"],
      unresolvedLoads: ["(load = require)(specifier)"],
    })
    expect(
      analyzeRuntimeSource(
        "const { x: g = globalThis } = {}; const [h = globalThis] = []; let p; ({ process: p } = globalThis); g.process; h.Buffer; p.env",
      ).globalProperties,
    ).toEqual(["Buffer", "process"])
    for (const aggregateEscape of [
      "const [g] = [globalThis]; export const unsafe = g.process",
      "const holder = { g: globalThis }; const { g } = holder; export const unsafe = g.process",
      "class Holder { g = globalThis; static value = { nested: [globalThis] } }",
      "const holder = {}; holder.g = globalThis",
      "const holder = { nested: { values: [...items, globalThis] } }",
      "const { Buffer: B } = globalThis; const holder = { B }",
    ]) {
      expect(
        analyzeRuntimeSource(aggregateEscape).globalProperties.some((property) =>
          property.includes("stored in"),
        ),
        aggregateEscape,
      ).toBe(true)
    }
    expect(
      analyzeRuntimeSource(
        "const safe = {}; const holder = { process: safe, nested: [safe] }; class Holder { value = safe } holder.g = safe",
      ).globalProperties,
    ).toEqual([])
    const duplicateLoads = analyzeRuntimeSourceDetailed(
      "export async function loadMiddleware(path) { await import(path); await import(path) }",
    ).loadOccurrences
    const firstLoad = duplicateLoads[0]
    expect(firstLoad).toBeDefined()
    const fixtureBoundary = { ...COMPUTED_LOAD_BOUNDARIES[0], start: firstLoad?.start ?? -1 }
    expect(
      duplicateLoads.filter((occurrence) =>
        matchesComputedLoadBoundary(
          occurrence,
          "C:\\repo\\packages\\cli\\dist\\lib\\dev\\middleware.js",
          fixtureBoundary,
        ),
      ),
    ).toHaveLength(1)
    const movedLoad = analyzeRuntimeSourceDetailed(
      "export async function moved(path) { await import(path) }",
    ).loadOccurrences[0]
    expect(
      movedLoad
        ? matchesComputedLoadBoundary(
            movedLoad,
            "/repo/packages/cli/dist/lib/dev/middleware.js",
            fixtureBoundary,
          )
        : undefined,
    ).toBe(false)

    const guardedBundle = await build({
      bundle: true,
      define: GLOBAL_SENTINEL_DEFINES,
      format: "esm",
      platform: "browser",
      stdin: {
        contents:
          'export const safe = typeof process === "undefined" ? "" : process.env.X; export const dirty = Buffer.byteLength("x")',
        loader: "js",
      },
      write: false,
    })
    const references = findNodeGlobalReferences(guardedBundle.outputFiles?.[0]?.text ?? "")
    expect(
      new Set(references.filter((reference) => reference.guarded).map(({ global }) => global)),
    ).toEqual(new Set(["process"]))
    expect(
      references.filter((reference) => !reference.guarded).map(({ global }) => global),
    ).toEqual(["Buffer"])
  })

  it("detects every dependency-free violation class", async () => {
    const result = await build({
      absWorkingDir: repoRoot,
      bundle: true,
      external: ["node:*", "@dawn-ai/sdk", "zod"],
      format: "esm",
      logLevel: "silent",
      metafile: true,
      platform: "neutral",
      stdin: {
        contents: 'import "node:fs"; import "@dawn-ai/sdk"; import "zod"',
        loader: "js",
        resolveDir: repoRoot,
      },
      write: false,
    })
    expect(runtimeDependencyEdges(result.metafile as Metafile)).toEqual([
      "@dawn-ai/sdk",
      "node:fs",
      "zod",
    ])
    expect(
      analyzeRuntimeSource(
        'const z = "zod"; const d = "@dawn-ai/" + "sdk"; const n = "node:" + "fs"; import(z); import(d); require(n)',
      ).unresolvedLoads,
    ).toEqual(["import(d)", "import(z)", "require(n)"])
  })

  it("executes every known guard against every exact registry address", async () => {
    const artifacts = await loadRuntimeArtifacts()
    const usedGuardIds = new Set<GuardId>()

    expect(artifacts.length).toBeGreaterThan(0)
    for (const artifact of artifacts) {
      expect(artifact.guardIds, addressFor(artifact)).not.toHaveLength(0)
      for (const guardId of artifact.guardIds) {
        const handler = GUARD_HANDLERS[guardId]
        expect(handler, `${addressFor(artifact)} uses unknown guard ${guardId}`).toBeTypeOf(
          "function",
        )
        usedGuardIds.add(guardId)
        await handler(artifact)
      }
    }

    expect(usedGuardIds).toEqual(new Set(GUARD_IDS))
    expect(Object.keys(GUARD_HANDLERS).sort()).toEqual([...GUARD_IDS].sort())
    expect([...exercisedComputedLoadBoundaries.keys()].sort()).toEqual(
      COMPUTED_LOAD_BOUNDARIES.map(({ pathSuffix }) => pathSuffix).sort(),
    )
    expect(exercisedComputedGlobalBoundaries).toEqual(
      new Set(COMPUTED_GLOBAL_BOUNDARIES.map((_, index) => index)),
    )
  }, 240_000)
})
