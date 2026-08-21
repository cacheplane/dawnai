# Handoff — Dawn Workbench (SP2a)

Paste the block below into a fresh session to continue.

---

Continue the Dawn scaffold-UI arc. Work in `/Users/blove/repos/dawn/.claude/worktrees/gifted-kirch-ddd03f`.

## Where things are

- `main` is at `fb52e062`. Seven PRs shipped this session (#481–#486 plus #485), all merged with green post-merge CI.
- Current branch is `blove/dawn-workbench` at `994155ff`, clean, one commit ahead of main containing only the SP2a plan doc.
- **Your task: execute `docs/superpowers/plans/2026-08-20-dawn-workbench-foundation.md` (SP2a).** Use superpowers:subagent-driven-development. The plan is self-contained; read it first.

## What shipped, so you know what you're building on

Three arcs completed. Read `docs/superpowers/specs/2026-08-19-dawn-workbench-design.md` (SP2's approved spec) and `docs/superpowers/specs/2026-08-19-dawn-activity-design-system-design.md` (SP1, shipped) before starting.

1. **Logical tool-call identity** (#481/#482/#483): root AG-UI `tool_call`/`tool_result` events are keyed by the model's tool-call ID, not LangChain's execution run ID. `writeTodos` and a started `task` now present ONLY as `dawn.plan`/`dawn.subagent` activities — the generic tool frames are suppressed by a ledger in `packages/ag-ui/src/orchestration-ledger.ts`, which fails open in every uncertain case.
2. **Drop-in renderers** (#484): `@dawn-ai/ag-ui/react` ships the cards. `examples/chat/web` is the default-tier consumer (one CSS import, no config).
3. **Activity design system** (#486): the cards got Dawn's visual identity plus a four-rung customization ladder — tokens (`--dawn-activity-*` via `@dawn-ai/ag-ui/react/styles.css`), `classNames` per part (APPEND, never replace), `components` leaf slots (`TodoRow`/`ToolRow`), and documented eject.

## The product decisions (Brian's, already made — do not relitigate)

- **Option A**: a fully scaffolded, beautiful UI ships with the generated app. "It's the first impression after install."
- Delivered as **full source the user owns** (shadcn model), with packaged cards carrying Dawn's identity by default plus real extension points.
- **The workbench is the dogfood.** If matching the flagship design requires *ejecting* a card rather than customizing it, that is a gap to fix in SP1's package — NOT a workaround to absorb in the example. Report it.
- Layout: **agent workbench** — thread rail left, one wide transcript with activity cards inline.
- Visual: **crisp neutral** (zinc, hairline borders) with the **dawn gradient in exactly two places** — brand mark and primary action.
- Tailwind v4 in the example only; never in the package.
- **The demo requires an API key.** There is no keyless "demo mode" (that retires the 2026-07-06 slice-2 plan). Test lanes stay aimock-backed and keyless — CI defines no model key and the activation lane actively asserts ambient credentials go unused.
- Release: publish thoroughly once production artifacts can be verified. SP4's browser gate is that verification.

## Sub-projects

- SP1 Activity Design System — **shipped** (#486)
- **SP2a Workbench foundation — your task** (theme, ThreadSource, activity wrappers, shell)
- SP2b — memory panel, allowlisted `/api/dawn/[...path]` proxy, thread hydration from `GET /threads/:id/state`, ConnectScreen, themed tool card
- SP3 — scaffold integration (npm workspaces, ports, generation, byte-for-byte parity guard, two-process harness)
- SP4 — Playwright activation gate

## Environment rules (non-negotiable)

- Prefix EVERY node/pnpm command with `export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && `. Shell state does not persist between calls; the default shell is Node 22 and makes ~8 unrelated tests fail spuriously.
- Never run bare `biome check --write` (it mass-reformats). Use explicit paths with `--config-path packages/config-biome/biome.json`.
- Never hand-edit `pnpm-lock.yaml`. This plan changes deps, so `pnpm install` without `--frozen-lockfile` is expected — commit the lockfile change.
- `packages/cli/docs/` is generated and gitignored; edit `apps/web/content/docs/` instead.

## Traps that have already cost time here

1. **vitest globs.** A `.tsx` suite under a `.test.ts`-only glob collects ZERO tests and exits 0. Always assert the test COUNT moved, never just that a file exists. (`examples/research/web/vitest.config.ts` already matches `{ts,tsx}` — verify before relying on it.)
2. **CI runs the activation lane through `pnpm verify:harness:framework`, not `pnpm vitest run --config test/generated/...`.** The wrapper SWALLOWS assertions and prints only `failed=1`. To see a real failure, download the run's `harness-artifacts` and read `framework/vitest-report.json`.
3. **A red check can be a flake AND a real finding in the same run.** On #486, `validate` was a genuine pre-existing flake (`test/harness/packaged-app-rejected-close.test.ts`, on main since 2026-08-10) while `CodeQL` was a real high-severity finding. Do not generalize one explanation to the other reds.
4. **PR code-scanning findings live on `refs/pull/<N>/merge`, not in repo-level alerts** (which only cover the default branch). Query `code-scanning/analyses?ref=refs/pull/<N>/merge` and check `results_count`. A failing check from the `github-advanced-security` app blocks merge even though `required_status_checks` is only `["validate"]`.
5. **When a static-analysis rule keeps firing after you apply its suggested fix, it objects to the SHAPE.** `js/incomplete-multi-character-sanitization` on a tag-stripping `replace` survived the documented "repeat until stable" remediation (it re-flagged the seed call). Switching from removal to extraction — collect `<`-free runs via `matchAll(/>([^<]*)/g)` — made it safe by construction.
6. **Do NOT use CopilotKit's `useThreads`.** It fetches from a platform with thread endpoints and folds "runtime without thread endpoints" into its error channel. Dawn's server has no thread-list endpoint. That is why the plan specifies a `ThreadSource` seam (localStorage now, LangGraph Platform later, where those endpoints do exist).
7. **Adding a subpath to a published package red-lines `check-docs`**, revealing requirements one layer at a time: `ARTIFACT_REGISTRY`, the API MDX ownership table, `api.mdx`, a README runtime+stability binding line, `api-reference.test.ts`, and frozen counters (total AND import). Not needed for SP2a (private example) but relevant if scope grows.

## The habit that found every real defect this session

Read each artifact the way its consumer sees it, not the way you wrote it. Tests were green through all of these:

- A gated-then-resumed tool rendered two cards, one stuck "in progress" forever.
- Dawn's own chat example went blank while the agent planned.
- The documented recipe never compiled — it told readers to copy files whose source appeared nowhere, and the rewrite reintroduced the same class of bug.
- A 413-line test suite collected zero tests.
- `--dawn-activity-accent` was documented as the headline knob and referenced by no rule.
- The eject instructions took three passes to state accurately (each card has TWO internal specifiers resolving to TWO different entries).

## Open items that are Brian's, not yours

- **37 changesets** queued unreleased; the Release workflow is `disabled_manually` (off since 2026-08-10, plausibly due to a merge-concurrency stampede that cancelled in-flight publishes). Nothing from this session reaches npm until it is re-enabled. Do not re-enable it — it publishes to a public registry.
- **Anthropic org credits are at zero**, so the PR review bot has failed its preflight on all seven PRs.
- Vercel PR deploys fail repo-wide on PRs that touch no `apps/web` code.

## Definition of done for SP2a

A workbench you can talk to: thread rail with create/switch, custom transcript rendering plan and subagent cards inline in Dawn's design, composer, and a first-run empty state with working suggestions. Full gates green (`pnpm build`, `pnpm lint`, `check-docs`, the example's tests and build, and `@dawn-ai/ag-ui` tests). No changeset — `@dawn-example/research-web` is private. In the PR body, state plainly whether the flagship look was reachable through SP1's ladder.
