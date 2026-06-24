# Bundled Docs + SKILL.md Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship version-matched Dawn docs inside `@dawn-ai/cli` as a navigable markdown tree (generated from the website MDX), plus a `SKILL.md`, a `dawn docs` command, and a scaffolded root `AGENTS.md` pointer — so coding agents read Dawn's docs locally, offline, matched to the installed version.

**Architecture:** A pure transform module in `packages/cli/src/lib/docs-bundle.ts` (MDX→markdown, frontmatter parsing, nav ordering, index building) is unit-tested. A plain build script `packages/cli/scripts/generate-docs.mjs` imports the compiled module, reads `apps/web/content/docs/*.mdx` + `nav.ts`, and writes the gitignored `packages/cli/docs/` tree during the CLI build. A `dawn docs` command resolves and prints the tree from the package location. `pack:check` guarantees the tree ships.

**Tech Stack:** TypeScript, commander, Node `fs`, vitest, Biome. CLI build is `tsc -b` (emits `src/**` only) + the generator script.

**Design spec:** `docs/superpowers/specs/2026-06-19-bundled-docs-skill-design.md`

**Conventions to follow (verified in repo):**
- CLI commands: a `src/commands/<name>.ts` exporting `register<Name>Command(program, io)` and `run<Name>Command(args, io)`, wired in `src/index.ts`. Output via `CommandIo` (`io.stdout(msg)`, `io.stderr(msg)`) and the `writeLine(write, msg)` / `CliError` / `formatErrorMessage` helpers from `src/lib/output.ts`.
- CLI tests live in `packages/cli/test/`, run by `pnpm --filter @dawn-ai/cli test` (vitest).
- `tsconfig.build.json` `include` is `["src/**/*.ts"]`, `rootDir: "src"` — so `scripts/` and `docs/` are NOT compiled or emitted.

---

## Task 1: Pure docs-bundle transform module

**Files:**
- Create: `packages/cli/src/lib/docs-bundle.ts`
- Test: `packages/cli/test/docs-bundle.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/docs-bundle.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { buildReadme, mdxToMarkdown, parseFrontmatter, parseNavOrder } from "../src/lib/docs-bundle.js"

describe("parseFrontmatter()", () => {
  it("extracts title and description and strips the frontmatter block", () => {
    const raw = '---\ntitle: "Tools"\ndescription: Co-located tools\n---\n\nBody text.\n'
    const { data, body } = parseFrontmatter(raw)
    expect(data.title).toBe("Tools")
    expect(data.description).toBe("Co-located tools")
    expect(body).toBe("\nBody text.\n")
  })

  it("returns empty data when there is no frontmatter", () => {
    const { data, body } = parseFrontmatter("# Heading\n")
    expect(data).toEqual({})
    expect(body).toBe("# Heading\n")
  })
})

describe("mdxToMarkdown()", () => {
  it("drops frontmatter, promotes title to an H1, and removes module imports", () => {
    const raw = '---\ntitle: "Routes"\n---\nimport { Callout } from "x"\n\nA route is a folder.\n'
    const out = mdxToMarkdown(raw)
    expect(out).toContain("# Routes")
    expect(out).toContain("A route is a folder.")
    expect(out).not.toContain('import { Callout }')
    expect(out).not.toContain("---")
  })

  it("removes RelatedCards components, including multi-line ones", () => {
    const raw = "# X\n\nText.\n\n<RelatedCards items={[\n  { href: \"/docs/routes\" },\n]} />\n"
    const out = mdxToMarkdown(raw)
    expect(out).not.toContain("RelatedCards")
    expect(out).toContain("Text.")
  })

  it("preserves import lines inside fenced code blocks", () => {
    const raw = '# X\n\n```ts\nimport { agent } from "@dawn-ai/sdk"\n```\n'
    const out = mdxToMarkdown(raw)
    expect(out).toContain('import { agent } from "@dawn-ai/sdk"')
  })

  it("does not add a second H1 when the body already starts with one", () => {
    const raw = "---\ntitle: Dup\n---\n# Real Heading\n\nBody.\n"
    const out = mdxToMarkdown(raw)
    expect(out.match(/^# /gm)?.length).toBe(1)
    expect(out).toContain("# Real Heading")
  })
})

describe("parseNavOrder()", () => {
  it("returns doc slugs in source order without duplicates", () => {
    const nav = `
      { label: "Getting Started", href: "/docs/getting-started" },
      { label: "Routes", href: "/docs/routes" },
      { label: "Routes again", href: "/docs/routes" },
    `
    expect(parseNavOrder(nav)).toEqual(["getting-started", "routes"])
  })
})

describe("buildReadme()", () => {
  it("renders an index linking each topic file with its description", () => {
    const md = buildReadme([
      { slug: "tools", title: "Tools", description: "Co-located tools", file: "tools.md" },
      { slug: "state", title: "State", description: "", file: "state.md" },
    ])
    expect(md).toContain("# Dawn — Documentation")
    expect(md).toContain("dawn docs <topic>")
    expect(md).toContain("- [Tools](./tools.md) — Co-located tools")
    expect(md).toContain("- [State](./state.md)")
    expect(md).not.toContain("State](./state.md) —")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @dawn-ai/cli exec vitest run test/docs-bundle.test.ts`
Expected: FAIL — `../src/lib/docs-bundle.js` cannot be resolved.

- [ ] **Step 3: Implement the module**

Create `packages/cli/src/lib/docs-bundle.ts`:

```ts
export interface DocFrontmatter {
  title?: string
  description?: string
}

export interface DocTopic {
  readonly slug: string
  readonly title: string
  readonly description: string
  readonly file: string
}

/** Split a leading `---` YAML frontmatter block off an MDX document. */
export function parseFrontmatter(raw: string): { data: DocFrontmatter; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
  if (!match) {
    return { data: {}, body: raw }
  }
  const data: DocFrontmatter = {}
  for (const line of match[1].split("\n")) {
    const m = /^(\w+):\s*(.*)$/.exec(line)
    if (!m) {
      continue
    }
    let value = m[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (m[1] === "title") {
      data.title = value
    } else if (m[1] === "description") {
      data.description = value
    }
  }
  return { data, body: raw.slice(match[0].length) }
}

/**
 * Convert an MDX doc page to plain markdown suitable for the bundled tree.
 * Minimal transform: strip frontmatter (promoting `title` to an H1 when the
 * body has none), drop module `import`/`export` lines OUTSIDE fenced code, and
 * remove `<RelatedCards … />` navigation components. Code fences are untouched.
 */
export function mdxToMarkdown(raw: string): string {
  const { data, body } = parseFrontmatter(raw)
  const out: string[] = []
  let inFence = false
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    if (/^(import|export)\s/.test(line)) {
      continue
    }
    out.push(line)
  }
  let result = out.join("\n").replace(/<RelatedCards[\s\S]*?\/>/g, "")
  result = result.replace(/\n{3,}/g, "\n\n").trim()
  if (data.title && !/^#\s/.test(result)) {
    result = `# ${data.title}\n\n${result}`
  }
  return `${result}\n`
}

/** Extract `/docs/<slug>` hrefs from the website nav source, in order, deduped. */
export function parseNavOrder(navSource: string): string[] {
  const slugs: string[] = []
  const re = /href:\s*["']\/docs\/([^"']+)["']/g
  let m: RegExpExecArray | null = re.exec(navSource)
  while (m !== null) {
    if (!slugs.includes(m[1])) {
      slugs.push(m[1])
    }
    m = re.exec(navSource)
  }
  return slugs
}

/** Render the bundled docs `README.md` index. */
export function buildReadme(topics: readonly DocTopic[]): string {
  const lines = [
    "# Dawn — Documentation",
    "",
    "Version-matched Dawn reference for coding agents. These files match the installed `@dawn-ai/cli` version.",
    "Run `dawn docs <topic>` to read one (e.g. `dawn docs tools`), or open the files in this directory.",
    "",
    "## Topics",
    "",
  ]
  for (const t of topics) {
    lines.push(`- [${t.title}](./${t.file})${t.description ? ` — ${t.description}` : ""}`)
  }
  return `${lines.join("\n")}\n`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @dawn-ai/cli exec vitest run test/docs-bundle.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint + commit**

Run: `pnpm --filter @dawn-ai/cli lint`
Expected: exits 0.

```bash
git add packages/cli/src/lib/docs-bundle.ts packages/cli/test/docs-bundle.test.ts
git commit -m "feat(cli): add docs-bundle transform module (MDX->markdown, nav order, index)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Generator script + build wiring

**Files:**
- Create: `packages/cli/scripts/generate-docs.mjs`
- Modify: `packages/cli/package.json` (build script + `files`)
- Modify: `.gitignore` (repo root)

- [ ] **Step 1: Write the generator script**

Create `packages/cli/scripts/generate-docs.mjs`:

```js
// Generates packages/cli/docs/ from the website MDX so the docs ship with the
// installed CLI, version-matched. Run during the CLI build (after tsc emits
// dist/, which this script imports). Reads only static source files.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { buildReadme, mdxToMarkdown, parseFrontmatter, parseNavOrder } from "../dist/lib/docs-bundle.js"

const here = dirname(fileURLToPath(import.meta.url)) // packages/cli/scripts
const pkgRoot = resolve(here, "..") // packages/cli
const repoRoot = resolve(pkgRoot, "..", "..") // repo root
const docsSrc = join(repoRoot, "apps/web/content/docs")
const navFile = join(repoRoot, "apps/web/app/components/docs/nav.ts")
const outDir = join(pkgRoot, "docs")

if (!existsSync(docsSrc)) {
  console.error(`[generate-docs] source docs not found at ${docsSrc}`)
  process.exit(1)
}

function walk(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...walk(abs))
    } else if (entry.name.endsWith(".mdx")) {
      found.push(abs)
    }
  }
  return found
}

const mdxFiles = walk(docsSrc)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const bySlug = new Map()
for (const abs of mdxFiles) {
  const outRel = relative(docsSrc, abs).replace(/\.mdx$/, ".md")
  const raw = readFileSync(abs, "utf8")
  const { data } = parseFrontmatter(raw)
  const outPath = join(outDir, outRel)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, mdxToMarkdown(raw))
  const slug = outRel.replace(/\.md$/, "").replace(/\/index$/, "")
  bySlug.set(slug, {
    slug,
    file: outRel,
    title: data.title ?? slug,
    description: data.description ?? "",
  })
}

const navOrder = parseNavOrder(readFileSync(navFile, "utf8"))
const ordered = []
const seen = new Set()
for (const slug of navOrder) {
  if (bySlug.has(slug)) {
    ordered.push(bySlug.get(slug))
    seen.add(slug)
  }
}
for (const [slug, info] of bySlug) {
  if (!seen.has(slug)) {
    ordered.push(info)
  }
}
writeFileSync(join(outDir, "README.md"), buildReadme(ordered))
console.log(`[generate-docs] wrote ${mdxFiles.length} topic(s) + README.md to ${outDir}`)
```

- [ ] **Step 2: Wire the generator into the CLI build and package `files`**

In `packages/cli/package.json`, change the `build` script and the `files` array:

Replace:
```json
    "build": "tsc -b tsconfig.build.json",
```
with:
```json
    "build": "tsc -b tsconfig.build.json && node scripts/generate-docs.mjs",
```

Replace:
```json
  "files": [
    "dist"
  ],
```
with:
```json
  "files": [
    "dist",
    "docs",
    "SKILL.md"
  ],
```

- [ ] **Step 3: Gitignore the generated tree**

Append to the repo-root `.gitignore`:

```
# Generated by packages/cli build (scripts/generate-docs.mjs)
packages/cli/docs/
```

- [ ] **Step 4: Build the CLI and verify the tree is generated**

Run: `pnpm --filter @dawn-ai/cli build`
Expected: build succeeds; prints `[generate-docs] wrote N topic(s) + README.md`.

Run: `test -f packages/cli/docs/README.md && test -f packages/cli/docs/getting-started.md && test -f packages/cli/docs/tools.md && echo OK`
Expected: `OK`.

Run: `grep -c "import { agent }" packages/cli/docs/getting-started.md`
Expected: a number ≥ 1 (code-fence imports preserved), and:
Run: `grep -c "RelatedCards" packages/cli/docs/*.md || echo "none"`
Expected: `none` (no RelatedCards leaked into the bundle).

- [ ] **Step 5: Verify the generated tree is gitignored**

Run: `git status --porcelain packages/cli/docs`
Expected: no output (the tree is ignored).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/scripts/generate-docs.mjs packages/cli/package.json .gitignore
git commit -m "feat(cli): generate bundled docs tree from website MDX during build

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `dawn docs` command

**Files:**
- Create: `packages/cli/src/commands/docs.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/docs-command.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `packages/cli/test/docs-command.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CliError } from "../src/lib/output.js"
import { runDocsCommand } from "../src/commands/docs.js"

function fixtureDocs(): string {
  const dir = mkdtempSync(join(tmpdir(), "dawn-docs-"))
  writeFileSync(join(dir, "README.md"), "# Dawn — Documentation\n")
  writeFileSync(join(dir, "tools.md"), "# Tools\n\nCo-located tools.\n")
  mkdirSync(join(dir, "recipes"))
  writeFileSync(join(dir, "recipes", "add-a-tool.md"), "# Add a tool\n")
  return dir
}

function fakeIo() {
  const out: string[] = []
  const err: string[] = []
  return { io: { stdout: (m: string) => out.push(m), stderr: (m: string) => err.push(m) }, out, err }
}

describe("runDocsCommand()", () => {
  it("lists topics and prints the docs path when no topic is given", async () => {
    const dir = fixtureDocs()
    const { io, out } = fakeIo()
    await runDocsCommand({ docsDir: dir }, io)
    const text = out.join("\n")
    expect(text).toContain(dir)
    expect(text).toContain("tools")
    expect(text).toContain("recipes/add-a-tool")
  })

  it("prints a topic's markdown to stdout", async () => {
    const dir = fixtureDocs()
    const { io, out } = fakeIo()
    await runDocsCommand({ topic: "tools", docsDir: dir }, io)
    expect(out.join("\n")).toContain("Co-located tools.")
  })

  it("tolerates a .md suffix and nested recipe slugs", async () => {
    const dir = fixtureDocs()
    const { io, out } = fakeIo()
    await runDocsCommand({ topic: "recipes/add-a-tool.md", docsDir: dir }, io)
    expect(out.join("\n")).toContain("# Add a tool")
  })

  it("errors with the topic list on an unknown topic", async () => {
    const dir = fixtureDocs()
    const { io, err } = fakeIo()
    await expect(runDocsCommand({ topic: "nope", docsDir: dir }, io)).rejects.toBeInstanceOf(CliError)
    expect(err.join("\n")).toContain("tools")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @dawn-ai/cli exec vitest run test/docs-command.test.ts`
Expected: FAIL — `../src/commands/docs.js` cannot be resolved.

- [ ] **Step 3: Implement the command**

Create `packages/cli/src/commands/docs.ts`:

```ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type { Command } from "commander"

import { CliError, type CommandIo, writeLine } from "../lib/output.js"

interface DocsArgs {
  readonly topic?: string
  /** Override the docs directory; used by tests. */
  readonly docsDir?: string
}

/** Resolve the bundled docs dir relative to this command's built location
 * (dist/commands/docs.js -> <package>/docs). */
function defaultDocsDir(): string {
  return fileURLToPath(new URL("../../docs", import.meta.url))
}

function listTopics(dir: string): string[] {
  const topics: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const sub of readdirSync(join(dir, entry.name))) {
        if (sub.endsWith(".md")) {
          topics.push(`${entry.name}/${sub.replace(/\.md$/, "")}`)
        }
      }
    } else if (entry.name.endsWith(".md") && entry.name !== "README.md") {
      topics.push(entry.name.replace(/\.md$/, ""))
    }
  }
  return topics.sort()
}

export function registerDocsCommand(program: Command, io: CommandIo): void {
  program
    .command("docs [topic]")
    .description("Print the bundled, version-matched Dawn docs (or a single topic)")
    .action(async (topic: string | undefined) => {
      await runDocsCommand({ topic }, io)
    })
}

export async function runDocsCommand(args: DocsArgs, io: CommandIo): Promise<void> {
  const dir = args.docsDir ?? defaultDocsDir()
  if (!existsSync(dir)) {
    throw new CliError(
      `Bundled docs not found at ${dir}. If running from source, build the CLI first (pnpm --filter @dawn-ai/cli build).`,
    )
  }

  if (!args.topic) {
    writeLine(io.stdout, `Dawn docs (version-matched) at: ${dir}`)
    writeLine(io.stdout, "Index: dawn docs README  (or open docs/README.md)")
    writeLine(io.stdout, "")
    writeLine(io.stdout, "Topics:")
    for (const topic of listTopics(dir)) {
      writeLine(io.stdout, `  ${topic}`)
    }
    return
  }

  const slug = args.topic.replace(/\.md$/, "")
  const file = join(dir, `${slug}.md`)
  if (!existsSync(file) || !statSync(file).isFile()) {
    writeLine(io.stderr, `Unknown topic: ${args.topic}`)
    writeLine(io.stderr, "")
    writeLine(io.stderr, "Available topics:")
    for (const topic of listTopics(dir)) {
      writeLine(io.stderr, `  ${topic}`)
    }
    throw new CliError(`No doc named "${args.topic}".`)
  }
  writeLine(io.stdout, readFileSync(file, "utf8"))
}
```

- [ ] **Step 4: Register the command**

In `packages/cli/src/index.ts`, add the import next to the other command imports (alphabetical — after `registerDevCommand` import, before `registerEvalCommand`):

```ts
import { registerDocsCommand } from "./commands/docs.js"
```

And add the registration call next to the others (after `registerDevCommand(program, io)`):

```ts
  registerDocsCommand(program, io)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @dawn-ai/cli exec vitest run test/docs-command.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Smoke-test the real command against the generated tree**

Run: `pnpm --filter @dawn-ai/cli build && node packages/cli/dist/index.js docs | head -5`
Expected: prints the docs path and a "Topics:" list.

Run: `node packages/cli/dist/index.js docs tools | head -3`
Expected: prints the start of the Tools doc.

- [ ] **Step 7: Lint + commit**

Run: `pnpm --filter @dawn-ai/cli lint`
Expected: exits 0.

```bash
git add packages/cli/src/commands/docs.ts packages/cli/src/index.ts packages/cli/test/docs-command.test.ts
git commit -m "feat(cli): add 'dawn docs' command to read the bundled docs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: SKILL.md

**Files:**
- Create: `packages/cli/SKILL.md`

- [ ] **Step 1: Create the SKILL.md**

Create `packages/cli/SKILL.md` with exactly:

```md
---
name: dawn
description: Build AI agents and workflows with the Dawn framework — the TypeScript meta-framework for LangGraph. Use when creating, editing, or debugging a Dawn app (routes, tools, state, agents, workflows, testing, deployment).
---

# Dawn

Dawn is the TypeScript meta-framework for LangGraph. Agents and workflows are
file-system routes under `src/app/`, with co-located tools, generated types, and
durable threads.

## Source of truth

The complete, version-matched Dawn documentation ships inside this package at
`docs/`. Always read the bundled docs — they match the installed version exactly.

- Start with `docs/README.md` (the index and recommended reading order).
- Or run `dawn docs` to list topics and `dawn docs <topic>` to read one
  (for example, `dawn docs tools`).

Do not rely on this file's prose for API detail; read the bundled docs first.
```

- [ ] **Step 2: Verify it is packaged (declared in `files`)**

Run: `node -e "const f=require('./packages/cli/package.json').files; if(!f.includes('SKILL.md')) throw new Error('SKILL.md not in files'); console.log('OK')"`
Expected: `OK` (the `files` change from Task 2 already added it).

- [ ] **Step 3: Commit**

```bash
git add packages/cli/SKILL.md
git commit -m "feat(cli): add SKILL.md pointing agents at the bundled docs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Guarantee the bundle ships (pack:check)

**Files:**
- Modify: `scripts/pack-check.mjs`

- [ ] **Step 1: Extend the `@dawn-ai/cli` expected files**

In `scripts/pack-check.mjs`, find the `packages/cli` entry (around line 129–130). Replace its `expectedFiles` line:

```js
    expectedFiles: ["dist/index.js", "README.md"],
```

with:

```js
    expectedFiles: [
      "dist/index.js",
      "dist/commands/docs.js",
      "README.md",
      "SKILL.md",
      "docs/README.md",
      "docs/getting-started.md",
      "docs/tools.md",
    ],
```

- [ ] **Step 2: Run pack:check**

Run: `pnpm --filter @dawn-ai/cli build && pnpm pack:check`
Expected: `Pack check passed.` (the CLI tarball now contains `SKILL.md` and the `docs/` files).

- [ ] **Step 3: Commit**

```bash
git add scripts/pack-check.mjs
git commit -m "test(pack): assert @dawn-ai/cli ships SKILL.md and the bundled docs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Scaffold a root AGENTS.md into new apps

**Files:**
- Create: `packages/devkit/templates/app-basic/AGENTS.md`
- Create: `packages/devkit/templates/app-research/AGENTS.md`
- Test: `packages/devkit/test/template-agents-md.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/devkit/test/template-agents-md.test.ts`:

```ts
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const templates = ["app-basic", "app-research"] as const

describe("scaffold AGENTS.md", () => {
  for (const name of templates) {
    it(`${name} ships a root AGENTS.md pointing at the bundled docs`, () => {
      const path = fileURLToPath(new URL(`../templates/${name}/AGENTS.md`, import.meta.url))
      const text = readFileSync(path, "utf8")
      expect(text).toContain("dawn docs")
      expect(text).toContain("node_modules/@dawn-ai/cli/docs")
    })
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @dawn-ai/devkit exec vitest run test/template-agents-md.test.ts`
Expected: FAIL — the `AGENTS.md` files do not exist.

- [ ] **Step 3: Create the AGENTS.md in both templates**

Create the SAME content at both `packages/devkit/templates/app-basic/AGENTS.md` and `packages/devkit/templates/app-research/AGENTS.md`:

```md
# Dawn App — Coding Agent Instructions

This project uses **Dawn**, the TypeScript meta-framework for LangGraph. Agents
and workflows are file-system routes under `src/app/`.

## Key rules

- A route is a directory with an `index.ts` that exports exactly ONE of:
  `agent` (LLM-driven; default export), `workflow` (deterministic async
  function), `graph` (LangGraph graph), or `chain` (LangChain LCEL Runnable).
- Tools are co-located in a route's `tools/` directory — one default-exported
  async function per file. Their argument types are inferred at build time.
- Optional route state goes in `state.ts` next to the route.
- Never edit `.dawn/dawn.generated.d.ts` — it is generated. Run `dawn typegen`
  if `dawn:routes` types do not resolve.

## Full reference (read this before writing routes)

The complete, version-matched Dawn documentation is bundled with the installed
CLI. Run `dawn docs` to list topics or `dawn docs <topic>` to read one (for
example, `dawn docs tools`). The same files are at
`node_modules/@dawn-ai/cli/docs/` — start with `docs/README.md`.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @dawn-ai/devkit exec vitest run test/template-agents-md.test.ts`
Expected: PASS (both templates).

- [ ] **Step 5: Confirm the scaffolder copies plain template files**

Plain (non-`.template`) files in a template dir are copied verbatim by
`create-dawn-app` (the same way `dawn.config.ts` and `README.md` already are).
Confirm nothing excludes `AGENTS.md`:

Run: `grep -rn "AGENTS\|exclude\|skip" packages/create-dawn-app/src/index.ts | head`
Expected: no exclusion of `AGENTS.md` (if an explicit allow/deny list exists that
would skip it, add `AGENTS.md` to the copied set; otherwise no change needed).

- [ ] **Step 6: Commit**

```bash
git add packages/devkit/templates/app-basic/AGENTS.md packages/devkit/templates/app-research/AGENTS.md packages/devkit/test/template-agents-md.test.ts
git commit -m "feat(devkit): scaffold a root AGENTS.md pointing at the bundled CLI docs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Build everything**

Run: `pnpm build`
Expected: all packages build; the CLI build prints the `[generate-docs]` line.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck`
Expected: exits 0.

Run: `pnpm lint`
Expected: exits 0.

- [ ] **Step 3: Run the affected package test suites**

Run: `pnpm --filter @dawn-ai/cli test`
Expected: all CLI tests pass (including `docs-bundle` and `docs-command`).

Run: `pnpm --filter @dawn-ai/devkit test`
Expected: all devkit tests pass (including the AGENTS.md template test).

- [ ] **Step 4: Pack check**

Run: `pnpm pack:check`
Expected: `Pack check passed.`

- [ ] **Step 5: Confirm dist does NOT contain the generator script or stray build-only files**

Run: `test ! -e packages/cli/dist/scripts && echo "OK: scripts not emitted"`
Expected: `OK: scripts not emitted` (tsconfig.build emits `src/**` only).

- [ ] **Step 6: Changeset (user-facing CLI change)**

The CLI gains a real feature (a new command + bundled docs), so this is a
shipping change. Add a patch changeset:

Create `.changeset/bundled-docs-skill.md`:

```md
---
"@dawn-ai/cli": patch
---

Bundle the Dawn documentation inside `@dawn-ai/cli` as a version-matched markdown tree, add a `dawn docs` command to read it locally, ship a `SKILL.md`, and scaffold a root `AGENTS.md` pointer into new apps. Coding agents can now read Dawn's docs offline, matched to the installed version.
```

> Note: the changeset `fixed` group versions all packages together; `patch` keeps
> it a patch bump (a `minor` would force a 1.0.0 jump in the 0.x fixed group).

Run: `BASE_REF=origin/main HEAD_REF=$(git rev-parse --abbrev-ref HEAD) node scripts/check-changesets.mjs`
Expected (after committing the changeset in the next step): `Changesets check passed`.

- [ ] **Step 7: Commit the changeset**

```bash
git add .changeset/bundled-docs-skill.md
git commit -m "chore(changeset): bundled docs + SKILL.md for @dawn-ai/cli

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** Generator → Tasks 1 (transform) + 2 (script/build/gitignore). Form (tree + index) → Tasks 1 (`buildReadme`) + 2. SKILL.md → Task 4. `dawn docs` → Task 3. Scaffolded AGENTS.md → Task 6. Generate-on-build + pack:check guarantee → Tasks 2 + 5. Testing (transform unit, coverage, command integration, pack) → Tasks 1, 3, 5, 7.
- **No placeholders:** every new file is shown in full; every edit is an exact find/replace; Task 6 Step 5 is a conditional confirmation with a clear default (no change unless an exclusion list exists).
- **Type/name consistency:** `mdxToMarkdown`, `parseFrontmatter`, `parseNavOrder`, `buildReadme`, `DocTopic`, `runDocsCommand`, `registerDocsCommand` are used identically across tasks. `CommandIo`/`writeLine`/`CliError` match `src/lib/output.ts`. The generator imports the exact names from `../dist/lib/docs-bundle.js`.
- **Build ordering:** `tsc -b` runs before `node scripts/generate-docs.mjs`, so `dist/lib/docs-bundle.js` exists when the generator imports it. The generated `docs/` and the `scripts/` dir are outside `tsconfig.build.json`'s `src/**` include, so neither is emitted to `dist`.
- **Out of scope (held):** no prompts/AGENTS-template bundling, no rich MDX flattening, no shared-docs extraction from `apps/web`.
