# Phase 3 — Skills Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Add a `createSkillsMarker()` capability to `@dawn-ai/core` so that any route with `src/app/<route>/skills/<name>/SKILL.md` files automatically gets a `# Skills` section in its system prompt and a `readSkill({name})` tool the agent uses to load skill bodies on demand. Wire it into `prepareRouteExecution` alongside the existing markers. Add two example skills to `examples/chat` to demo.

**Architecture:** Two new files in `@dawn-ai/core`: a small hand-rolled YAML-frontmatter parser, and the `skills` capability marker that uses it. `readSkill` is a plain capability tool (no state mutation). Registration is one line in `execute-route.ts`.

**Tech Stack:** TypeScript 6.0.2, vitest, `@dawn-ai/{core,langchain,cli}`. No new npm dependencies (frontmatter is hand-rolled).

**Spec:** [docs/superpowers/specs/2026-05-16-phase3-skills-design.md](../specs/2026-05-16-phase3-skills-design.md)

**Working directory:** `/Users/blove/repos/dawn/.claude/worktrees/skills` (branch `claude/skills`).

---

## File map

**Create:**
- `packages/core/src/capabilities/built-in/frontmatter.ts` — minimal YAML-block parser
- `packages/core/test/capabilities/frontmatter.test.ts` — parser tests
- `packages/core/src/capabilities/built-in/skills.ts` — `createSkillsMarker` + `readSkill` tool
- `packages/core/test/capabilities/skills.test.ts` — marker tests
- `packages/langchain/test/skills.test.ts` — integration shape test
- `examples/chat/server/src/app/chat/skills/workspace-conventions/SKILL.md`
- `examples/chat/server/src/app/chat/skills/recover-from-failure/SKILL.md`
- `.changeset/phase3-skills.md`

**Modify:**
- `packages/core/src/index.ts` — re-export `createSkillsMarker`
- `packages/cli/src/lib/runtime/execute-route.ts` — add `createSkillsMarker()` to the registry
- `examples/chat/README.md` — mark skills as shipped (out of Deferred)

---

## Task 1: Frontmatter parser + tests

**Files:**
- Create: `packages/core/src/capabilities/built-in/frontmatter.ts`
- Create: `packages/core/test/capabilities/frontmatter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/test/capabilities/frontmatter.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { parseFrontmatter } from "../../src/capabilities/built-in/frontmatter.js"

describe("parseFrontmatter", () => {
  it("returns empty frontmatter and full body when input has no frontmatter", () => {
    const input = "# Just a heading\n\nSome content."
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: {},
      body: "# Just a heading\n\nSome content.",
    })
  })

  it("returns empty frontmatter when missing closing ---", () => {
    const input = "---\nname: foo\nbody continues"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: {},
      body: "---\nname: foo\nbody continues",
    })
  })

  it("parses a single key/value", () => {
    const input = "---\nname: debug-python\n---\n\n# Body"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "debug-python" },
      body: "# Body",
    })
  })

  it("parses multiple keys", () => {
    const input =
      "---\nname: debug-python\ndescription: Debug stack traces.\n---\n\n# Body content"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "debug-python", description: "Debug stack traces." },
      body: "# Body content",
    })
  })

  it("strips surrounding double-quotes from values", () => {
    const input = '---\nname: "with spaces"\n---\nbody'
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "with spaces" },
      body: "body",
    })
  })

  it("strips surrounding single-quotes from values", () => {
    const input = "---\nname: 'with spaces'\n---\nbody"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "with spaces" },
      body: "body",
    })
  })

  it("ignores comment lines (start with #)", () => {
    const input = "---\n# this is a comment\nname: foo\n# another comment\n---\nbody"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "foo" },
      body: "body",
    })
  })

  it("ignores blank lines inside frontmatter", () => {
    const input = "---\nname: foo\n\ndescription: bar\n---\nbody"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "foo", description: "bar" },
      body: "body",
    })
  })

  it("trims whitespace from keys and values", () => {
    const input = "---\n  name  :   foo  \n---\nbody"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "foo" },
      body: "body",
    })
  })

  it("handles CRLF line endings", () => {
    const input = "---\r\nname: foo\r\n---\r\nbody"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "foo" },
      body: "body",
    })
  })

  it("preserves multi-line body verbatim (minus the first leading newline)", () => {
    const input = "---\nname: foo\n---\n\nLine 1\nLine 2\n\nLine 4"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "foo" },
      body: "Line 1\nLine 2\n\nLine 4",
    })
  })

  it("returns empty body when nothing follows the closing ---", () => {
    const input = "---\nname: foo\n---"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "foo" },
      body: "",
    })
  })

  it("returns empty frontmatter (the whole input as body) when input starts with --- but not --- followed by newline", () => {
    const input = "--- not really frontmatter\nname: foo"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: {},
      body: "--- not really frontmatter\nname: foo",
    })
  })

  it("treats a line without a colon as ignored (no key)", () => {
    const input = "---\nname: foo\nthis line has no colon\ndescription: bar\n---\nbody"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "foo", description: "bar" },
      body: "body",
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm install
pnpm --filter @dawn-ai/sdk build
pnpm --filter @dawn-ai/core test -- frontmatter.test
```

Expected: FAIL — `Cannot find module '../../src/capabilities/built-in/frontmatter.js'`.

- [ ] **Step 3: Implement the parser**

Create `packages/core/src/capabilities/built-in/frontmatter.ts`:

```ts
/**
 * Minimal YAML-frontmatter parser. Sufficient for Dawn's skill files,
 * which use a flat `key: value` block at the top delimited by `---` lines.
 *
 * Supports: keys, double-quoted values, single-quoted values, `#` comments,
 * blank lines, CRLF endings, leading/trailing whitespace.
 *
 * Does NOT support: nested objects, arrays, multi-line strings, anchors,
 * any other real YAML feature. If a skill needs full YAML, swap to the
 * `yaml` npm package without changing this module's contract.
 */
export interface ParsedFrontmatter {
  readonly frontmatter: Readonly<Record<string, string>>
  readonly body: string
}

const OPEN_MARKER = /^---\r?\n/
const CLOSE_MARKER = /\r?\n---\r?\n?/

export function parseFrontmatter(input: string): ParsedFrontmatter {
  if (!OPEN_MARKER.test(input)) {
    return { frontmatter: {}, body: input }
  }
  const openLen = OPEN_MARKER.exec(input)?.[0].length ?? 0
  const afterOpen = input.slice(openLen)
  const closeMatch = CLOSE_MARKER.exec(afterOpen)
  if (!closeMatch) {
    return { frontmatter: {}, body: input }
  }
  const block = afterOpen.slice(0, closeMatch.index)
  const bodyStart = closeMatch.index + closeMatch[0].length
  const body = afterOpen.slice(bodyStart).replace(/^\r?\n/, "")
  const frontmatter = parseFrontmatterBlock(block)
  return { frontmatter, body }
}

function parseFrontmatterBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (line.startsWith("#")) continue
    const colonIdx = line.indexOf(":")
    if (colonIdx < 0) continue
    const key = line.slice(0, colonIdx).trim()
    if (key.length === 0) continue
    const rawValue = line.slice(colonIdx + 1).trim()
    out[key] = stripQuotes(rawValue)
  }
  return out
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @dawn-ai/core test -- frontmatter.test
```

Expected: 14/14 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capabilities/built-in/frontmatter.ts packages/core/test/capabilities/frontmatter.test.ts
git commit -m "feat(core): minimal YAML-frontmatter parser for SKILL.md files"
```

---

## Task 2: Skills marker + tests

**Files:**
- Create: `packages/core/src/capabilities/built-in/skills.ts`
- Create: `packages/core/test/capabilities/skills.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/test/capabilities/skills.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createSkillsMarker } from "../../src/capabilities/built-in/skills.js"

describe("createSkillsMarker", () => {
  let routeDir: string

  beforeEach(() => {
    routeDir = mkdtempSync(join(tmpdir(), "dawn-skills-"))
  })

  afterEach(() => {
    rmSync(routeDir, { recursive: true, force: true })
  })

  function writeSkill(name: string, frontmatter: string, body: string): void {
    const dir = join(routeDir, "skills", name)
    mkdirSync(dir, { recursive: true })
    const content = frontmatter ? `---\n${frontmatter}\n---\n\n${body}` : body
    writeFileSync(join(dir, "SKILL.md"), content, "utf8")
  }

  it("does not detect when skills/ directory is absent", async () => {
    const marker = createSkillsMarker()
    expect(await marker.detect(routeDir)).toBe(false)
  })

  it("does not detect when skills/ exists but is empty", async () => {
    mkdirSync(join(routeDir, "skills"), { recursive: true })
    const marker = createSkillsMarker()
    expect(await marker.detect(routeDir)).toBe(false)
  })

  it("does not detect when skills/<name>/ has no SKILL.md", async () => {
    mkdirSync(join(routeDir, "skills", "stub"), { recursive: true })
    const marker = createSkillsMarker()
    expect(await marker.detect(routeDir)).toBe(false)
  })

  it("detects when at least one skills/<name>/SKILL.md exists", async () => {
    writeSkill("foo", "description: A foo skill.", "body")
    const marker = createSkillsMarker()
    expect(await marker.detect(routeDir)).toBe(true)
  })

  it("load contributes exactly one tool (readSkill) and one promptFragment, no state/transformers", async () => {
    writeSkill("foo", "description: A foo skill.", "body")
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.tools?.map((t) => t.name)).toEqual(["readSkill"])
    expect(contribution.promptFragment?.placement).toBe("after_user_prompt")
    expect(contribution.stateFields).toBeUndefined()
    expect(contribution.streamTransformers).toBeUndefined()
  })

  it("uses directory name as the skill name when frontmatter omits it", async () => {
    writeSkill("debug-python", "description: Debug Python.", "# Body")
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    const rendered = contribution.promptFragment?.render({}) ?? ""
    expect(rendered).toContain("**debug-python** — Debug Python.")
  })

  it("uses frontmatter.name when provided, overriding the directory name", async () => {
    writeSkill("dir-name", "name: override-name\ndescription: Overridden.", "body")
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    const rendered = contribution.promptFragment?.render({}) ?? ""
    expect(rendered).toContain("**override-name** — Overridden.")
    expect(rendered).not.toContain("**dir-name**")
  })

  it("fails fast when a SKILL.md has no frontmatter", async () => {
    writeSkill("bare", "", "# Just a body with no frontmatter")
    const marker = createSkillsMarker()
    await expect(marker.load(routeDir)).rejects.toThrow(/missing required frontmatter|missing required `description`/i)
  })

  it("fails fast when frontmatter lacks description", async () => {
    writeSkill("no-desc", "name: no-desc", "body")
    const marker = createSkillsMarker()
    await expect(marker.load(routeDir)).rejects.toThrow(/missing required `description`/i)
  })

  it("fails fast when two skills resolve to the same name", async () => {
    writeSkill("foo", "description: First.", "body")
    writeSkill("bar", "name: foo\ndescription: Duplicate.", "body")
    const marker = createSkillsMarker()
    await expect(marker.load(routeDir)).rejects.toThrow(/duplicate skill name/i)
  })

  it("skips invalid directory names silently (leading dot or spaces)", async () => {
    writeSkill("good", "description: Good one.", "body")
    mkdirSync(join(routeDir, "skills", ".hidden"), { recursive: true })
    writeFileSync(
      join(routeDir, "skills", ".hidden", "SKILL.md"),
      "---\ndescription: Hidden.\n---\nbody",
      "utf8",
    )
    mkdirSync(join(routeDir, "skills", "has spaces"), { recursive: true })
    writeFileSync(
      join(routeDir, "skills", "has spaces", "SKILL.md"),
      "---\ndescription: Spaced.\n---\nbody",
      "utf8",
    )
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    const rendered = contribution.promptFragment?.render({}) ?? ""
    expect(rendered).toContain("**good**")
    expect(rendered).not.toContain("**.hidden**")
    expect(rendered).not.toContain("has spaces")
  })

  it("rendered prompt fragment includes a '# Skills' header and a readSkill instruction", async () => {
    writeSkill("foo", "description: A foo skill.", "body")
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    const rendered = contribution.promptFragment?.render({}) ?? ""
    expect(rendered).toContain("# Skills")
    expect(rendered).toContain('readSkill({ name: "<name>" })')
  })

  it("readSkill returns the body for a known skill", async () => {
    writeSkill("foo", "description: A foo skill.", "FOO BODY CONTENT")
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    const readSkill = contribution.tools?.[0]
    const result = await readSkill?.run({ name: "foo" }, {
      signal: new AbortController().signal,
    })
    expect(result).toBe("FOO BODY CONTENT")
  })

  it("readSkill returns a helpful error for an unknown skill, listing what's available", async () => {
    writeSkill("foo", "description: A.", "body")
    writeSkill("bar", "description: B.", "body")
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    const readSkill = contribution.tools?.[0]
    const result = await readSkill?.run({ name: "nope" }, {
      signal: new AbortController().signal,
    })
    expect(result).toContain("Unknown skill: nope")
    expect(result).toContain("bar")
    expect(result).toContain("foo")
  })

  it("readSkill validates input shape (rejects non-string name)", async () => {
    writeSkill("foo", "description: A.", "body")
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    const readSkill = contribution.tools?.[0]
    // Trying to run with invalid input — should throw or return an error message.
    // The exact behavior depends on schema enforcement; the converter handles the
    // schema layer. Here we just make sure run() doesn't crash on bad input.
    await expect(async () => {
      await readSkill?.run({ name: 42 }, { signal: new AbortController().signal })
    }).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify RED**

```bash
pnpm --filter @dawn-ai/core test -- skills.test
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the marker**

Create `packages/core/src/capabilities/built-in/skills.ts`:

```ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { CapabilityMarker, PromptFragment } from "../types.js"
import { parseFrontmatter } from "./frontmatter.js"

const SKILLS_DIR = "skills"
const SKILL_FILE = "SKILL.md"
// Directory name must be a valid kebab-case-ish identifier. We exclude dotfiles,
// spaces, and other punctuation that would make a poor agent-facing name.
const VALID_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

const SKILLS_PROMPT_HEADER = `# Skills

The following skills are available. To use one, call \`readSkill({ name: "<name>" })\` to load its full instructions before acting.`

const READ_SKILL_INPUT = z.object({
  name: z.string().min(1),
})

interface LoadedSkill {
  readonly name: string
  readonly description: string
  readonly body: string
  readonly path: string
}

export function createSkillsMarker(): CapabilityMarker {
  return {
    name: "skills",
    detect: async (routeDir) => discoverSkillDirs(routeDir).length > 0,
    load: async (routeDir) => {
      const skills = loadSkills(routeDir)

      const readSkill = {
        name: "readSkill",
        description: "Load the full instructions for a named skill.",
        schema: READ_SKILL_INPUT,
        run: async (input: unknown) => {
          const { name } = READ_SKILL_INPUT.parse(input)
          const found = skills.find((s) => s.name === name)
          if (!found) {
            const available = skills.map((s) => s.name).sort().join(", ")
            return `Unknown skill: ${name}. Available: ${available}`
          }
          return found.body
        },
      }

      const promptFragment: PromptFragment = {
        placement: "after_user_prompt",
        render: () => {
          const lines = skills
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((s) => `- **${s.name}** — ${s.description}`)
            .join("\n")
          return `${SKILLS_PROMPT_HEADER}\n\n${lines}`
        },
      }

      return {
        tools: [readSkill],
        promptFragment,
      }
    },
  }
}

function discoverSkillDirs(routeDir: string): readonly string[] {
  const skillsDir = join(routeDir, SKILLS_DIR)
  if (!existsSync(skillsDir)) return []
  let entries: string[]
  try {
    entries = readdirSync(skillsDir)
  } catch {
    return []
  }
  return entries.filter((name) => {
    if (!VALID_DIR_NAME.test(name)) return false
    const full = join(skillsDir, name)
    let stat
    try {
      stat = statSync(full)
    } catch {
      return false
    }
    if (!stat.isDirectory()) return false
    return existsSync(join(full, SKILL_FILE))
  })
}

function loadSkills(routeDir: string): readonly LoadedSkill[] {
  const dirNames = discoverSkillDirs(routeDir)
  const loaded: LoadedSkill[] = []
  const seenNames = new Set<string>()

  for (const dirName of dirNames) {
    const path = join(routeDir, SKILLS_DIR, dirName, SKILL_FILE)
    let raw: string
    try {
      raw = readFileSync(path, "utf8")
    } catch (error) {
      throw new Error(`Failed to read ${path}: ${(error as Error).message}`)
    }
    const { frontmatter, body } = parseFrontmatter(raw)
    if (Object.keys(frontmatter).length === 0) {
      throw new Error(
        `${path} is missing required frontmatter. Add a YAML block at the top with at least \`description: …\`.`,
      )
    }
    const description = frontmatter.description
    if (!description || description.length === 0) {
      throw new Error(`${path} frontmatter is missing required \`description\` field.`)
    }
    const name = frontmatter.name && frontmatter.name.length > 0 ? frontmatter.name : dirName
    if (seenNames.has(name)) {
      const dupPath = loaded.find((s) => s.name === name)?.path
      throw new Error(
        `Duplicate skill name "${name}" — collision between ${dupPath} and ${path}. Each skill name must be unique.`,
      )
    }
    seenNames.add(name)
    loaded.push({ name, description, body, path })
  }

  return loaded
}
```

- [ ] **Step 4: Re-export from core**

Edit `packages/core/src/index.ts`. APPEND:

```ts
export { createSkillsMarker } from "./capabilities/built-in/skills.js"
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @dawn-ai/core test -- skills.test
```

Expected: 15/15 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/capabilities/built-in/skills.ts \
        packages/core/test/capabilities/skills.test.ts \
        packages/core/src/index.ts
git commit -m "feat(core): skills CapabilityMarker (skills/<name>/SKILL.md → system prompt listing + readSkill tool)"
```

---

## Task 3: Register the marker in the runtime

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`

- [ ] **Step 1: Find the registry creation**

```bash
grep -n "createCapabilityRegistry\|createPlanningMarker\|createAgentsMdMarker" packages/cli/src/lib/runtime/execute-route.ts
```

You'll see the registry already has two markers. Add a third.

- [ ] **Step 2: Add the marker**

In the `@dawn-ai/core` import block, add `createSkillsMarker`. Then update the registry array. Final state should look like:

```ts
import {
  applyCapabilities,
  createAgentsMdMarker,
  createCapabilityRegistry,
  createPlanningMarker,
  createSkillsMarker,
  // ... existing
} from "@dawn-ai/core"

// ... and downstream:

const registry = createCapabilityRegistry([
  createPlanningMarker(),
  createAgentsMdMarker(),
  createSkillsMarker(),
])
```

(Order: planning → agents-md → skills. Registration order = render order in the system prompt.)

- [ ] **Step 3: Build + typecheck**

```bash
pnpm --filter @dawn-ai/core build
pnpm --filter @dawn-ai/cli typecheck
```

Expected: passes.

- [ ] **Step 4: Run cli tests for no regression**

```bash
pnpm --filter @dawn-ai/cli test
```

Expected: passes, count unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/execute-route.ts
git commit -m "feat(cli): register skills capability marker"
```

---

## Task 4: Integration shape test in `@dawn-ai/langchain`

**Files:**
- Create: `packages/langchain/test/skills.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/langchain/test/skills.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  applyCapabilities,
  createCapabilityRegistry,
  createSkillsMarker,
} from "@dawn-ai/core"

describe("skills capability — end-to-end shape", () => {
  let routeDir: string

  beforeEach(() => {
    routeDir = mkdtempSync(join(tmpdir(), "dawn-skills-e2e-"))
  })

  afterEach(() => {
    rmSync(routeDir, { recursive: true, force: true })
  })

  function writeSkill(name: string, description: string, body: string): void {
    const dir = join(routeDir, "skills", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\ndescription: ${description}\n---\n\n${body}`,
      "utf8",
    )
  }

  it("contributes nothing when skills/ is absent", async () => {
    const registry = createCapabilityRegistry([createSkillsMarker()])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions).toEqual([])
  })

  it("contributes readSkill tool + prompt fragment when skills/ has at least one skill", async () => {
    writeSkill("foo", "A foo skill.", "Foo body")
    writeSkill("bar", "A bar skill.", "Bar body")
    const registry = createCapabilityRegistry([createSkillsMarker()])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions).toHaveLength(1)
    const contrib = result.contributions[0]?.contribution
    expect(contrib?.tools?.map((t) => t.name)).toEqual(["readSkill"])
    expect(contrib?.promptFragment?.placement).toBe("after_user_prompt")
    const rendered = contrib?.promptFragment?.render({}) ?? ""
    expect(rendered).toContain("# Skills")
    expect(rendered).toContain("**bar** — A bar skill.")
    expect(rendered).toContain("**foo** — A foo skill.")
  })

  it("readSkill returns the body content for the named skill", async () => {
    writeSkill("recipe", "Cooking recipe.", "Step 1: heat the pan.\nStep 2: add oil.")
    const registry = createCapabilityRegistry([createSkillsMarker()])
    const result = await applyCapabilities(registry, routeDir)
    const readSkill = result.contributions[0]?.contribution.tools?.[0]
    const output = await readSkill?.run(
      { name: "recipe" },
      { signal: new AbortController().signal },
    )
    expect(output).toBe("Step 1: heat the pan.\nStep 2: add oil.")
  })
})
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @dawn-ai/langchain test -- skills.test
```

Expected: 3/3 pass.

- [ ] **Step 3: Commit**

```bash
git add packages/langchain/test/skills.test.ts
git commit -m "test(langchain): skills capability end-to-end shape"
```

---

## Task 5: Seed example skills in the chat demo + README update

**Files:**
- Create: `examples/chat/server/src/app/chat/skills/workspace-conventions/SKILL.md`
- Create: `examples/chat/server/src/app/chat/skills/recover-from-failure/SKILL.md`
- Modify: `examples/chat/README.md`
- Modify: `examples/chat/server/src/app/chat/system-prompt.ts` (optional one-line addition)

- [ ] **Step 1: Create the first example skill**

`examples/chat/server/src/app/chat/skills/workspace-conventions/SKILL.md`:

```markdown
---
description: Reminders about how Dawn's workspace tools behave and what the path-jail allows.
---

# Workspace conventions

The four workspace tools (`listDir`, `readFile`, `writeFile`, `runBash`) all
operate inside `<example>/workspace/`. Reads and writes outside that directory
are rejected by the path-jail with a clear error.

- All paths are relative to the workspace root.
- `listDir({ path: "." })` lists the workspace root.
- `readFile({ path: "AGENTS.md" })` reads the memory file you also see in your
  system prompt (so reading it again is redundant; prefer the version Dawn
  injected for you).
- `runBash` spawns inside the workspace with a hard timeout. Use it for one-shot
  shell tasks; don't try to start long-lived background processes.

If you get a "Path is outside workspace" error, the path needs to be relative
to the workspace root and must not contain `..` segments.
```

- [ ] **Step 2: Create the second example skill**

`examples/chat/server/src/app/chat/skills/recover-from-failure/SKILL.md`:

```markdown
---
description: How to recover when a tool call fails — diagnose, not blindly retry.
---

# Recover from a failed tool call

When a tool call returns an error:

1. **Read the error message first.** Most Dawn tool errors are self-explanatory:
   path-jail violations, file-too-large, command exit codes.
2. **Don't retry the exact same call.** If `readFile({ path: "missing.txt" })`
   returned "ENOENT", calling it again won't help. Either list the directory to
   find the right name, or use `writeFile` to create the file.
3. **Check `AGENTS.md` for known conventions before improvising.** The memory
   file often documents the right approach the previous session figured out.
4. **If three different approaches fail in a row, stop and ask the user.** Don't
   keep flailing — explain what you tried and what went wrong.
5. **Record what worked in `AGENTS.md`** (via `writeFile`) when you find a fix
   that wasn't already documented. Future-you will thank you.
```

- [ ] **Step 3: Update example README**

In `examples/chat/README.md`, find the "What this shows" section and add a bullet for skills:

```markdown
- **Skills** — `src/app/chat/skills/<name>/SKILL.md` files are auto-listed in
  the agent's system prompt (name + description). The agent calls
  `readSkill({ name })` to load a skill's full body on demand. Two example
  skills ship with the demo: `workspace-conventions` and `recover-from-failure`.
```

Also in the "Deferred (Dawn phase-3 preview)" list near the bottom: remove the
line about skills if it's there (likely something like `- Skills (skills/ dir + SKILL.md loader) — mirror of the tools/ convention`).

- [ ] **Step 4: Optional — small system-prompt acknowledgment**

In `examples/chat/server/src/app/chat/system-prompt.ts`, append a paragraph after the existing memory convention paragraph (preserve everything else):

```
When a task matches one of the skills listed below in the "# Skills" section,
call \`readSkill({ name })\` to load that skill's full instructions before
proceeding.
```

(This is optional — Dawn's auto-injected `# Skills` section already tells the
agent what to do. But repeating it in the user-authored prompt reinforces the
behavior.)

- [ ] **Step 5: Verify the chat-server still builds + the route's typegen reflects readSkill**

```bash
pnpm --filter @dawn-example/chat-server build
pnpm --filter @dawn-example/chat-server check
cat examples/chat/server/.dawn/dawn.generated.d.ts | grep -A2 readSkill
```

Expected: build passes; `dawn check` reports the `/chat` route; generated `.d.ts` includes a `readSkill: (input: { name: string }) => Promise<string>` line under `DawnRouteTools["/chat"]`.

(If the generated types don't include `readSkill`, that's the same kind of typegen wiring we had to do for `write_todos` in PR #144 — we'd need to add `readSkill` as a `PLANNING_EXTRA_TOOL`-equivalent in `packages/cli/src/lib/typegen/run-typegen.ts`. Mention as a follow-up in your report if so.)

- [ ] **Step 6: Commit**

```bash
git add examples/chat/server/src/app/chat/skills examples/chat/README.md examples/chat/server/src/app/chat/system-prompt.ts
git commit -m "feat(examples/chat): seed two example skills + README"
```

---

## Task 6: Full workspace verification

- [ ] **Step 1:** `pnpm install`
- [ ] **Step 2:** `pnpm build` — expect 11/11 green
- [ ] **Step 3:** `pnpm typecheck` — expect 12/12
- [ ] **Step 4:** `pnpm test` — expect previous count + 32 new (~14 frontmatter + ~15 skills + 3 langchain integration), all green
- [ ] **Step 5:** `pnpm lint` — biome auto-fix any new-file issues; recommit as `style:` if needed
- [ ] **Step 6:** `pnpm pack:check`

---

## Task 7: Changeset

**Files:**
- Create: `.changeset/phase3-skills.md`

```markdown
---
"@dawn-ai/core": minor
"@dawn-ai/cli": minor
---

Add the phase-3 skills capability. A route with `src/app/<route>/skills/<name>/SKILL.md` files now exposes them to the agent via:

- An always-on `# Skills` section in the system prompt listing each skill's name + description
- A `readSkill({ name })` tool the agent calls to load a skill's full body on demand

Each `SKILL.md` requires YAML frontmatter with `description`; `name` defaults to the directory name and can be overridden. The body lives in conversation history after `readSkill` returns it (not re-injected each turn) — matches the deepagents / Claude Code convention. The chat example ships two seeded skills.
```

```bash
git add .changeset/phase3-skills.md
git commit -m "chore: changeset for phase-3 skills capability"
```

---

## Task 8: Push + PR (controller-side)

```bash
git push -u origin claude/skills
gh pr create --title "feat(core,cli): phase 3 — skills capability" --body <<<...
gh pr merge <N> --squash --delete-branch --auto
```

Wait for CI green. Clean up worktree after merge.
