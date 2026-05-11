# README demo gif — `dawn` create-to-run loop

**Date:** 2026-05-11
**Status:** Design approved, pending spec review
**Related:** [`2026-05-11-readme-rewrite-design.md`](./2026-05-11-readme-rewrite-design.md) (the gif's home is the README rewrite landed in [apps#97](https://github.com/cacheplane/dawnai/pull/97)).

## Problem

The current root [README.md](../../../README.md) leads with text. The README rewrite spec explicitly flagged "hero gif of `dawn dev` (or equivalent) — add above the side-by-side block" as a follow-up. Per Richard Kim's [README guide](https://blog.cwrichardkim.com/how-to-get-hundreds-of-stars-on-your-github-project-345b065e20a2): the hero asset is the single highest-impact element for a browsing visitor; "show, don't tell." A README without a visual relies on the reader getting through the first paragraph.

## Goals

1. Add a short (~15–25 second) demo gif at the top of the README, above the "Without Dawn / With Dawn" block.
2. The demo viscerally communicates "kill the boilerplate" — show a real `dawn` invocation produce a real-looking LLM response with ~8 lines of authored code.
3. The recording is **reproducible**: anyone with the repo + `vhs` installed can rebuild the exact same gif from a checked-in script. No flaky live typing, no live LLM variation in the captured output.
4. No production changes to Dawn packages. Recording infrastructure lives entirely under `docs/brand/`.

## Non-goals

- Not adding a `dawn dev` recording in this PR (separate follow-up if we want it).
- Not adding a model-replay hook to Dawn itself. We achieve determinism via `OPENAI_BASE_URL` redirection — `ChatOpenAI` honors that out of the box.
- Not embedding multiple visuals. One gif, one slot.

## Demo content

A ~20-second VHS script showing the create-to-run loop:

1. **Scaffold** — `pnpm create dawn-ai-app my-app && cd my-app && pnpm install` (the install line can be condensed/silenced in the recording; the install itself isn't the point).
2. **Peek at the route** — `cat src/app/(public)/hello/[tenant]/index.ts`. Viewer sees the ~8-line `agent({ model, systemPrompt })`. This is the marketing money shot.
3. **Run it** — `echo '{"tenant":"acme"}' | pnpm exec dawn run "src/app/(public)/hello/[tenant]"`. A real-shaped LLM response streams back.

Total target: ~20 seconds. Typing speed comfortable, brief pauses, no dead time waiting on `pnpm install`.

## Determinism mechanism

`ChatOpenAI` (the LangChain client Dawn uses — see [packages/langchain/src/agent-adapter.ts:54](../../../packages/langchain/src/agent-adapter.ts)) reads `OPENAI_BASE_URL` from env. We point it at a local stub server that returns a fixture.

**Workflow for capturing the fixture (one-time):**

1. Author the scaffolded route as it'll appear in the demo.
2. Run `dawn run` once with a real `OPENAI_API_KEY` against `api.openai.com`. Capture the full OpenAI chat-completion response as JSON.
3. Save to `docs/brand/quickstart-fixture.json`.

**Workflow for rebuilding the gif (any time):**

1. Start the stub server: `node docs/brand/stub-openai.mjs --fixture docs/brand/quickstart-fixture.json --port 4317`. It serves a single endpoint (`POST /v1/chat/completions`) that returns the fixture verbatim. Server logs go to stderr; stdout is silent (so it doesn't appear in the VHS recording).
2. `vhs docs/brand/quickstart.tape` runs the script with `OPENAI_BASE_URL=http://127.0.0.1:4317` and a placeholder `OPENAI_API_KEY` set inside the tape's `Env` blocks. Output: `docs/brand/quickstart.gif`.
3. Commit the regenerated gif if it changed.

The stub is intentionally minimal: ~30 lines of Node, no dependencies. It supports streaming responses if the fixture's `delta` chunks dictate, otherwise returns the full message.

## Deliverables

- `docs/brand/quickstart.tape` — VHS script. Committed.
- `docs/brand/stub-openai.mjs` — minimal local stub. Committed.
- `docs/brand/quickstart-fixture.json` — captured real LLM response. Committed.
- `docs/brand/quickstart.gif` — VHS output. Committed.
- `README.md` — embed the gif above the "Without Dawn / With Dawn" section.
- `CONTRIBUTORS.md` — one-line note: "Rebuild the demo gif with `vhs docs/brand/quickstart.tape` (requires `brew install vhs`); start the stub first."

## File layout

```
docs/brand/
  dawn-logo-horizontal-black-on-white.png   (existing)
  dawn-logo-horizontal-white-on-black.png   (existing)
  dawn-social-avatar-white-on-black-1024.png (existing)
  quickstart.tape                            (new)
  stub-openai.mjs                            (new)
  quickstart-fixture.json                    (new)
  quickstart.gif                             (new)
  README.md                                  (new — brief: what each file is, how to rebuild)
```

## VHS tape sketch

(Final values tuned during implementation. Sketch only.)

```tape
Output docs/brand/quickstart.gif

Set Theme "Catppuccin Mocha"
Set FontSize 16
Set Width 1200
Set Height 720
Set TypingSpeed 60ms

Env OPENAI_BASE_URL "http://127.0.0.1:4317"
Env OPENAI_API_KEY  "sk-demo"

Type "pnpm create dawn-ai-app my-app"
Enter
Sleep 4s

Type "cd my-app && pnpm install"
Enter
Sleep 6s

Type "cat src/app/\(public\)/hello/\[tenant\]/index.ts"
Enter
Sleep 3s

Type `echo '{"tenant":"acme"}' | pnpm exec dawn run "src/app/(public)/hello/[tenant]"`
Enter
Sleep 4s
```

## README integration

In [README.md](../../../README.md), the new section order becomes:

1. Logo
2. Badges
3. Tagline
4. **Demo gif** (new)
5. Why Dawn?
6. Without Dawn / With Dawn
7. Quickstart
8. 30-Second Route
9. Learn more
10. Footer

The gif goes immediately under the tagline so a browser sees it in the first scroll. Markdown embed: `<p align="center"><img src="docs/brand/quickstart.gif" alt="Dawn quickstart — scaffold a route and invoke it in under a minute" width="900" /></p>`.

## Risks and mitigations

- **Risk:** Captured fixture drifts from current `dawn` CLI behavior (output format changes).
  **Mitigation:** Anyone with the stub can rebuild the gif from the tape. If output format changes meaningfully, regenerate the fixture (one real LLM call) and re-render. The .tape file is the source of truth, not the gif.

- **Risk:** Gif file size bloats the repo.
  **Mitigation:** Target ≤ 1.5MB. VHS supports `Set Framerate` and `Set PlaybackSpeed`; tune to keep size down. If still too large, consider `.webm` instead of `.gif` (GitHub-renders fine in markdown via `<video>` tags, though embedding ergonomics are slightly worse). Decide based on final render.

- **Risk:** `pnpm install` step takes 10+ seconds even on a warm cache, making the recording feel slow.
  **Mitigation:** Use VHS `Hide` / `Show` directives to trim the install output, or use a workspace cache and a `pnpm install --offline` invocation. Final tuning is implementation work.

- **Risk:** The stub doesn't accurately replay streaming behavior, making the response appear instantly instead of streaming.
  **Mitigation:** Acceptable for v1 — the gif is short enough that instant response reads as "fast" rather than "fake." If we later add a `dawn dev` recording that needs streaming, upgrade the stub to honor SSE.

- **Risk:** Recording requires `vhs` which isn't a default dev tool.
  **Mitigation:** One-line CONTRIBUTORS.md note. Only needed when re-rendering the gif, not for day-to-day work.

## Out of scope (follow-ups)

1. `dawn dev` + request-from-another-pane recording. Separate gif, separate slot in docs site (not the README).
2. A concept graphic (`src/app/` → `dawn build` → LangSmith). Nice-to-have.
3. Editor/file-tree visual showing colocated `tools/` `state.ts` `middleware.ts`. Belongs on the docs site, not the README.

## Implementation plan summary (sketch — full plan to follow)

1. Author `docs/brand/stub-openai.mjs` (Node, no deps, ~30 lines).
2. Capture `docs/brand/quickstart-fixture.json` with a real OpenAI call against the scaffolded route.
3. Author `docs/brand/quickstart.tape`.
4. `brew install vhs` locally; render the gif; iterate until size and pacing are right.
5. Edit `README.md` to embed the gif under the tagline.
6. Add the rebuild note to `CONTRIBUTORS.md`.
7. Add a brief `docs/brand/README.md` explaining the rebuild flow.
8. Verify with `node scripts/check-docs.mjs`, `pnpm lint`, `pnpm build`.
9. PR and merge.
