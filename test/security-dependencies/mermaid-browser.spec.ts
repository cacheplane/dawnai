import { readFileSync, realpathSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo, Socket } from "node:net"
import { tmpdir } from "node:os"
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"

import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test"
import { build, type Metafile } from "esbuild"

const repositoryRoot = process.cwd()
const testDirectory = resolve(repositoryRoot, "test/security-dependencies")
const browserEntryPath = resolve(testDirectory, "mermaid-browser-entry.tsx")
const benignMarkdown = [
  "## Local UI compatibility",
  "",
  "```mermaid",
  "flowchart LR",
  "  Start[Start] --> Done[Done]",
  "```",
].join("\n")
const architectureMarker = "mermaidPrototypePollutionMarker"
const configMarker = "mermaidConfigPrototypePollutionMarker"
const architectureSource = [
  "architecture-beta",
  `  group ${architectureMarker}(cloud)[Marker]`,
  "  service a(server)[A] in __proto__",
  `  service b(server)[B] in ${architectureMarker}`,
  "  a:R -- L:b",
].join("\n")
const cssMarkdown = [
  "```mermaid",
  "---",
  "config:",
  "  themeCSS: |-",
  "    & + * { background-color: rgb(254, 1, 2) !important; }",
  "---",
  "flowchart LR",
  "  Boundary[CSS boundary]",
  "```",
].join("\n")
const strictMarkdown = [
  "```mermaid",
  "flowchart LR",
  `  Unsafe["<svg><a href='javascript:void 0' onmouseover='void 0'><text>Unsafe</text></a></svg><img src='data:image/gif;base64,R0lGODlhAQABAAAAACw=' onerror='void 0'><style>.mermaidStrictEscapeMarker{display:none}</style>"]`,
  "  Unsafe --> Safe[Strict safe label]",
  "```",
].join("\n")
const maxAssetBytes = 32 * 1024 * 1024
const maxBundleBytes = 64 * 1024 * 1024
const examples = [
  { label: "chat", path: "examples/chat/web" },
  { label: "research", path: "examples/research/web" },
] as const

type Example = (typeof examples)[number]

type JsonRecord = Record<string, unknown>

interface AppGraph {
  readonly appRoot: string
  readonly expectedInputs: readonly string[]
  readonly mermaidEntry: string
}

interface Asset {
  readonly bytes: number
  readonly contentType: string
  readonly path: string
}

interface Bundle {
  readonly assets: ReadonlyMap<string, Asset>
  readonly cssUrls: readonly string[]
  readonly entryUrl: string
  readonly tempRoot: string
}

interface LocalServer {
  readonly close: () => Promise<void>
  readonly missingPaths: readonly string[]
  readonly origin: string
  readonly servedPaths: ReadonlySet<string>
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as JsonRecord
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function readManifest(path: string): JsonRecord {
  return requireRecord(JSON.parse(readFileSync(path, "utf8")), path)
}

function dependencyRange(manifest: JsonRecord, name: string): string {
  return requireString(
    requireRecord(manifest.dependencies, "manifest dependencies")[name],
    `dependencies.${name}`,
  )
}

function findOwningManifest(entryPath: string, packageName: string): string {
  let current = dirname(entryPath)
  for (;;) {
    const candidate = resolve(current, "package.json")
    try {
      if (readManifest(candidate).name === packageName) return candidate
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error
      }
    }
    const parent = dirname(current)
    if (parent === current) {
      throw new Error(`could not find ${packageName} above ${entryPath}`)
    }
    current = parent
  }
}

function requireAppDependencyLink(
  appManifestPath: string,
  childName: string,
  resolvedManifestPath: string,
): string {
  const logicalManifestPath = realpathSync(
    resolve(dirname(appManifestPath), "node_modules", ...childName.split("/"), "package.json"),
  )
  const physicalManifestPath = realpathSync(resolvedManifestPath)
  if (logicalManifestPath !== physicalManifestPath) {
    throw new Error(`app resolved ${childName} outside its own dependency link`)
  }
  return physicalManifestPath
}

function requirePnpmDependencyLink(
  parentManifestPath: string,
  childName: string,
  resolvedManifestPath: string,
): string {
  const pnpmMarker = `${sep}node_modules${sep}.pnpm${sep}`
  const snapshotStart = parentManifestPath.indexOf(pnpmMarker)
  const snapshotNodeModulesStart = parentManifestPath.indexOf(
    `${sep}node_modules${sep}`,
    snapshotStart + pnpmMarker.length,
  )
  if (snapshotStart < 0 || snapshotNodeModulesStart < 0) {
    throw new Error("parent package was not installed in the expected pnpm snapshot")
  }
  const snapshotNodeModules = parentManifestPath.slice(
    0,
    snapshotNodeModulesStart + `${sep}node_modules`.length,
  )
  const logicalManifestPath = realpathSync(
    resolve(snapshotNodeModules, ...childName.split("/"), "package.json"),
  )
  const physicalManifestPath = realpathSync(resolvedManifestPath)
  if (logicalManifestPath !== physicalManifestPath) {
    throw new Error(`parent package resolved ${childName} outside its own dependency link`)
  }
  return physicalManifestPath
}

function importExport(manifest: JsonRecord, subpath: string): string {
  const exports = requireRecord(manifest.exports, "manifest exports")
  const target = exports[subpath]
  if (typeof target === "string") return target
  const conditions = requireRecord(target, `exports.${subpath}`)
  const imported = conditions.import
  if (typeof imported === "string") return imported
  const importConditions = requireRecord(imported, `exports.${subpath}.import`)
  return requireString(importConditions.default, `exports.${subpath}.import.default`)
}

function resolveAppGraph(appRelativePath: string): AppGraph {
  const appRoot = resolve(repositoryRoot, appRelativePath)
  const appManifestPath = resolve(appRoot, "package.json")
  const appManifest = readManifest(appManifestPath)
  if (dependencyRange(appManifest, "@copilotkit/react-core") !== "^1.69.0") {
    throw new Error("example does not declare the reviewed React Core range")
  }

  const reactCoreManifestPath = requireAppDependencyLink(
    appManifestPath,
    "@copilotkit/react-core",
    createRequire(appManifestPath).resolve("@copilotkit/react-core/package.json"),
  )
  const reactCoreManifest = readManifest(reactCoreManifestPath)
  if (dependencyRange(reactCoreManifest, "streamdown") !== "^1.3.0") {
    throw new Error("React Core does not declare the reviewed Streamdown range")
  }

  const streamdownEntry = createRequire(reactCoreManifestPath).resolve("streamdown")
  const streamdownManifestPath = requirePnpmDependencyLink(
    reactCoreManifestPath,
    "streamdown",
    findOwningManifest(streamdownEntry, "streamdown"),
  )
  const streamdownManifest = readManifest(streamdownManifestPath)
  if (dependencyRange(streamdownManifest, "mermaid") !== "^11.11.0") {
    throw new Error("Streamdown does not declare the reviewed Mermaid range")
  }

  const mermaidManifestPath = requirePnpmDependencyLink(
    streamdownManifestPath,
    "mermaid",
    createRequire(streamdownManifestPath).resolve("mermaid/package.json"),
  )
  const mermaidManifest = readManifest(mermaidManifestPath)
  if (dependencyRange(mermaidManifest, "dompurify") !== "^3.3.3") {
    throw new Error("Mermaid does not declare the reviewed DOMPurify range")
  }
  const dompurifyEntry = createRequire(mermaidManifestPath).resolve("dompurify")
  const dompurifyManifestPath = requirePnpmDependencyLink(
    mermaidManifestPath,
    "dompurify",
    findOwningManifest(dompurifyEntry, "dompurify"),
  )
  const dompurifyManifest = readManifest(dompurifyManifestPath)

  const mermaidEntry = resolve(
    dirname(mermaidManifestPath),
    requireString(mermaidManifest.module, "mermaid module"),
  )

  return {
    appRoot,
    expectedInputs: [
      resolve(dirname(reactCoreManifestPath), importExport(reactCoreManifest, "./v2")),
      resolve(dirname(streamdownManifestPath), importExport(streamdownManifest, ".")),
      mermaidEntry,
      resolve(
        dirname(dompurifyManifestPath),
        requireString(dompurifyManifest.module, "dompurify module"),
      ),
    ],
    mermaidEntry,
  }
}

function outputPath(key: string): string {
  return isAbsolute(key) ? key : resolve(repositoryRoot, key)
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`)
}

function contentType(extension: string): string {
  switch (extension) {
    case ".css":
      return "text/css; charset=utf-8"
    case ".js":
      return "text/javascript; charset=utf-8"
    case ".ttf":
      return "font/ttf"
    case ".woff":
      return "font/woff"
    case ".woff2":
      return "font/woff2"
    default:
      throw new Error(`unexpected emitted asset extension ${extension}`)
  }
}

async function assertActualUiInputs(
  metafile: Metafile,
  expectedInputs: readonly string[],
): Promise<void> {
  const actual = new Set(
    await Promise.all(
      Object.keys(metafile.inputs)
        .filter((path) => !path.endsWith("/mermaid-browser-entry.tsx"))
        .map((path) => realpath(outputPath(path))),
    ),
  )
  for (const expected of expectedInputs) {
    expect(actual.has(await realpath(expected))).toBe(true)
  }
}

async function buildExampleBundle(appRelativePath: string): Promise<Bundle> {
  const graph = resolveAppGraph(appRelativePath)
  const tempRoot = await mkdtemp(resolve(tmpdir(), "dawn-mermaid-ui-"))
  const outdir = resolve(tempRoot, "bundle")
  try {
    const entrySource = await readFile(browserEntryPath, "utf8")
    const result = await build({
      absWorkingDir: repositoryRoot,
      assetNames: "assets/font-[hash]",
      bundle: true,
      chunkNames: "assets/chunk-[hash]",
      conditions: ["browser", "import", "default"],
      define: {
        "process.env.NODE_ENV": '"production"',
      },
      entryNames: "assets/ui-[hash]",
      format: "esm",
      jsx: "automatic",
      legalComments: "none",
      loader: {
        ".ttf": "file",
        ".woff": "file",
        ".woff2": "file",
      },
      logLevel: "silent",
      mainFields: ["browser", "module", "main"],
      metafile: true,
      minify: true,
      outdir,
      platform: "browser",
      plugins: [
        {
          name: "dawn-resolved-mermaid",
          setup(context) {
            context.onResolve({ filter: /^dawn-resolved-mermaid$/ }, () => ({
              path: graph.mermaidEntry,
            }))
          },
        },
      ],
      splitting: true,
      stdin: {
        contents: entrySource,
        loader: "tsx",
        resolveDir: graph.appRoot,
        sourcefile: "mermaid-browser-entry.tsx",
      },
      target: ["chrome120"],
      treeShaking: true,
      write: true,
    })
    await assertActualUiInputs(result.metafile, graph.expectedInputs)

    const assets = new Map<string, Asset>()
    const cssUrls: string[] = []
    let entryUrl: string | undefined
    let totalBytes = 0
    for (const [key, metadata] of Object.entries(result.metafile.outputs)) {
      const absolute = outputPath(key)
      if (!isContained(outdir, absolute)) {
        throw new Error("esbuild emitted an asset outside its temporary outdir")
      }
      const file = await stat(absolute)
      if (!file.isFile() || file.size === 0 || file.size > maxAssetBytes) {
        throw new Error("esbuild emitted an invalid or oversized asset")
      }
      totalBytes += file.size
      const extension = extname(absolute)
      const relativePath = relative(outdir, absolute).split(sep).join("/")
      const url = `/${relativePath}`
      if (!/^\/assets\/[A-Za-z0-9._/-]+$/u.test(url)) {
        throw new Error("esbuild emitted an unsafe asset path")
      }
      assets.set(url, {
        bytes: file.size,
        contentType: contentType(extension),
        path: absolute,
      })
      if (extension === ".css") cssUrls.push(url)
      if (
        extension === ".js" &&
        metadata.entryPoint?.endsWith("/mermaid-browser-entry.tsx") === true
      ) {
        if (entryUrl !== undefined) {
          throw new Error("esbuild emitted more than one browser entry")
        }
        entryUrl = url
      }
    }
    if (totalBytes > maxBundleBytes) {
      throw new Error("esbuild emitted an oversized browser bundle")
    }
    if (entryUrl === undefined || cssUrls.length === 0) {
      throw new Error("esbuild did not emit the expected JavaScript and CSS")
    }
    return {
      assets,
      cssUrls: cssUrls.sort(),
      entryUrl,
      tempRoot,
    }
  } catch (error) {
    await rm(tempRoot, { force: true, recursive: true })
    throw error
  }
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
}

async function startLocalServer(bundle: Bundle): Promise<LocalServer> {
  const missingPaths: string[] = []
  const servedPaths = new Set<string>()
  const sockets = new Set<Socket>()
  const styles = bundle.cssUrls
    .map((url) => `<link rel="stylesheet" href="${escapeHtmlAttribute(url)}">`)
    .join("")
  const html = Buffer.from(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'">${styles}</head><body><main id="root"></main><script type="module" src="${escapeHtmlAttribute(bundle.entryUrl)}"></script></body></html>`,
    "utf8",
  )
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" || request.url === undefined) {
        response.writeHead(405, { "Cache-Control": "no-store" }).end()
        return
      }
      const url = new URL(request.url, "http://127.0.0.1")
      if (url.search !== "") {
        missingPaths.push(url.pathname)
        response.writeHead(404, { "Cache-Control": "no-store" }).end()
        return
      }
      if (url.pathname === "/") {
        servedPaths.add("/")
        response
          .writeHead(200, {
            "Cache-Control": "no-store",
            "Content-Length": String(html.byteLength),
            "Content-Type": "text/html; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
          })
          .end(html)
        return
      }
      const asset = bundle.assets.get(url.pathname)
      if (asset === undefined) {
        missingPaths.push(url.pathname.slice(0, 200))
        response.writeHead(404, { "Cache-Control": "no-store" }).end()
        return
      }
      const body = await readFile(asset.path)
      if (body.byteLength !== asset.bytes) {
        throw new Error("emitted asset changed while being served")
      }
      servedPaths.add(url.pathname)
      response
        .writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Length": String(body.byteLength),
          "Content-Type": asset.contentType,
          "X-Content-Type-Options": "nosniff",
        })
        .end(body)
    } catch {
      response.writeHead(500, { "Cache-Control": "no-store" }).end()
    }
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolveListen()
    })
  })
  const address = server.address() as AddressInfo | null
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    server.closeAllConnections()
    throw new Error("browser asset server did not bind random IPv4 loopback")
  }
  return {
    async close() {
      server.closeAllConnections()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolveClose()
        })
      })
    },
    missingPaths,
    origin: `http://127.0.0.1:${address.port}`,
    servedPaths,
  }
}

function boundedDiagnostic(value: string): string {
  return value.replaceAll(/[\r\n]+/gu, " ").slice(0, 500)
}

function mermaidSvg(page: Page) {
  return page
    .locator('[data-streamdown="mermaid-block"] [role="img"][aria-label="Mermaid chart"] > svg')
    .first()
}

async function renderMarkdown(page: Page, content: string): Promise<void> {
  await page.evaluate((markdown) => {
    const harness = (
      window as Window & {
        __dawnMermaidHarness?: { render(content: string): void }
      }
    ).__dawnMermaidHarness
    if (harness === undefined) throw new Error("browser harness unavailable")
    harness.render(markdown)
  }, content)
}

async function assertVisibleDiagram(page: Page, labels: readonly string[]): Promise<void> {
  const svg = mermaidSvg(page)
  await expect(svg).toBeVisible()
  for (const label of labels) await expect(svg).toContainText(label)
  const bounds = await svg.boundingBox()
  expect(bounds?.width ?? 0).toBeGreaterThan(0)
  expect(bounds?.height ?? 0).toBeGreaterThan(0)
}

async function unmountHarness(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = (
      window as Window & {
        __dawnMermaidHarness?: { unmount(): void }
      }
    ).__dawnMermaidHarness
    if (harness === undefined) throw new Error("browser harness unavailable")
    harness.unmount()
  })
}

async function runExampleCase(
  browser: Browser,
  example: Example,
  action: (page: Page) => Promise<void>,
): Promise<void> {
  const bundle = await buildExampleBundle(example.path)
  let localServer: LocalServer | undefined
  let context: BrowserContext | undefined
  let caseFailed = false
  let caseError: unknown
  const cleanupErrors: unknown[] = []
  try {
    localServer = await startLocalServer(bundle)
    context = await browser.newContext({ serviceWorkers: "block" })
    const diagnostics: string[] = []
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url())
      if (url.origin === localServer?.origin) {
        await route.continue()
        return
      }
      diagnostics.push(boundedDiagnostic(`blocked non-loopback request ${url.origin}`))
      await route.abort("blockedbyclient")
    })
    const page = await context.newPage()
    page.on("console", (message) => {
      if (message.type() === "error") {
        diagnostics.push(boundedDiagnostic(`console: ${message.text()}`))
      }
    })
    page.on("pageerror", (error) => {
      diagnostics.push(boundedDiagnostic(`page: ${error.message}`))
    })
    page.on("requestfailed", (request) => {
      diagnostics.push(
        boundedDiagnostic(
          `request: ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? "failed"}`,
        ),
      )
    })

    await page.goto(localServer.origin, { waitUntil: "domcontentloaded" })
    await page.waitForFunction(
      () =>
        typeof (
          window as Window & {
            __dawnMermaidHarness?: { render?: unknown }
          }
        ).__dawnMermaidHarness?.render === "function",
    )
    await renderMarkdown(page, benignMarkdown)
    await assertVisibleDiagram(page, ["Start", "Done"])

    await action(page)

    expect(diagnostics).toEqual([])
    expect(localServer.missingPaths).toEqual([])
    expect(localServer.servedPaths.has("/")).toBe(true)
    expect(localServer.servedPaths.has(bundle.entryUrl)).toBe(true)
    for (const cssUrl of bundle.cssUrls) {
      expect(localServer.servedPaths.has(cssUrl)).toBe(true)
    }
    await unmountHarness(page)
  } catch (error) {
    caseFailed = true
    caseError = error
  } finally {
    if (context !== undefined) {
      try {
        await context.close()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (localServer !== undefined) {
      try {
        await localServer.close()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await rm(bundle.tempRoot, { force: true, recursive: true })
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (caseFailed) {
    if (cleanupErrors.length === 0) throw caseError
    throw new AggregateError(
      [caseError, ...cleanupErrors],
      "browser Mermaid case and cleanup both failed",
    )
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "browser Mermaid cleanup failed")
  }
}

async function assertStrictIntegration(page: Page): Promise<void> {
  await renderMarkdown(page, strictMarkdown)
  await assertVisibleDiagram(page, ["Strict safe label"])
  const receipt = await page.locator("#root").evaluate((root) => {
    const svg = root.querySelector(
      '[data-streamdown="mermaid-block"] [role="img"][aria-label="Mermaid chart"] > svg',
    )
    if (svg === null) throw new Error("strict Mermaid SVG is missing")
    const blockedElements = root.querySelector("script, iframe, object, embed")
    let eventAttributes = 0
    let executableUrls = 0
    for (const element of root.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        if (/^on/iu.test(attribute.name)) eventAttributes += 1
        if (
          /^(?:action|formaction|href|src|xlink:href)$/iu.test(attribute.name) &&
          /^\s*javascript:/iu.test(attribute.value)
        ) {
          executableUrls += 1
        }
      }
    }
    return {
      blockedElements: blockedElements?.tagName ?? null,
      escapingCss: [...root.querySelectorAll("style")].some((style) =>
        (style.textContent ?? "").includes("mermaidStrictEscapeMarker"),
      ),
      eventAttributes,
      executableUrls,
    }
  })
  expect(receipt).toEqual({
    blockedElements: null,
    escapingCss: false,
    eventAttributes: 0,
    executableUrls: 0,
  })
}

for (const example of examples) {
  test(`${example.label} renders benign content and keeps strict input sanitized`, async ({
    browser,
  }) => {
    await runExampleCase(browser, example, assertStrictIntegration)
  })
}

test("chat keeps the browser prototype clean after architecture rendering", async ({ browser }) => {
  await runExampleCase(browser, examples[0], async (page) => {
    const receipt = await page.evaluate(
      async ({ marker, source }) => {
        const harness = (
          window as Window & {
            __dawnMermaidHarness?: {
              renderMermaid(id: string, value: string): Promise<void>
            }
          }
        ).__dawnMermaidHarness
        if (harness === undefined) throw new Error("browser harness unavailable")
        const before = Object.hasOwn(Object.prototype, marker)
        let settled: "fulfilled" | "rejected" = "fulfilled"
        try {
          await harness.renderMermaid("dawn-browser-architecture", source)
        } catch {
          settled = "rejected"
        }
        const after = Object.hasOwn(Object.prototype, marker)
        Reflect.deleteProperty(Object.prototype, marker)
        return { after, before, settled }
      },
      { marker: architectureMarker, source: architectureSource },
    )
    expect(receipt).toMatchObject({ after: false, before: false })
    expect(receipt.settled).toMatch(/^(?:fulfilled|rejected)$/u)
  })
})

test("chat keeps the browser prototype clean after configuration", async ({ browser }) => {
  await runExampleCase(browser, examples[0], async (page) => {
    const receipt = await page.evaluate((marker) => {
      const harness = (
        window as Window & {
          __dawnMermaidHarness?: {
            inspectMermaidConfig(marker: string): {
              readonly markerAbsent: boolean
              readonly prototypeClean: boolean
            }
            initializeMermaid(config: Readonly<Record<string, unknown>>): void
          }
        }
      ).__dawnMermaidHarness
      if (harness === undefined) throw new Error("browser harness unavailable")
      const activeConfigBefore = harness.inspectMermaidConfig(marker)
      const objectPrototypeCleanBefore = !Object.hasOwn(Object.prototype, marker)
      let settled: "fulfilled" | "rejected" = "fulfilled"
      try {
        harness.initializeMermaid({
          ["__proto__"]: { [marker]: true },
          securityLevel: "strict",
          startOnLoad: false,
          suppressErrorRendering: true,
        })
      } catch {
        settled = "rejected"
      }
      const activeConfigAfter = harness.inspectMermaidConfig(marker)
      const objectPrototypeCleanAfter = !Object.hasOwn(Object.prototype, marker)
      Reflect.deleteProperty(Object.prototype, marker)
      return {
        activeConfigAfter,
        activeConfigBefore,
        objectPrototypeCleanAfter,
        objectPrototypeCleanBefore,
        settled,
      }
    }, configMarker)
    expect(receipt).toMatchObject({
      activeConfigAfter: { markerAbsent: true, prototypeClean: true },
      activeConfigBefore: { markerAbsent: true, prototypeClean: true },
      objectPrototypeCleanAfter: true,
      objectPrototypeCleanBefore: true,
    })
    expect(receipt.settled).toMatch(/^(?:fulfilled|rejected)$/u)
  })
})

test("chat contains Mermaid sibling CSS inside the generated SVG", async ({ browser }) => {
  await runExampleCase(browser, examples[0], async (page) => {
    await renderMarkdown(page, cssMarkdown)
    await assertVisibleDiagram(page, ["CSS boundary"])
    const receipt = await mermaidSvg(page).evaluate((svg) => {
      const parent = svg.parentElement
      if (parent === null) throw new Error("generated SVG has no parent")
      const sentinel = document.createElement("div")
      sentinel.id = "dawn-css-sibling-sentinel"
      sentinel.style.backgroundColor = "rgb(1, 2, 3)"
      sentinel.textContent = "CSS sibling sentinel"
      parent.insertBefore(sentinel, svg.nextSibling)
      return {
        backgroundColor: getComputedStyle(sentinel).backgroundColor,
        immediateSibling: svg.nextElementSibling === sentinel,
        sameParent: sentinel.parentElement === parent,
      }
    })
    expect(receipt).toEqual({
      backgroundColor: "rgb(1, 2, 3)",
      immediateSibling: true,
      sameParent: true,
    })
  })
})
