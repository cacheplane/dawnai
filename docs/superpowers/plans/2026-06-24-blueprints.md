# Blueprints (`dawn add`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship flue-style integration blueprints — served Markdown guides a coding agent applies — via `dawn add <name>`, with the mechanism + four exemplar blueprints.

**Architecture:** Blueprint content lives in `apps/web/content/blueprints/<category>/<name>.md` (identity = filename, category = directory). A shared loader (`apps/web/lib/blueprints.ts`, using `gray-matter`) is consumed by two Next route handlers (`/blueprints/[name].md` and `/blueprints/index.json`) and a content-validation test. The `dawn add` CLI command fetches those served endpoints and prints the guide for a coding agent. A docs page documents usage + authoring.

**Tech Stack:** TypeScript, Next 16 route handlers, `gray-matter`, commander, vitest, Node `fetch` (≥22).

**Design spec:** `docs/superpowers/specs/2026-06-24-blueprints-design.md`

**Grounded conventions (verified in repo):**
- apps/web vitest `include` is `["app/**/*.test.ts"]` — **test files must live under `app/`** (libs may live elsewhere and be imported).
- Dynamic route param is a Promise in Next 16: `GET(_req, ctx: { params: Promise<{ name: string }> })`, `const { name } = await ctx.params` (see `app/prompts/[slug]/route.ts`).
- CLI command pattern: `register<Name>Command(program, io)` + `run<Name>Command(args, io)` in `src/commands/*.ts`, wired in `src/index.ts`; output via `CommandIo` (`io.stdout`/`io.stderr`) + `writeLine`/`CliError` from `src/lib/output.ts`.
- `gray-matter` is an apps/web dependency: `import matter from "gray-matter"; const { data, content } = matter(raw)`.

---

## Task 1: Shared blueprint loader + validator

**Files:**
- Create: `apps/web/lib/blueprints.ts`
- Test: `apps/web/app/blueprints/blueprints-lib.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/blueprints/blueprints-lib.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { getBlueprint, loadBlueprints, validateBlueprints } from "../../lib/blueprints"

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dawn-bp-"))
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, body)
  }
  return dir
}

const GOOD = "---\ndescription: Add OTel tracing.\nwebsite: https://opentelemetry.io\nversion: 1\ntags: [otel]\nsource: official\n---\n\n# Add OpenTelemetry\n\nBody.\n"

describe("loadBlueprints()", () => {
  it("derives name from filename and category from directory, sorted by name", () => {
    const dir = fixture({
      "observability/opentelemetry.md": GOOD,
      "retrieval/pgvector.md": "---\ndescription: pgvector.\n---\n# pgvector\n",
    })
    const all = loadBlueprints(dir)
    expect(all.map((e) => e.meta.name)).toEqual(["opentelemetry", "pgvector"])
    const otel = all[0]!
    expect(otel.meta.category).toBe("observability")
    expect(otel.meta.description).toBe("Add OTel tracing.")
    expect(otel.meta.version).toBe(1)
    expect(otel.meta.url).toBe("https://dawnai.org/blueprints/opentelemetry.md")
    expect(otel.body).toContain("# Add OpenTelemetry")
    expect(otel.body).not.toContain("description:")
  })

  it("defaults version to 1, tags to [], source to official when omitted", () => {
    const dir = fixture({ "retrieval/pgvector.md": "---\ndescription: x.\n---\n# pgvector\n" })
    const e = loadBlueprints(dir)[0]!
    expect(e.meta.version).toBe(1)
    expect(e.meta.tags).toEqual([])
    expect(e.meta.source).toBe("official")
  })
})

describe("getBlueprint()", () => {
  it("resolves by flat name across categories; undefined when missing", () => {
    const dir = fixture({ "observability/opentelemetry.md": GOOD })
    expect(getBlueprint("opentelemetry", dir)?.meta.category).toBe("observability")
    expect(getBlueprint("nope", dir)).toBeUndefined()
  })
})

describe("validateBlueprints()", () => {
  it("returns no errors for a well-formed catalog", () => {
    const dir = fixture({ "observability/opentelemetry.md": GOOD })
    expect(validateBlueprints(dir)).toEqual([])
  })

  it("flags missing description, bad category, bad source, duplicate name, and missing H1", () => {
    const dir = fixture({
      "observability/nodesc.md": "---\nsource: official\n---\n# No desc\n",
      "bogus/x.md": "---\ndescription: y.\n---\n# X\n",
      "retrieval/badsrc.md": "---\ndescription: y.\nsource: vendor\n---\n# Bad\n",
      "observability/dup.md": "---\ndescription: a.\n---\n# Dup\n",
      "retrieval/dup.md": "---\ndescription: b.\n---\n# Dup2\n",
      "deploy/noh1.md": "---\ndescription: z.\n---\n\nNo heading here.\n",
    })
    const errors = validateBlueprints(dir).join("\n")
    expect(errors).toContain("nodesc")
    expect(errors).toContain('category "bogus"')
    expect(errors).toContain("badsrc")
    expect(errors).toContain("duplicate name")
    expect(errors).toContain("noh1")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter web exec vitest run app/blueprints/blueprints-lib.test.ts`
Expected: FAIL — `../../lib/blueprints` not found.

- [ ] **Step 3: Implement the loader**

Create `apps/web/lib/blueprints.ts`:

```ts
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import matter from "gray-matter"

export const ALLOWED_CATEGORIES = ["observability", "retrieval", "deploy"] as const
export type BlueprintCategory = (typeof ALLOWED_CATEGORIES)[number]
export type BlueprintSource = "official" | "maintainer" | "community"

export interface BlueprintMeta {
  readonly name: string
  readonly category: string
  readonly description: string
  readonly website?: string
  readonly version: number
  readonly tags: readonly string[]
  readonly source: BlueprintSource
  readonly url: string
}

export interface BlueprintEntry {
  readonly meta: BlueprintMeta
  readonly body: string
}

const SITE = "https://dawnai.org"
const DEFAULT_DIR = join(process.cwd(), "content/blueprints")

function parseEntry(category: string, name: string, raw: string): BlueprintEntry {
  const { data, content } = matter(raw)
  const meta: BlueprintMeta = {
    name,
    category,
    description: typeof data.description === "string" ? data.description : "",
    ...(typeof data.website === "string" ? { website: data.website } : {}),
    version: typeof data.version === "number" ? data.version : 1,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    source: (typeof data.source === "string" ? data.source : "official") as BlueprintSource,
    url: `${SITE}/blueprints/${name}.md`,
  }
  return { meta, body: content.replace(/^\n+/, "") }
}

export function loadBlueprints(dir: string = DEFAULT_DIR): BlueprintEntry[] {
  if (!existsSync(dir)) {
    return []
  }
  const entries: BlueprintEntry[] = []
  for (const cat of readdirSync(dir, { withFileTypes: true })) {
    if (!cat.isDirectory()) {
      continue
    }
    for (const file of readdirSync(join(dir, cat.name))) {
      if (!file.endsWith(".md")) {
        continue
      }
      const name = file.replace(/\.md$/, "")
      entries.push(parseEntry(cat.name, name, readFileSync(join(dir, cat.name, file), "utf8")))
    }
  }
  return entries.sort((a, b) => a.meta.name.localeCompare(b.meta.name))
}

export function getBlueprint(name: string, dir: string = DEFAULT_DIR): BlueprintEntry | undefined {
  return loadBlueprints(dir).find((entry) => entry.meta.name === name)
}

export function validateBlueprints(dir: string = DEFAULT_DIR): string[] {
  const errors: string[] = []
  const seen = new Map<string, string>()
  for (const { meta, body } of loadBlueprints(dir)) {
    const id = `${meta.category}/${meta.name}`
    if (!(ALLOWED_CATEGORIES as readonly string[]).includes(meta.category)) {
      errors.push(`${id}: category "${meta.category}" not in ${ALLOWED_CATEGORIES.join(", ")}`)
    }
    const prior = seen.get(meta.name)
    if (prior) {
      errors.push(`${id}: duplicate name (also ${prior})`)
    } else {
      seen.set(meta.name, id)
    }
    if (meta.description.trim() === "") {
      errors.push(`${id}: missing required "description"`)
    }
    if (!Number.isInteger(meta.version) || meta.version < 1) {
      errors.push(`${id}: version must be a positive integer`)
    }
    if (!(["official", "maintainer", "community"] as readonly string[]).includes(meta.source)) {
      errors.push(`${id}: source "${meta.source}" must be official, maintainer, or community`)
    }
    if (meta.website !== undefined) {
      try {
        new URL(meta.website)
      } catch {
        errors.push(`${id}: website is not a valid URL`)
      }
    }
    if (!/^#\s/m.test(body)) {
      errors.push(`${id}: body must contain an H1 heading`)
    }
  }
  return errors
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter web exec vitest run app/blueprints/blueprints-lib.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint + commit**

Run: `pnpm --filter web lint`
Expected: exits 0 (fix only the two new files if biome complains).

```bash
git add apps/web/lib/blueprints.ts apps/web/app/blueprints/blueprints-lib.test.ts
git commit -m "feat(web): blueprint loader + validator (flat name, dir=category)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Serving routes

**Files:**
- Create: `apps/web/app/blueprints/[name]/route.ts`
- Create: `apps/web/app/blueprints/index.json/route.ts`
- Test: `apps/web/app/blueprints/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/blueprints/routes.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { GET as catalogGet } from "./index.json/route"
import { GET as itemGet } from "./[name]/route"

describe("/blueprints/index.json", () => {
  it("returns the catalog as JSON with derived name/category and url", async () => {
    const res = catalogGet()
    expect(res.headers.get("content-type")).toContain("application/json")
    const catalog = (await res.json()) as Array<{ name: string; category: string; url: string }>
    expect(Array.isArray(catalog)).toBe(true)
    const otel = catalog.find((c) => c.name === "opentelemetry")
    expect(otel?.category).toBe("observability")
    expect(otel?.url).toBe("https://dawnai.org/blueprints/opentelemetry.md")
  })
})

describe("/blueprints/[name].md", () => {
  it("returns the markdown body (frontmatter stripped) for a known name", async () => {
    const res = await itemGet(new Request("https://x/blueprints/opentelemetry.md"), {
      params: Promise.resolve({ name: "opentelemetry.md" }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/markdown")
    const text = await res.text()
    expect(text).toMatch(/^#\s/m)
    expect(text).not.toContain("description:")
  })

  it("404s for an unknown name", async () => {
    const res = await itemGet(new Request("https://x/blueprints/nope.md"), {
      params: Promise.resolve({ name: "nope.md" }),
    })
    expect(res.status).toBe(404)
  })
})
```

> Note: this test reads the **real** `content/blueprints/` tree, so it depends on Task 5 (`opentelemetry`) existing. If running Task 2 before the exemplars, temporarily create `apps/web/content/blueprints/observability/opentelemetry.md` with a minimal valid body; Task 5 replaces it. The plan's execution order (1→2→…→8) means the exemplars land after; the verification gate (Task 9) re-runs these against the real content.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter web exec vitest run app/blueprints/routes.test.ts`
Expected: FAIL — route modules not found.

- [ ] **Step 3: Implement the item route**

Create `apps/web/app/blueprints/[name]/route.ts`:

```ts
import { NextResponse } from "next/server"
import { getBlueprint, loadBlueprints } from "../../../lib/blueprints"

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params
  const slug = name.replace(/\.md$/, "")
  const entry = getBlueprint(slug)
  if (!entry) {
    return NextResponse.json({ error: `Unknown blueprint "${slug}"` }, { status: 404 })
  }
  return new NextResponse(entry.body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  })
}

export function generateStaticParams() {
  return loadBlueprints().map((entry) => ({ name: `${entry.meta.name}.md` }))
}
```

- [ ] **Step 4: Implement the catalog route**

Create `apps/web/app/blueprints/index.json/route.ts`:

```ts
import { NextResponse } from "next/server"
import { loadBlueprints } from "../../../lib/blueprints"

export function GET() {
  return NextResponse.json(loadBlueprints().map((entry) => entry.meta))
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter web exec vitest run app/blueprints/routes.test.ts`
Expected: PASS (after a minimal/real `opentelemetry.md` exists — see the note in Step 1).

- [ ] **Step 6: Typecheck + lint + commit**

Run: `pnpm --filter web typecheck && pnpm --filter web lint`
Expected: both exit 0.

```bash
git add apps/web/app/blueprints/[name]/route.ts apps/web/app/blueprints/index.json/route.ts apps/web/app/blueprints/routes.test.ts
git commit -m "feat(web): serve /blueprints/[name].md and /blueprints/index.json

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `dawn add` command

**Files:**
- Create: `packages/cli/src/commands/add.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/add-command.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/add-command.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { runAddCommand } from "../src/commands/add.js"
import { CliError } from "../src/lib/output.js"

function fakeIo() {
  const out: string[] = []
  const err: string[] = []
  return { io: { stdout: (m: string) => out.push(m), stderr: (m: string) => err.push(m) }, out, err }
}

const CATALOG = JSON.stringify([
  { name: "opentelemetry", category: "observability", description: "OTel tracing." },
  { name: "pgvector", category: "retrieval", description: "pgvector search." },
])

function fetchStub(routes: Record<string, { status: number; body: string }>): typeof fetch {
  return (async (url: string | URL) => {
    const key = String(url)
    const hit = routes[key]
    if (!hit) {
      return new Response("not found", { status: 404 })
    }
    return new Response(hit.body, { status: hit.status })
  }) as unknown as typeof fetch
}

const BASE = "https://dawnai.org"

describe("runAddCommand()", () => {
  it("lists the catalog grouped by category when no target is given", async () => {
    const { io, out } = fakeIo()
    const fetchImpl = fetchStub({ [`${BASE}/blueprints/index.json`]: { status: 200, body: CATALOG } })
    await runAddCommand({ fetchImpl }, io)
    const text = out.join("\n")
    expect(text).toContain("observability:")
    expect(text).toContain("opentelemetry — OTel tracing.")
    expect(text).toContain("retrieval:")
  })

  it("prints the guide body for a known name", async () => {
    const { io, out } = fakeIo()
    const fetchImpl = fetchStub({
      [`${BASE}/blueprints/opentelemetry.md`]: { status: 200, body: "# Add OpenTelemetry\n\nDo it.\n" },
    })
    await runAddCommand({ target: "opentelemetry", fetchImpl }, io)
    const text = out.join("\n")
    expect(text).toContain("Apply this Dawn blueprint: opentelemetry")
    expect(text).toContain("# Add OpenTelemetry")
  })

  it("errors with the catalog list on an unknown name", async () => {
    const { io, err } = fakeIo()
    const fetchImpl = fetchStub({
      [`${BASE}/blueprints/nope.md`]: { status: 404, body: "" },
      [`${BASE}/blueprints/index.json`]: { status: 200, body: CATALOG },
    })
    await expect(runAddCommand({ target: "nope", fetchImpl }, io)).rejects.toBeInstanceOf(CliError)
    expect(err.join("\n")).toContain("opentelemetry")
  })

  it("fetches an absolute URL verbatim", async () => {
    const { io, out } = fakeIo()
    const url = "https://example.com/my-blueprint.md"
    const fetchImpl = fetchStub({ [url]: { status: 200, body: "# Custom\n" } })
    await runAddCommand({ target: url, fetchImpl }, io)
    expect(out.join("\n")).toContain("# Custom")
  })

  it("honors an explicit baseUrl override", async () => {
    const { io, out } = fakeIo()
    const base = "http://localhost:4321"
    const fetchImpl = fetchStub({ [`${base}/blueprints/opentelemetry.md`]: { status: 200, body: "# X\n" } })
    await runAddCommand({ target: "opentelemetry", baseUrl: base, fetchImpl }, io)
    expect(out.join("\n")).toContain("# X")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/cli exec vitest run test/add-command.test.ts`
Expected: FAIL — `../src/commands/add.js` not found.

- [ ] **Step 3: Implement the command**

Create `packages/cli/src/commands/add.ts`:

```ts
import type { Command } from "commander"

import { CliError, type CommandIo, writeLine } from "../lib/output.js"

interface AddArgs {
  readonly target?: string
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
}

interface CatalogEntry {
  readonly name: string
  readonly category: string
  readonly description: string
}

function resolveBaseUrl(explicit?: string): string {
  return explicit ?? process.env.DAWN_BLUEPRINTS_URL ?? "https://dawnai.org"
}

function isUrl(value: string): boolean {
  return /^https?:\/\//.test(value)
}

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ status: number; text: string }> {
  let res: Response
  try {
    res = await fetchImpl(url)
  } catch (error) {
    throw new CliError(
      `Failed to reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { status: res.status, text: await res.text() }
}

async function loadCatalog(fetchImpl: typeof fetch, base: string): Promise<CatalogEntry[]> {
  const { status, text } = await fetchText(fetchImpl, `${base}/blueprints/index.json`)
  if (status !== 200) {
    throw new CliError(`Could not load the blueprint catalog (${status}) from ${base}.`)
  }
  try {
    return JSON.parse(text) as CatalogEntry[]
  } catch {
    throw new CliError(`Blueprint catalog at ${base} was not valid JSON.`)
  }
}

export function registerAddCommand(program: Command, io: CommandIo): void {
  program
    .command("add [name]")
    .description("Add an integration via a blueprint — a guide for your coding agent to apply")
    .action(async (name: string | undefined) => {
      await runAddCommand(name !== undefined ? { target: name } : {}, io)
    })
}

export async function runAddCommand(args: AddArgs, io: CommandIo): Promise<void> {
  const fetchImpl = args.fetchImpl ?? fetch
  const base = resolveBaseUrl(args.baseUrl)

  if (!args.target) {
    const catalog = await loadCatalog(fetchImpl, base)
    writeLine(io.stdout, "Available Dawn blueprints — run `dawn add <name>`:")
    const byCategory = new Map<string, CatalogEntry[]>()
    for (const entry of catalog) {
      byCategory.set(entry.category, [...(byCategory.get(entry.category) ?? []), entry])
    }
    for (const category of [...byCategory.keys()].sort()) {
      writeLine(io.stdout, "")
      writeLine(io.stdout, `${category}:`)
      const entries = (byCategory.get(category) ?? []).sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        writeLine(io.stdout, `  ${entry.name} — ${entry.description}`)
      }
    }
    return
  }

  if (isUrl(args.target)) {
    const { status, text } = await fetchText(fetchImpl, args.target)
    if (status !== 200) {
      throw new CliError(`Could not fetch blueprint from ${args.target} (${status}).`)
    }
    writeLine(io.stdout, text)
    return
  }

  const url = `${base}/blueprints/${args.target}.md`
  const { status, text } = await fetchText(fetchImpl, url)
  if (status === 200) {
    writeLine(io.stdout, `# Apply this Dawn blueprint: ${args.target}`)
    writeLine(io.stdout, "")
    writeLine(io.stdout, "Hand the guide below to your coding agent to apply it to this project.")
    writeLine(io.stdout, "")
    writeLine(io.stdout, text)
    return
  }
  if (status === 404) {
    const catalog = await loadCatalog(fetchImpl, base)
    writeLine(io.stderr, `Unknown blueprint: ${args.target}`)
    writeLine(io.stderr, "")
    writeLine(io.stderr, "Available blueprints:")
    for (const entry of catalog) {
      writeLine(io.stderr, `  ${entry.name} (${entry.category})`)
    }
    throw new CliError(`No blueprint named "${args.target}".`)
  }
  throw new CliError(`Failed to fetch ${url} (${status}).`)
}
```

- [ ] **Step 4: Register the command**

In `packages/cli/src/index.ts`, add the import alongside the other command imports (alphabetical — before `registerBuildCommand`):

```ts
import { registerAddCommand } from "./commands/add.js"
```

And add the registration before `registerBuildCommand(program, io)`:

```ts
  registerAddCommand(program, io)
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @dawn-ai/cli exec vitest run test/add-command.test.ts`
Expected: PASS (all five cases).

- [ ] **Step 6: Typecheck + lint + commit**

Run: `pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint`
Expected: both exit 0.

```bash
git add packages/cli/src/commands/add.ts packages/cli/src/index.ts packages/cli/test/add-command.test.ts
git commit -m "feat(cli): add 'dawn add' to fetch and print integration blueprints

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Docs page

**Files:**
- Create: `apps/web/content/docs/blueprints.mdx`
- Modify: `apps/web/app/components/docs/nav.ts`

- [ ] **Step 1: Create the docs page**

Create `apps/web/content/docs/blueprints.mdx`:

```mdx
# Blueprints

A blueprint is a guide for adding an integration to your Dawn app. `dawn add <name>` fetches the guide and prints it; you hand it to your coding agent (Claude Code, Cursor, …), which applies it to your project — installing dependencies, creating files, and wiring them in.

Blueprints are Markdown, served from `dawnai.org`, and applied by an agent — not npm packages or runtime abstractions. For framework *patterns* (how to write a tool, type state, etc.), see [Recipes](/docs/recipes); blueprints are for wiring in *external systems*.

## Using `dawn add`

```bash
dawn add                 # list available blueprints, grouped by category
dawn add pgvector        # print the pgvector blueprint for your agent to apply
dawn add <url>           # apply a third-party blueprint from any URL
```

Pipe it straight to your coding agent, or run it and paste the output. `dawn add` only prints the guide — your agent makes the changes, and you review them.

Set `DAWN_BLUEPRINTS_URL` to point at a self-hosted catalog (or a local dev server) instead of `dawnai.org`.

## Authoring a blueprint

Blueprints live under `apps/web/content/blueprints/<category>/<name>.md` in the Dawn repo. The **filename is the blueprint's name** (`dawn add <name>`), and the **directory is its category** (`observability`, `retrieval`, `deploy`) — used for listing only, never in the command.

Frontmatter (only `description` is required):

```yaml
---
description: Add OpenTelemetry tracing to a Dawn app.   # required, written for an LLM
website: https://opentelemetry.io                        # optional
version: 1                                               # optional (default 1)
tags: [tracing, otel]                                    # optional
source: official                                         # optional: official | maintainer | community
---
```

The body is an agent-facing guide. Lead with the intent and scope ("you are adding X; it does Y, not Z"), then: prerequisites, inspect the project, install dependencies, create the file(s), wire them in, configure environment, and verify. The primary generated file's first line carries a marker so a future `dawn update` can find it:

```ts
// dawn-blueprint: opentelemetry@1
```

Keep guides adaptive: have the agent detect the package manager, read `dawn.config.ts` and `AGENTS.md`, reuse existing dependencies, and follow the project's env conventions rather than assuming.
```

- [ ] **Step 2: Add it to the docs nav**

In `apps/web/app/components/docs/nav.ts`, add a Blueprints entry to the **Tooling** section's `items` array (after the `Dev Server` entry):

```ts
      { label: "Blueprints", href: "/docs/blueprints" },
```

- [ ] **Step 3: Verify the docs gate**

Run: `pnpm --filter @dawn-ai/cli build` (so the docs/link gate has a fresh CLI), then `node scripts/check-docs.mjs`
Expected: exits 0 (the new page is reachable from nav; no broken links).

- [ ] **Step 4: Commit**

```bash
git add apps/web/content/docs/blueprints.mdx apps/web/app/components/docs/nav.ts
git commit -m "docs(web): add Blueprints page and nav entry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Tasks 5–8: Author the four exemplar blueprints

Each task authors one guide under `apps/web/content/blueprints/<category>/<name>.md`. **The objective gate for every one** is: it passes `validateBlueprints` (run the lib test against the real content), and a human/agent review confirms the body follows the template and is technically correct for that integration.

**Shared requirements for every exemplar:**
- Frontmatter per the field set (description required; include `website`, `version: 1`, `tags`, `source: official`).
- Body sections (from the design template), in order: `# Add <X> to your Dawn app`; an intent + scope paragraph; **Prerequisites / when not to apply**; **Inspect the project** (detect package manager; read `dawn.config.ts` for `appDir`; read `AGENTS.md`; check for an existing install via the marker; learn env conventions); **Install dependencies** (pinned; reuse if present); **Create the file(s)** (complete code; primary file's first line is `// dawn-blueprint: <name>@1`); **Wire into your app**; **Configure environment** (no hardcoded secrets; update `.env.example`); **Verify**; **Updating an existing install** (compare + preserve customizations + re-stamp marker).
- Reference Dawn's real surfaces: routes live under `src/app/<route>/`, tools at `src/app/<route>/tools/<tool>.ts` (default-exported async function; types inferred), shared libs at `src/lib/`, config at `dawn.config.ts`. (The author should skim `apps/web/content/docs/tools.mdx` and `routes.mdx` to keep placements accurate.)
- After writing, run the gate (below) and `node scripts/check-docs.mjs` is **not** required for blueprints (they're not docs pages).

**Per-blueprint gate (run after each):**
```bash
pnpm --filter web exec vitest run app/blueprints/blueprints-lib.test.ts
```
Plus, ad hoc, confirm the new file validates by adding it to the real tree and re-running the validator (Task 9 asserts the full set).

### Task 5: `retrieval/pgvector.md`
- File: `apps/web/content/blueprints/retrieval/pgvector.md`.
- Frontmatter `description`: "Add a pgvector-backed retrieval tool to a Dawn app." `website: https://github.com/pgvector/pgvector`, `tags: [retrieval, postgres, vector, embeddings]`.
- **Shape = a Dawn tool.** Primary file: a retrieval tool at `src/app/<route>/tools/search_documents.ts` (default-exported async function taking `{ query: string }`, returning matched chunks). First line: `// dawn-blueprint: pgvector@1`.
- Technical contract: depends on `pg` (and an embeddings client — instruct the agent to reuse the app's existing model/provider for embeddings, or `@langchain/openai` embeddings if none); reads `DATABASE_URL`; assumes a table with a `vector` column + an `ORDER BY embedding <=> $1 LIMIT k` similarity query; **Prerequisites** must state it needs a Postgres database with the `pgvector` extension and an embeddings model.
- Wire-in: add the tool to a route by placing it in that route's `tools/` dir (Dawn discovers it; the model calls it). Verify with `dawn typegen` + a `dawn dev` query.

### Task 6: `retrieval/pinecone.md`
- File: `apps/web/content/blueprints/retrieval/pinecone.md`.
- Frontmatter `description`: "Add a Pinecone-backed retrieval tool to a Dawn app." `website: https://www.pinecone.io`, `tags: [retrieval, vector, embeddings]`.
- **Shape = a Dawn tool** (same placement as pgvector): `src/app/<route>/tools/search_documents.ts`, first line `// dawn-blueprint: pinecone@1`.
- Technical contract: depends on `@pinecone-database/pinecone` (+ an embeddings client, same reuse guidance); reads `PINECONE_API_KEY` and an index name from env; the tool embeds the query and `index.query({ topK, vector })`. **Prerequisites**: a Pinecone account, an existing index, and an embeddings model. This proves two blueprints coexist in one category.

### Task 7: `observability/opentelemetry.md`
- File: `apps/web/content/blueprints/observability/opentelemetry.md`.
- Frontmatter `description`: "Add OpenTelemetry tracing to a Dawn app." `website: https://opentelemetry.io`, `tags: [observability, tracing, otel]`.
- **Shape = instrumentation** (cross-cutting, not a tool). Primary file: `src/lib/otel.ts` exporting an init function (sets up the Node SDK / tracer provider + OTLP exporter), first line `// dawn-blueprint: opentelemetry@1`.
- Wire-in: import and call the init early in the app's entry (instruct the agent to find the runtime entry / instrument before the agent runs); reads `OTEL_EXPORTER_OTLP_ENDPOINT` + standard `OTEL_*` env. **Prerequisites**: an OTLP-compatible collector/backend. Verify traces appear for a `dawn dev` run.

### Task 8: `deploy/docker.md`
- File: `apps/web/content/blueprints/deploy/docker.md`.
- Frontmatter `description`: "Containerize a Dawn app with a production Dockerfile." `website: https://www.docker.com`, `tags: [deploy, docker, self-host]`.
- **Shape = a root artifact.** Primary file: root `Dockerfile` (multi-stage: install → `dawn build` → run); first line is a Docker comment marker `# dawn-blueprint: docker@1`. Also a `.dockerignore`.
- **Prerequisites / when not to apply**: this is for **self-hosting**; if the user deploys to LangSmith, they don't need it. Technical contract: Node 22 base; `pnpm`/`npm` per the project; copy + install + `dawn build`; expose the dev/runtime port; CMD runs the built server. Verify with `docker build` + a container smoke run.

**Commit each blueprint** as its own commit, e.g.:
```bash
git add apps/web/content/blueprints/retrieval/pgvector.md
git commit -m "feat(blueprints): add retrieval/pgvector

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Full verification + changeset

**Files:**
- Create: `apps/web/app/blueprints/catalog.test.ts`
- Create: `.changeset/blueprints-dawn-add.md`

- [ ] **Step 1: Add a catalog-integrity test over the real content**

Create `apps/web/app/blueprints/catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { loadBlueprints, validateBlueprints } from "../../lib/blueprints"

describe("shipped blueprint catalog", () => {
  it("passes validation", () => {
    expect(validateBlueprints()).toEqual([])
  })

  it("ships the four exemplars across three categories", () => {
    const all = loadBlueprints()
    expect(all.map((e) => e.meta.name).sort()).toEqual([
      "docker",
      "opentelemetry",
      "pgvector",
      "pinecone",
    ])
    expect(new Set(all.map((e) => e.meta.category))).toEqual(
      new Set(["observability", "retrieval", "deploy"]),
    )
  })

  it("marks the primary file in every guide", () => {
    for (const { meta, body } of loadBlueprints()) {
      expect(body, `${meta.name} should contain its dawn-blueprint marker`).toContain(
        `dawn-blueprint: ${meta.name}@`,
      )
    }
  })
})
```

- [ ] **Step 2: Run the full web + cli suites**

Run: `pnpm --filter web exec vitest run app/blueprints`
Expected: PASS — lib, routes, and catalog tests all green against the real four blueprints.

Run: `pnpm --filter @dawn-ai/cli exec vitest run test/add-command.test.ts`
Expected: PASS.

- [ ] **Step 3: Build, typecheck, lint the whole repo**

Run: `pnpm build && pnpm typecheck && pnpm lint`
Expected: all exit 0.

- [ ] **Step 4: Smoke-test `dawn add` against a local web server**

Run (two terminals or background the server):
```bash
pnpm --filter web dev --port 4321 &
DAWN_BLUEPRINTS_URL=http://localhost:4321 node packages/cli/dist/index.js add
DAWN_BLUEPRINTS_URL=http://localhost:4321 node packages/cli/dist/index.js add pgvector | head -5
```
Expected: the first lists four blueprints grouped by category; the second prints the pgvector guide. Stop the server afterward.

- [ ] **Step 5: Add the changeset**

Create `.changeset/blueprints-dawn-add.md`:

```md
---
"@dawn-ai/cli": patch
---

Add `dawn add <name>` — fetch an integration blueprint (a Markdown guide served from dawnai.org) and print it for your coding agent to apply. `dawn add` lists the catalog; `dawn add <url>` applies a third-party blueprint. Ships with pgvector, pinecone, opentelemetry, and docker blueprints.
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/blueprints/catalog.test.ts .changeset/blueprints-dawn-add.md
git commit -m "test(blueprints): catalog integrity + changeset for dawn add

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** flat-name addressing + dir=category → Task 1 loader (`name`=file, `category`=dir) + Task 3 command. Frontmatter set → Task 1 `parseEntry`/`validateBlueprints`. Body template + marker → Tasks 5–8 + the marker assertion in Task 9. Served delivery → Task 2 routes + Task 3 fetch. `dawn add` / no-arg list / `<url>` → Task 3. Validator → Task 1 `validateBlueprints` + Task 9 catalog test (the spec's "check-blueprints" intent, realized as a colocated content test that runs in CI via `turbo test` — a deliberate refinement so routes and validation share one `gray-matter` parser). Docs page → Task 4. Four exemplars across 3 categories/shapes → Tasks 5–8.
- **No placeholders:** all mechanism code (Tasks 1–3) and the docs page (Task 4) are shown in full. The content tasks (5–8) are authoring tasks specified by exact path, verbatim frontmatter fields, the required section list, the integration-specific technical contract, the marker, and an objective validation gate — the appropriate granularity for prose guides (their correctness is gated by `validateBlueprints` + review, not by pre-transcribing four full guides).
- **Type/name consistency:** `loadBlueprints`/`getBlueprint`/`validateBlueprints`/`BlueprintMeta`/`BlueprintEntry`/`runAddCommand`/`registerAddCommand` are used identically across tasks; route imports use `../../../lib/blueprints`; the CLI uses `CommandIo`/`writeLine`/`CliError`.
- **Ordering note:** Task 2's route test depends on at least `opentelemetry.md` existing; the Step-1 note covers running it early with a stub, and Task 9 re-validates against the real four.
- **Out of scope (held):** no `dawn update`/upgrade diffs, no `@scope/name`, no HTML gallery, no channel/sandbox blueprints, no CLI bundling (served).
