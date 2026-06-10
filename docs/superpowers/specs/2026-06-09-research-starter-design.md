# Deep Research starter — the new default `create-dawn-ai-app` scaffold (Design)

**Status:** Approved for planning
**Date:** 2026-06-09
**Context:** Follows the harness-packaging consolidation ([PR #204]) that made adding a scaffold dependency a near-template-only change and shipped `@dawn-ai/evals` into the scaffold. The current default scaffold (`app-basic`, the `hello/[tenant]` greeter) proves the toolchain works but does **not** showcase Dawn's capability surface. This sub-project replaces the advertised default with a **Deep Research assistant** that exercises the broad feature set in one coherent, relatable app — while keeping the minimal `app-basic` template alive (un-advertised) as the generated-app harness's lifecycle fixture.

## Problem & goal

`create-dawn-ai-app` is a developer's first impression of Dawn. Today it emits a single-route greeter: one `agent()`, one trivial `greet` tool, one eval. It demonstrates that the build/typegen/eval/test loop works, but a developer evaluating Dawn against LangGraph/deepagents/etc. sees none of what makes Dawn opinionated — planning, subagents, skills, memory, workspace tools, HITL permissions, tool-output offloading, persistence.

**Goal:** ship a default scaffold that (a) leaves a "wow" impression by showing the broad feature set working together, (b) is relatable to a broad AI-engineering audience (a research/RAG assistant — a universally understood shape), (c) runs **offline and deterministically** out of the box (`npm create` → `npm test` / `npm run eval` green with no API key), runs for real under `--live`, and (d) is honestly a *starter*: every capability is a clearly-labeled seam a developer can extend or delete without unraveling the rest. We do **not** want a sprawling demo app that's hard to read or that pretends to be a product.

**Non-goals:** a production research product; a web UI (the scaffold is server-side; the existing chat example remains the UI showcase); novel runtime features (this is composition of shipped capabilities only); replacing the chat example.

## Design decisions (locked during brainstorming)

1. **Concept:** a "Deep Research assistant." Ask a question → a coordinator agent **plans** sub-questions → dispatches **`researcher` subagents** → each searches a **bundled local corpus** + reads full docs (large reads **offloaded**) → an optional "external fetch" runs through **workspace `runBash`** and is **HITL-gated** → guided by **skills** + **AGENTS.md memory** → writes a **cited report** to the workspace → threads **persist** via SQLite/Agent Protocol.
2. **It becomes the new advertised default.** `create-dawn-ai-app` with no `--template` flag emits the research app.
3. **Capability set = curated-broad.** Include the capabilities that read as "real research assistant" and skip the ones that would be ceremony. **In:** agent route, custom tools + typegen, subagents, planning, tool-output offloading, AGENTS.md memory, skills, HITL permissions (via workspace `runBash`), workspace, persistence, tests, evals. **Documented-only (commented seams, not active):** conversation summarization, non-agent route kinds, alternate storage backends.
4. **Corpus theme:** AI / agent engineering (RAG, evals, tool use, context windows, deep agents). It's the audience's home turf, keeps the bundled corpus small, and lets the sample questions/evals be genuinely meaningful.
5. **`app-basic` stays.** It is retained as a registered-but-un-advertised template and remains the generated-app harness's lifecycle fixture, bounding harness/fixture churn (see "Harness scope").
6. **Self-contained:** the corpus, the mock fixtures, and the fetch script are all bundled. No network, no key, no external service required for the default green path.

## Verified facts (against current code)

- **Template registry** (`packages/devkit/src/templates.ts`): `TEMPLATE_NAMES = ["basic"]`; `resolveTemplateDir(name)` maps `name` → `templates/app-<name>/` and `access()`-checks it. Adding a template = add the name to the tuple + create `templates/app-<name>/`. The **default** is chosen in `create-dawn-app` (not devkit) — see below.
- **Default selection + specifier threading** (`packages/create-dawn-app/src/index.ts`): builds template replacements, threads `dawnTestingSpecifier`/`dawnEvalsSpecifier` (internal mode → `file:packages/<pkg>`; external → dist-tag), and `applyInternalModePackageOverrides`. The chosen template name defaults here.
- **Generated-app harness specifiers** (`packages/devkit/src/testing/generated-app.ts`): `GeneratedAppSpecifiers` carries `dawnTesting` + `dawnEvals`; `normalizeSpecifiers` defaults them to `workspace:*`; `createGeneratedApp` resolves the template dir and writes replacements (`dawnTestingSpecifier`, `dawnEvalsSpecifier`, `appName`, `dawnCoreSpecifier`, …).
- **Scaffold packaging** (`test/harness/scaffold-packaging.ts`, PR #204): `SCAFFOLD_PACKAGES` (11 entries, already incl. `@dawn-ai/evals`, `@dawn-ai/permissions`, `@dawn-ai/sqlite-storage`, `@dawn-ai/workspace`) + `rewriteGeneratedAppDependencies({appRoot, tarballs, extraDependencies?, removeDependencies?})`. All lanes call it; per-lane deltas are `extraDependencies`/`removeDependencies` only. The research app's deps are **already covered** by `SCAFFOLD_PACKAGES` — no new package needs packing.
- **Capability discovery is filesystem-based** and route-relative (confirmed in `examples/chat`):
  - agent route: `src/app/<route>/index.ts` exporting `agent({ model, systemPrompt, description?, reasoning? })`.
  - tools: `src/app/<route>/tools/<name>.ts` — default-exports an `async (input: {…}) => …`; typegen reads the input type. (`greet.ts` is the canonical shape.)
  - subagents: `src/app/<route>/subagents/<name>/index.ts` exporting `agent({ description, systemPrompt, … })`; invoked via the `task({ subagent, input })` tool.
  - planning: presence of `src/app/<route>/plan.md` (may be empty) opts the route in; seeded checklist items become the thread's initial `todos`.
  - skills: `src/app/<route>/skills/<name>/SKILL.md` with frontmatter `description:`.
  - memory: `workspace/AGENTS.md` is injected into the system prompt.
  - workspace tools (`listDir`/`readFile`/`writeFile`/`runBash`) operate inside `workspace/` behind a path-jail; `runBash` is the HITL-gated capability.
  - permissions/offload/summarization/persistence configured in `dawn.config.ts` (`permissions`, `toolOutput`, `summarization`, storage). `app-basic`'s `dawn.config.ts` is `export default {}`; chat's seeds `permissions.allow/deny.bash`.
- `@dawn-ai/evals@1.0.0`, `@dawn-ai/testing@3.0.0` published; `dawn eval` (replay-default) and `dawn check`/`dawn build` work in a fresh app.
- **`script()` replay semantics** (for the bundled eval/test fixtures): each `.user()` resets `turnIndex` to 0; fixtures match `{userMessage substring, turnIndex, hasToolResult}`. `llmJudge` in replay is a fresh turnIndex-0 model call — match it with a follow-on `.user("<criteria substring>").replies('{"score":…}')` in the same chain (proven in `~/tmp/dawn-app/evals/quality.eval.ts`).

## Architecture

### New template: `packages/devkit/templates/app-research/`

```
app-research/
  package.json.template            # name, scripts (check/build/test/eval/typecheck), deps
  tsconfig.json.template
  gitignore.template
  npmrc.template
  dawn.config.ts                   # permissions (interactive + seeded allow/deny) +
                                   #   toolOutput.offload threshold + COMMENTED summarization seam
  .dawn/dawn.generated.d.ts        # placeholder ambient types (regenerated by `dawn check`)
  README.md                        # the tour: what each capability is, where it lives,
                                   #   which seams to extend vs. delete
  workspace/
    AGENTS.md                      # research memory: house style, citation rules, prefs
    corpus/                        # bundled AI/agent-engineering knowledge base (≈6-8 .md docs)
      retrieval-augmented-generation.md
      evaluating-llm-apps.md
      tool-use-and-function-calling.md
      context-windows-and-offloading.md
      agent-architectures.md
      … (small, factual, citable)
  scripts/
    fetch-source.mjs               # "external fetch" — offline stub by default; the HITL seam
  src/app/research/
    index.ts                       # coordinator agent({ model, reasoning, systemPrompt })
    plan.md                        # planning opt-in (seeded with a short research checklist)
    tools/
      searchCorpus.ts             # keyword/section search over workspace/corpus → hit list
      readDoc.ts                  # read a full corpus doc (large → offloaded automatically)
    subagents/
      researcher/index.ts         # per-sub-question specialist (uses searchCorpus/readDoc)
    skills/
      cite-sources/SKILL.md       # how to attribute claims to corpus docs
      synthesize-findings/SKILL.md# how to merge sub-answers into a cited report
    evals/
      research-quality.eval.ts    # defineEval over 2-3 cases, replay fixtures, gated
  test/
    research.test.ts.template      # harness test: plan → dispatch → cited report (replay)
```

### Capability → file mapping (the "tour")

| Capability | Where it lives | What the developer sees |
|---|---|---|
| Agent route | `src/app/research/index.ts` | `agent()` with a research-coordinator system prompt |
| Custom tools + typegen | `tools/searchCorpus.ts`, `tools/readDoc.ts` | typed `input`, return shape; `dawn check` generates ambient types |
| Subagents | `subagents/researcher/index.ts` | coordinator dispatches via `task({ subagent: "researcher", input })` |
| Planning | `plan.md` (seeded) | thread starts with a research checklist in `todos` |
| Tool-output offloading | `dawn.config.ts` `toolOutput` + `readDoc` on a big doc | large read replaced by a workspace-backed stub; retrievable |
| AGENTS.md memory | `workspace/AGENTS.md` | citation/house-style prefs injected into the system prompt |
| Skills | `skills/cite-sources`, `skills/synthesize-findings` | model-invoked guidance for attribution + synthesis |
| HITL permissions | `dawn.config.ts` `permissions` + `runBash`-invoked `fetch-source.mjs` | the "fetch an external source" step interrupts for approval |
| Workspace | `workspace/` (corpus + report output) | `listDir`/`readFile`/`writeFile`/`runBash` behind the path-jail |
| Persistence | `dawn.config.ts` storage (SQLite default) | threads survive restart; Agent Protocol endpoints |
| Tests | `test/research.test.ts` | `createAgentHarness` + `script()`, replay |
| Evals | `evals/research-quality.eval.ts` | `defineEval` + scorers + `gate.*`, `dawn eval` |
| Summarization (seam) | `dawn.config.ts` (commented) | documented opt-in, not active by default |

### Data flow (one request)

1. User asks a research question on the `research` route.
2. Coordinator reads `plan.md`-seeded todos + `AGENTS.md` memory, **plans** the sub-questions, updates `todos`.
3. For each sub-question, coordinator calls `task({ subagent: "researcher", input })`.
4. `researcher` calls `searchCorpus({ query })` → ranked hits, then `readDoc({ path })` for the best hits. A large doc read trips the **offload** threshold → the tool result is a stub pointing at a workspace file; the model retrieves detail on demand.
5. If the corpus lacks coverage, the coordinator may run `runBash("node scripts/fetch-source.mjs <topic>")` — an **external-fetch seam** that is **HITL-gated** (interactive permission). Offline, the stub returns a canned "no external access configured" note so the green path never blocks.
6. Guided by the `cite-sources` + `synthesize-findings` **skills**, the coordinator merges sub-answers into a **cited report** and `writeFile`s it to `workspace/reports/<slug>.md`.
7. The thread **persists** (SQLite checkpointer / Agent Protocol), so a follow-up resumes context.

### Offline / deterministic behavior

- **Default (no key):** tests and `dawn eval` run in **replay** mode against bundled `script()` fixtures; the corpus is real files on disk; `fetch-source.mjs` returns its offline stub. `npm test` and `npm run eval` are green with zero configuration.
- **`--live` / real key:** the same routes run against a real model; `searchCorpus`/`readDoc` hit the same corpus; the fetch seam can be wired to a real source by the developer. `dawn eval --live` re-scores against the live model (and can `--record` fixtures, future fast-follow).

### `dawn.config.ts` for the research app

```ts
export default {
  appDir: "src/app",
  // HITL: interactive by default so the external-fetch step demonstrates the approval flow.
  permissions: {
    allow: { bash: ["ls", "cat", "node scripts/fetch-source.mjs"] },
    deny: { bash: ["rm -rf", "sudo", "curl", "wget"] },
  },
  // Offloading: large readDoc results are spilled to the workspace and stubbed in-context.
  toolOutput: { offload: { /* threshold tuned so a full corpus doc trips it */ } },
  // Persistence: SQLite checkpointer + Agent Protocol (default).
  // --- Seam (documented, inactive): conversation summarization ---
  // summarization: { /* enable when threads grow long; see README */ },
}
```
(Exact `toolOutput`/storage keys are pinned in the plan against the shipped `DawnConfig` types — the snippet shows intent, not final field names.)

## Harness scope

The generated-app verification lanes (`test/generated`, `test/runtime`, `test/smoke`) exercise the full pack→install→boot lifecycle. Re-pointing them at the richer research template would balloon the `*.expected.json` fixtures and couple lane stability to the demo content. **Decision:** the lanes continue to scaffold **`app-basic`** (the minimal lifecycle fixture); `app-basic` is kept in the registry but **not advertised** as a user choice. The research app is validated by its **own bundled `test/research.test.ts` + `evals/research-quality.eval.ts`** (which run in the generated app), plus a single new **smoke assertion** that `create-dawn-ai-app` with no `--template` emits the research route and its files. This bounds harness/fixture churn to: (1) add `"research"` to `TEMPLATE_NAMES`, (2) default to it in `create-dawn-app`, (3) one create-app test asserting the default output, (4) no `SCAFFOLD_PACKAGES`/rewrite changes (all deps already covered).

## Testing & evals (shipped inside the generated app)

- **`test/research.test.ts`** — `createAgentHarness` drives one end-to-end request with `script()` fixtures: assert the plan/todos populate, the `researcher` subagent is dispatched (`toMatchSubagent`/capability matchers), `searchCorpus`/`readDoc` are called, and a cited report is written. Replay-only; green offline.
- **`evals/research-quality.eval.ts`** — `defineEval` over 2-3 questions with per-case `script()` fixtures; scorers: `toolCalled("searchCorpus")`, `contains`/`regex` for a citation marker, `custom` for "report cites ≥1 corpus doc", and `llmJudge` ("answer is grounded in the cited sources") with a replay judge fixture. `gate.all(gate.passRate(1), gate.perScorer())`. `dawn eval` green offline.

## Project decomposition (single plan, ordered tasks)

This is one implementation plan (not multiple sub-projects). Rough task order for the writing-plans phase:

1. Create `templates/app-research/` skeleton (`package.json.template`, tsconfig/gitignore/npmrc, `.dawn` placeholder).
2. Bundle the corpus (`workspace/corpus/*.md`) + `workspace/AGENTS.md`.
3. Coordinator route `index.ts` + seeded `plan.md`.
4. Tools `searchCorpus.ts` + `readDoc.ts`.
5. `researcher` subagent.
6. Skills `cite-sources` + `synthesize-findings`.
7. `scripts/fetch-source.mjs` offline stub.
8. `dawn.config.ts` (permissions + offload + commented summarization).
9. `test/research.test.ts.template` (replay).
10. `evals/research-quality.eval.ts` (replay, gated).
11. `README.md` tour (extend/delete seams; honest about offline replay).
12. Register `"research"` in `TEMPLATE_NAMES`; default `create-dawn-app` to it; keep `basic` registered/un-advertised.
13. Create-app test: default scaffold emits the research route + files.
14. Full local validate across the three harness lanes (`app-basic` unchanged) + a cold `create-dawn-ai-app` of the research app: `dawn check && npm run build && npm test && npm run eval` all green offline.
15. Changeset (`create-dawn-ai-app` minor; `devkit` if `TEMPLATE_NAMES` is part of its public surface), phase memory, PR.

## Out of scope (cut as over-engineering)

- A web UI for the research app (the chat example remains the UI showcase).
- Real external retrieval / a hosted corpus (the fetch script is an offline seam).
- Active conversation summarization (documented seam only — the corpus is small).
- Multiple corpus themes / a theme picker (one curated AI-engineering corpus).
- Re-pointing the generated-app harness lanes at the research template.
- `dawn eval --record` automation (separate fast-follow already queued).
