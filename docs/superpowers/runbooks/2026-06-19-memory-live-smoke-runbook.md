# Runbook: Long-Term Memory Live Smoke (manual, real model)

> **Date:** 2026-06-19 · **Branch:** `test/memory-live-smoke`
>
> A copy-pasteable operator checklist for manually verifying Dawn's long-term
> memory (`memory.ts`, semantic kind) against a **real** OpenAI model, using a
> freshly scaffolded research app that already dogfoods long-term memory.

## Before you start

**Faster repeatable check first.** There is an automated, gated live-smoke
suite that covers remember/recall/supersession/isolation/candidate-approval
against a real model in seconds:

```bash
cd /Users/blove/repos/dawn
set -a; . /Users/blove/repos/dawn/.env; set +a   # loads OPENAI_API_KEY locally
pnpm --filter @dawn-ai/testing exec vitest run test/memory-live.smoke.test.ts
```

That suite (`packages/testing/test/memory-live.smoke.test.ts`) skips with no
`OPENAI_API_KEY` and never runs in CI. Run it first as the quick regression
gate. **This runbook is for the richer, behavioral verification** — eyeballing
the composed prompt, exercising the CLI governance flow by hand, and confirming
cross-thread persistence through the real Agent Protocol server.

### Why scaffold `--mode internal`

Long-term memory is **merged but UNPUBLISHED**. A real
`npm create dawn-ai-app@latest` would pull the *published* template, which does
**not** include `@dawn-ai/memory` or the memory tools. You **must** scaffold in
`--mode internal`, which rewrites the generated app's dependencies to `file:`
links pointing at the local monorepo packages — that is what makes the
unpublished `@dawn-ai/memory` resolve.

### Secret handling — read this

- `OPENAI_API_KEY` lives in `/Users/blove/repos/dawn/.env` and is authorized for
  **LOCAL smokes ONLY**.
- **Never `echo`/`print` the key.** Do not `cat .env`, do not `echo $OPENAI_API_KEY`.
- **Never commit it** (it is already gitignored — keep it that way).
- **Never run this in CI** or paste it into any shared/remote runner.

### What the research template gives you

The research template already ships:

- `memory.ts` — `defineMemory({ kind: "semantic", scope: ["workspace", "route"] })`
- `memory.md` — route-local profile text injected as `# Route Memory`
- `workspace/AGENTS.md` — workspace-wide memory injected as `# Memory`
- `dawn.config.ts` with `memory: { writes: "candidate" }` (the default), so the
  agent's `remember` tool produces **candidates** that need human approval before
  `recall` can see them.
- `permissions` left **interactive** and a low offload threshold. The
  external-fetch bash step is **NOT** allow-listed, so prompting the agent to
  fetch a URL triggers a **HITL permission interrupt** (`interrupt` SSE event /
  `interrupt` in the `runs/wait` result). This is expected — do not treat it as a
  failure. For the memory smoke you do not need to approve a fetch; keep prompts
  focused on remember/recall so you stay out of that path.

---

## 1. Scaffold

Build the local packages first so the `file:` links resolve to fresh `dist/`:

```bash
cd /Users/blove/repos/dawn && pnpm -r build
```

Scaffold a research app in internal mode (this is what makes the unpublished
`@dawn-ai/memory` resolve via `file:` links):

```bash
node packages/create-dawn-app/dist/bin.js /tmp/mem-smoke --mode internal --template research
```

Install, build, and sanity-check the generated app:

```bash
cd /tmp/mem-smoke && pnpm install && pnpm build
npx dawn check
```

`dawn check` should pass. If `pnpm build` fails to resolve `@dawn-ai/memory`,
you forgot the `--mode internal` flag or skipped the `pnpm -r build` above.

---

## 2. Load the key (local only)

Load the key into the current shell **without printing it**:

```bash
set -a; . /Users/blove/repos/dawn/.env; set +a
```

> **Do NOT `echo $OPENAI_API_KEY`** and do NOT `cat` the `.env` file. The key
> never belongs in your terminal scrollback, a screenshot, or a commit.

Start the dev server (Agent Protocol on `:2024`):

```bash
npx dawn dev --port 2024
```

Leave this running in its own terminal. Run the `curl` and `dawn memory` steps
below in a **second** terminal where you have also loaded the key (the CLI and
server both read `.dawn/memory.sqlite` under `/tmp/mem-smoke`).

---

## 3. Remember (thread A)

Create the first thread:

```bash
curl -sS -X POST http://localhost:2024/threads \
  -H 'content-type: application/json' \
  -d '{}'
```

Note the returned `thread_id` (call it `$TA`). Then ask the agent to remember a
durable fact. The `route` **must** be `/research#agent` — passing the route id
alone returns `400`.

```bash
curl -sS -X POST http://localhost:2024/threads/$TA/runs/wait \
  -H 'content-type: application/json' \
  -d '{
    "route": "/research#agent",
    "input": {
      "messages": [
        { "role": "user",
          "content": "Remember this durable fact for future research sessions: the user prefers primary sources, and treats reuters.com as a vetted source for market data." }
      ]
    }
  }'
```

Expect the agent to call the `remember` tool. Because the research template's
`writes` defaults to `candidate`, this write lands as a **CANDIDATE** — it is
**not** yet visible to `recall`. (If you watched the stream variant
`runs/stream` instead, you would see `tool_call` → `tool_result` → `done`
SSE events; a `remember` call appears as the `tool_call`.)

---

## 4. Inspect + approve via CLI

List candidates (the new one should appear with status `candidate`):

```bash
npx dawn memory list
```

Grab the candidate's `<id>` from that output, inspect it, then approve it:

```bash
npx dawn memory inspect <id>
npx dawn memory approve <id>
```

Confirm it is now active:

```bash
npx dawn memory list
```

The record should now show status `active`. Only now is it eligible for
`recall`.

---

## 5. Recall (thread B — a NEW thread)

Create a **second**, independent thread to prove cross-thread persistence:

```bash
curl -sS -X POST http://localhost:2024/threads \
  -H 'content-type: application/json' \
  -d '{}'
```

Note the new `thread_id` (call it `$TB`). Ask the agent to recall the fact:

```bash
curl -sS -X POST http://localhost:2024/threads/$TB/runs/wait \
  -H 'content-type: application/json' \
  -d '{
    "route": "/research#agent",
    "input": {
      "messages": [
        { "role": "user",
          "content": "Using your long-term memory, which source does the user treat as vetted for market data, and what is their source preference?" }
      ]
    }
  }'
```

The answer must reflect the **approved** memory (reuters.com as vetted; prefers
primary sources). Because `$TB` is a fresh thread with no shared conversation
state, a correct answer proves the fact persisted in the store and was recalled
across threads — not carried in the chat history.

---

## 6. Eyeball the prompt + scoping

**Confirm the composed system prompt carries all three layers together.** On a
turn for `/research#agent`, the system prompt should contain, in order:

1. the route `systemPrompt`,
2. `# Memory` (the workspace `workspace/AGENTS.md` block),
3. `# Route Memory` (the route's `memory.md` block),
4. `# Long-Term Memory` (the injected index of recent in-scope memories).

To see it, use the dev-server logs first (run `npx dawn dev --port 2024` in a
terminal where you can read its output). If the prompt is not logged at a
useful verbosity, add a **temporary throwaway** debug line in the langchain
prompt-composition path — e.g. `console.error(systemPrompt)` where the composed
system message is built — rebuild, re-run a turn, then **revert it** before you
finish. Do not commit the debug line.

**Inspect namespaces / scoping.** The semantic store namespaces records by
`["workspace", "route"]`, so the research route's memories live under a
`route=/research` namespace and would not leak into a different route. Inspect
what is stored:

```bash
npx dawn memory list
```

For raw confirmation you can open the SQLite file directly (read-only is fine):

```bash
# from /tmp/mem-smoke
sqlite3 .dawn/memory.sqlite '.tables'
sqlite3 .dawn/memory.sqlite 'select id, namespace, status from memories;'
```

You should see the namespace pinned to the research route.

**Exercise reject/forget on a fresh candidate.** Drive one more `remember` (a
new, throwaway fact) via step 3's `curl`, then:

```bash
npx dawn memory list           # find the fresh candidate <id2>
npx dawn memory reject <id2>   # candidate is rejected, never surfaced to recall
# (alternatively, on any record:)
npx dawn memory forget <id2>   # remove it from the store
```

Confirm with `npx dawn memory list` that the rejected/forgotten record is gone
from the recall-eligible set.

**(Optional) Supersession.** Remember a *contradicting* value for the same
identity (same `subject`/`predicate`, different `value`), approve it, then
`npx dawn memory list` — Dawn should **supersede** the old record (preserving
history) rather than deleting it, and recall should return the new value.

---

## 7. Pass / fail checklist

Fill in **Pass** (✓/✗) and **Notes** as you go:

| Aspect | What you verified | Pass | Notes |
| --- | --- | --- | --- |
| `memory.md` heeded | Route behavior reflects `# Route Memory` profile text (citations / primary-source preference) | | |
| `remember` tool called | Step 3 run invoked the `remember` tool | | |
| Recall cross-thread | Step 5 fresh thread `$TB` answered from the store, not chat history | | |
| Candidate → approve → recall | Candidate was invisible to recall until `dawn memory approve`, then recallable | | |
| Supersession | Contradicting fact superseded the old record (history preserved) | | |
| Namespace isolation | Records pinned to `route=/research`; no cross-route leakage | | |
| Memory index present | `# Long-Term Memory` index appears in the composed system prompt | | |
| `AGENTS.md` coexists | `# Memory` (workspace) and `# Route Memory` both present alongside the index | | |

---

## Cleanup

Stop the dev server (`Ctrl-C`), then:

```bash
rm -rf /tmp/mem-smoke
unset OPENAI_API_KEY   # drop the key from the shell when done
```
