# Drop-in AG-UI Activity Renderers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Dawn's plan and subagent activities render out of the box — `pnpm add @dawn-ai/ag-ui` plus one prop — instead of requiring a developer to hand-copy ~231 lines of React out of an example, and fix the regression where Dawn's own chat example now shows nothing when the agent plans.

**Architecture:** Add a `./react` subpath export to the existing `@dawn-ai/ag-ui` package (no new npm package — see "Why a subpath"). Move the proven activity schemas and card components out of `examples/research/web` into `packages/ag-ui/src/react/`, exporting three layers: a ready-to-spread `dawnActivityRenderers` array (the drop-in), the individual renderers, and the plain card components plus content schemas for anyone customizing. Both examples then consume the package, which proves portability and fixes the chat regression in the same change.

**Tech Stack:** TypeScript (first JSX-emitting library package in this repo), React 19 + `@copilotkit/react-core` v2 as OPTIONAL peer deps, zod 4 (Standard Schema) as a dependency, Vitest with `react-dom/server` (no jsdom needed), Node 24, pnpm 10, Biome, Changesets.

**Why this now:** After #483, `writeTodos` and a started `task` present ONLY as `ACTIVITY_SNAPSHOT` events. CopilotKit's `renderActivityMessage` does `if (!renderer) return null`. So any client without renderers shows *nothing* for planning and delegation — verified today in `examples/chat/web` (which has `examples/chat/server/src/app/chat/plan.md`, so planning is active, and `app/page.tsx:17` registers no renderers). The docs call that example "the canonical reference client." Shipping canonical activities without shipping a way to render them is the gap this closes.

**Why a subpath, not a new package:** `@dawn-ai/ag-ui` already has a multi-entry `exports` map (`.` and `./sse`), so `./react` is a trodden path. A new package would need a manual npm bootstrap before the Version PR (OIDC cannot create package names), and the repo's Release workflow is currently `disabled_manually` with 34 changesets queued — adding that coordination now buys nothing. Server consumers importing `.` never load the React entry.

**Execution baseline:** Branch `blove/ag-ui-react-renderers` (already created) off `main` at `7fb00a19d7e6c476ec2fe2ce96f92f0583968cb9`. Never edit `pnpm-lock.yaml` by hand — but note this plan DOES change dependencies, so `pnpm install` (no `--frozen-lockfile`) is expected in Task 1 and the resulting lockfile change must be committed.

**Toolchain trap:** Prefix every node/pnpm command with `export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && ` (shell state does not persist; the default shell is Node 22). Never run bare `biome check --write` — pass explicit paths with `--config-path packages/config-biome/biome.json`.

**Dependency order:** Task 1 (build config) gates everything. Tasks 2–3 build the package. Task 4 (research example) proves parity. Task 5 (chat example) fixes the regression. Tasks 6–7 are docs and release.

---

### Task 1: Make `@dawn-ai/ag-ui` able to emit JSX

This is the only genuinely unknown part. `packages/ag-ui/tsconfig.json` extends `../config-typescript/node.json`, whose `lib` is `["ES2022"]` with no `jsx` setting, and its `include` is `["src/**/*.ts"]`. The repo's only other `.tsx` lives in `packages/inspector`, which is a Next app using `jsx: "preserve"` + `noEmit` — no precedent for a library that EMITS JSX.

**Files:**
- Modify: `packages/ag-ui/tsconfig.json`
- Modify: `packages/ag-ui/package.json`
- Create: `packages/ag-ui/src/react/smoke.tsx` (temporary probe, deleted in Step 5)

- [ ] **Step 1: Add the React toolchain to the package**

In `packages/ag-ui/package.json`:
- add to `exports`:

```json
    "./react": {
      "types": "./dist/react/index.d.ts",
      "default": "./dist/react/index.js"
    }
```

- add `"zod": "^4.4.3"` to `dependencies` (match the version used elsewhere in the repo — check `examples/research/web/package.json` and `packages/core/package.json` and use the same range);
- add optional peers:

```json
  "peerDependencies": {
    "@copilotkit/react-core": ">=1.66.0",
    "react": ">=19.0.0"
  },
  "peerDependenciesMeta": {
    "@copilotkit/react-core": { "optional": true },
    "react": { "optional": true }
  }
```

- add devDependencies needed to compile and test the JSX: `"@copilotkit/react-core"`, `"react"`, `"react-dom"`, `"@types/react"`, `"@types/react-dom"` — pin the SAME versions the examples use (`react`/`react-dom` `19.2.8`, `@copilotkit/react-core` `^1.66.0`; look up the `@types/*` versions already present anywhere in the repo, else use the current majors).
- extend the `lint` script's path list to include the new source (it currently lists `package.json src tsconfig.json vitest.config.ts` — `src` already covers it, so likely no change; verify).

In `packages/ag-ui/tsconfig.json`:
- add `"jsx": "react-jsx"` to `compilerOptions` (NOT `preserve` — a library must emit runnable JS);
- add `"lib": ["ES2022", "DOM"]` (the cards touch no DOM APIs, but React's types need it);
- change `include` to `["src/**/*.ts", "src/**/*.tsx"]`.

- [ ] **Step 2: Write the probe**

```tsx
// Temporary build probe — deleted in this task's final step.
export function SmokeProbe(props: { readonly label: string }) {
  return <span data-testid="smoke">{props.label}</span>
}
```

- [ ] **Step 3: Install and build**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm install
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui build
```

Expected: build succeeds. `pnpm install` (no `--frozen-lockfile`) will update `pnpm-lock.yaml` — that is intended here.

- [ ] **Step 4: Verify the emit is real, not preserved JSX**

```bash
cat packages/ag-ui/dist/react/smoke.js
```

Expected: the file contains a `jsx`/`jsxs` runtime call and imports from `react/jsx-runtime` — NOT raw `<span>` JSX. If it contains raw JSX, `jsx` is still `preserve` and consumers would fail to parse it. Also confirm `packages/ag-ui/dist/react/smoke.d.ts` exists.

Then verify the server entry is unaffected:

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && node -e "import('@dawn-ai/ag-ui').then(m => console.log(Object.keys(m).length + ' server exports, no react needed'))"
```

Run that from `packages/cli` (a server consumer) so resolution goes through the workspace link.

- [ ] **Step 5: Delete the probe, rebuild, verify the whole repo still builds**

```bash
rm packages/ag-ui/src/react/smoke.tsx
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm build
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui test
```

If `pnpm build` fails anywhere else (stale `dist/react` output with no source, a pack-check on unexpected files), fix it here — `scripts/pack-check` style guards have caught orphaned `dist` output before.

- [ ] **Step 6: Commit**

```bash
git add packages/ag-ui/package.json packages/ag-ui/tsconfig.json pnpm-lock.yaml
git commit -m "build(ag-ui): emit JSX for the react entry point"
```

**If Step 4 shows JSX cannot be emitted cleanly** (e.g. the composite build or `isolatedModules` fights it), STOP and report BLOCKED with the exact error — do not work around it by shipping `.js` written by hand.

---

### Task 2: Move the content schemas into the package

**Files:**
- Create: `packages/ag-ui/src/react/schemas.ts`
- Create: `packages/ag-ui/test/react/schemas.test.ts`
- Read (source of truth): `examples/research/web/app/components/ActivitySchemas.ts`

- [ ] **Step 1: Move the file**

Copy `examples/research/web/app/components/ActivitySchemas.ts` into `packages/ag-ui/src/react/schemas.ts` VERBATIM except: change the `@dawn-ai/ag-ui` type imports to relative imports (`../activities.js`), and export the schemas under their existing names (`planActivityContentSchema`, `subagentActivityContentSchema`). KEEP the compile-time assignability probes (`assignPlanOutputToPublicType` and its subagent twin) — they are what keeps the zod mirror honest against the TS types.

Do NOT rewrite the schemas as hand-rolled validators in this task. They are proven and carry a test suite; the duplicated shape is a known trade-off recorded in Task 7's follow-up note.

- [ ] **Step 2: Write tests**

Create `packages/ag-ui/test/react/schemas.test.ts` covering, for BOTH schemas: a valid payload parses; an unknown extra field is rejected (this is the documented "fails closed" behavior — verify what the schema actually does first and pin the real behavior); a wrong-typed field is rejected; and the `~standard` Standard Schema interface is present (`typeof schema["~standard"].validate === "function"`), because that is what CopilotKit calls.

If the schemas turn out NOT to reject unknown fields, pin the actual behavior and note the discrepancy with the docs claim in your report — do not silently change either.

- [ ] **Step 3: Run and commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui test
git add packages/ag-ui/src/react/schemas.ts packages/ag-ui/test/react/schemas.test.ts
git commit -m "feat(ag-ui): ship the activity content schemas"
```

---

### Task 3: Move the cards and expose the renderers

**Files:**
- Create: `packages/ag-ui/src/react/ActivityChecklist.tsx`, `PlanActivityCard.tsx`, `SubagentActivityCard.tsx`, `renderers.ts`, `index.ts`
- Create: `packages/ag-ui/test/react/renderers.test.tsx`
- Read (source of truth): the same-named files in `examples/research/web/app/components/`, plus `ActivityRenderers.tsx` and `ActivityRenderers.test.tsx`

- [ ] **Step 1: Move the three card components verbatim**

Copy `ActivityChecklist.tsx`, `PlanActivityCard.tsx`, `SubagentActivityCard.tsx` into `packages/ag-ui/src/react/`, changing only the `@dawn-ai/ag-ui` type imports to relative (`../activities.js`) and local imports to match the new layout. Keep the inline `style` objects exactly as they are — they are the reason these are portable (no Tailwind, no CSS import, no design-system dependency). Do not restyle, rename props, or "improve" them.

- [ ] **Step 2: Create `renderers.ts`**

Port `ActivityRenderers.tsx`'s two `satisfies ReactActivityMessageRenderer<...>` definitions, importing the type from `@copilotkit/react-core/v2`. Export:

```ts
export const dawnPlanActivityRenderer = /* … */
export const dawnSubagentActivityRenderer = /* … */

/**
 * Both built-in Dawn activity renderers, ready to hand to CopilotKit:
 *
 * ```tsx
 * <CopilotKit runtimeUrl="/api/copilotkit" renderActivityMessages={dawnActivityRenderers}>
 * ```
 *
 * Dawn presents `writeTodos` and a started `task` ONLY as these activities —
 * a client that registers no renderer for them shows nothing for that work.
 */
export const dawnActivityRenderers = [dawnPlanActivityRenderer, dawnSubagentActivityRenderer]
```

Keep the existing exported name `activityMessageRenderers` as an alias ONLY if the example currently imports it by that name and you want a smaller example diff — otherwise use the new names and update the example in Task 4. Prefer the new names; a public API should not inherit an example's local naming.

- [ ] **Step 3: Create `index.ts` for the subpath**

Export, with a file-level doc comment explaining the three layers:
- `dawnActivityRenderers`, `dawnPlanActivityRenderer`, `dawnSubagentActivityRenderer` (the CopilotKit binding);
- `PlanActivityCard`, `SubagentActivityCard`, `ActivityChecklist` (plain React components taking `content` — usable by any client, CopilotKit or not);
- `planActivityContentSchema`, `subagentActivityContentSchema` (for custom renderers).

Do NOT re-export the activity type constants/types — they already come from the root entry, and duplicating them across entries invites drift.

- [ ] **Step 4: Move the test suite**

Move `examples/research/web/app/components/ActivityRenderers.test.tsx` (413 lines) to `packages/ag-ui/test/react/renderers.test.tsx`, adjusting imports to the package's internal paths. It uses `react-dom/server` (`renderToString`), so no jsdom is required — confirm `packages/ag-ui/vitest.config.ts` needs no environment change. If the suite asserts on the old export name `activityMessageRenderers`, update those assertions to the new names.

- [ ] **Step 5: Verify and commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui build
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/ag-ui && npx tsc --noEmit
```

Expected: the pre-existing 129 ag-ui tests plus the moved suite, all green.

```bash
git add packages/ag-ui/src/react packages/ag-ui/test/react
git commit -m "feat(ag-ui): ship drop-in plan and subagent activity renderers"
```

---

### Task 4: The research example consumes the package

This is the parity proof: if the example still renders identically while importing from the package, the move was faithful.

**Files:**
- Delete: `examples/research/web/app/components/ActivitySchemas.ts`, `ActivityRenderers.tsx`, `ActivityRenderers.test.tsx`, `PlanActivityCard.tsx`, `SubagentActivityCard.tsx`, `ActivityChecklist.tsx`
- Modify: `examples/research/web/app/page.tsx`, `examples/research/web/package.json`
- KEEP: `ToolCallCard.tsx` (research-specific — it hardcodes this app's tool names and unwraps Dawn/LangChain envelopes; it is not portable and stays local)

- [ ] **Step 1: Switch the wiring**

In `app/page.tsx`, replace the local import with `import { dawnActivityRenderers } from "@dawn-ai/ag-ui/react"` and pass it to `renderActivityMessages`. Delete the six moved files. Remove `zod` from the example's dependencies IF nothing else in the example imports it (grep first — `ToolCallCard.tsx` may not need it).

- [ ] **Step 2: Verify the example still builds and tests**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm install
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web build
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web test
```

(Use the example's real package name and its available scripts — check its `package.json`; if it has no `test` script after the suite moved, that is expected and fine.)

- [ ] **Step 3: Commit**

```bash
git add examples/research/web pnpm-lock.yaml
git commit -m "refactor(example): consume the shipped activity renderers"
```

---

### Task 5: Fix the chat example regression

**Files:**
- Modify: `examples/chat/web/app/page.tsx`, `examples/chat/web/package.json`

- [ ] **Step 1: Register the renderers**

Add `@dawn-ai/ag-ui": "workspace:*"` to the example's dependencies, import `dawnActivityRenderers`, and pass `renderActivityMessages={dawnActivityRenderers}` on the `CopilotKit` element at `app/page.tsx:17`. Add a brief comment saying why it is there: this route has `plan.md`, so the agent plans, and Dawn presents planning only as an activity.

- [ ] **Step 2: Fix the two stale version comments**

`examples/chat/web/app/page.tsx:6` and `examples/research/web/app/components/ToolCallCard.tsx:4` both claim they were "verified against installed @copilotkit/react-core@1.62.3"; the installed version is 1.66.4. Update both to the version actually installed (verify it, do not copy this number blindly).

- [ ] **Step 3: Verify and commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm install
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter <chat web package name> build
```

```bash
git add examples/chat/web examples/research/web/app/components/ToolCallCard.tsx pnpm-lock.yaml
git commit -m "fix(example): render plan activities in the chat client"
```

---

### Task 6: Collapse the recipe and correct the onboarding docs

The current recipe is a copy-paste of ~85 lines from the page PLUS ~154 lines the reader must fetch from GitHub — and it never mentions installing `zod`. As written it does not compile. With the package, it becomes an install and a prop.

**Files:**
- Modify: `apps/web/content/docs/recipes/research-web-ui.mdx`
- Modify: `apps/web/content/docs/ag-ui.mdx`
- Modify: `packages/ag-ui/README.md`
- Modify: `packages/devkit/templates/app-research/README.md`, `examples/research/web/README.md` (only where they describe copying renderers)
- Do NOT touch `packages/cli/docs/` — it is generated and gitignored

- [ ] **Step 1: Rewrite the recipe's renderer section**

Replace the `ActivitySchemas.ts` and `ActivityRenderers.tsx` code blocks with:

````md
```bash
pnpm add @dawn-ai/ag-ui
```

```tsx
import { dawnActivityRenderers } from "@dawn-ai/ag-ui/react"

<CopilotKit runtimeUrl="/api/copilotkit" renderActivityMessages={dawnActivityRenderers}>
```
````

Keep the surrounding recipe (runtime route, page wiring, the wildcard tool card, permission interrupt) intact. Add a short paragraph noting the cards are plain React components exported for customization (`PlanActivityCard`, `SubagentActivityCard`) and the content schemas are exported for anyone writing their own renderer.

- [ ] **Step 2: Update `ag-ui.mdx`**

The page currently says the chat example "registers no activity renderers" and points readers at the research recipe for cards. That is no longer true (Task 5). Update it, and turn the existing warning callout — "a client that registers no activity renderer sees less" — into actionable guidance: register `dawnActivityRenderers`, one line.

- [ ] **Step 3: `packages/ag-ui/README.md`**

Document the `./react` subpath: the drop-in array, the individual renderers, the cards, the schemas, and the optional peer deps (a server-only consumer installs nothing extra).

- [ ] **Step 4: Verify**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && node scripts/check-docs.mjs
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/cli test
```

Check `AGENTS.md` / `scripts/check-docs.mjs`'s `forbiddenContent` before writing prose.

- [ ] **Step 5: Commit**

```bash
git commit -m "docs: make activity rendering an install, not a copy-paste"
```

---

### Task 7: Changeset, full verification, review

- [ ] **Step 1: Changeset** — `.changeset/ag-ui-react-renderers.md`:

```markdown
---
"@dawn-ai/ag-ui": patch
---

Ship the plan and subagent activity renderers as `@dawn-ai/ag-ui/react`. A
CopilotKit client can now render Dawn's built-in orchestration by passing
`dawnActivityRenderers` to `renderActivityMessages`, instead of copying React
components out of an example. The card components and content schemas are
exported too, for clients that want their own presentation. React and
`@copilotkit/react-core` are optional peer dependencies, so server-only
consumers install nothing extra.
```

MUST be `patch` — the fixed 0.x group turns a `minor` into a 1.0.0 bump.

- [ ] **Step 2: Full gates, reporting each exit code explicitly (never pipe in a way that hides them)**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm build
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/cli test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm lint
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && node scripts/check-docs.mjs
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm vitest run --config test/generated/vitest.config.ts run-generated-research-activation
```

Also run the repo's packaging guard if one exists (`scripts/pack-check.mjs` / `pnpm pack:check`) — this task changes a published package's `exports` map and dependencies, which is exactly what that guard is for.

- [ ] **Step 3:** Commit the changeset, then use superpowers:requesting-code-review on `git diff main...HEAD`, then superpowers:finishing-a-development-branch. PR title: `feat(ag-ui): ship drop-in activity renderers`. The body must state the chat-example regression this fixes, the new subpath, and that peer deps are optional.

**Follow-up to record in the PR body (do not implement):** the zod schemas duplicate the shape of the TS content types, kept honest only by a compile-time assignability probe. A single source of truth — deriving the types from the schemas, or generating Standard Schema validators from the existing internal parsers — would remove that duplication.

---

## Out of scope

- Promoting a web client into the default generated scaffold (`create-dawn-ai-app` templates ship no UI). That is the natural next slice once the renderers are a package, and the earlier design flagged a browser activation gate as its prerequisite.
- A generic tool-card component (`ToolCallCard` is research-specific and stays in the example).
- Any change to the AG-UI wire protocol, the ledger, or suppression behavior.
- Restyling the cards or adding theming APIs.
