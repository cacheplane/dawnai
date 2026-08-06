---
"@dawn-ai/memory": patch
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
"@dawn-ai/testing": patch
---

Memory distillation: `dawn memory consolidate` and `dawn memory reflect`.

Two explicitly-invoked passes that compact accumulated memories. Neither runs
automatically — nothing is wired into the runtime, a request, or the lazy
retention pass.

**`dawn memory consolidate`** groups active episodic records older than
`consolidate.olderThanMs` (default 7 days) per (namespace, ISO week), spends one
model call per batch, and writes a summary record (kind `episodic`, tagged
`consolidated`, `data = { period, sourceCount, derivedFrom }`, `effectiveAt` at
the window's end, no expiry by default). The summary is written FIRST and its
sources superseded only afterwards, so a crash leaves a redundant summary rather
than orphaned sources with nothing summarizing them. Each superseded source is
additionally stamped with `consolidate.sourceTtlMs` (default 7 days) so the
normal prune reaps it later — a superseded row is invisible to `recall` but still
occupies a slot in the per-namespace episodic cap. Summaries are never
re-consolidated (`data.derivedFrom` excludes them from every pass).

**`dawn memory reflect`** derives durable insights per namespace from records
newer than that namespace's watermark (the highest `data.coveredUntil` on its
existing reflections), between `reflect.minNewRecords` (10) and
`reflect.maxRecords` (100). Insights are written as **candidates by default**
(`reflect.writes: "candidate" | "auto"`) — a model's generalization about your
users gets a human read before `recall` can surface it. Approve them with
`dawn memory approve` or the Inspector, exactly like any other candidate write.

**Cron-safe.** Both commands share the flags
`[--dry-run] [--namespace <prefix>] [--model <id>] [--provider <id>] [--max-batches <n>]`
and are threshold-aware no-ops: below the thresholds they print one line, exit
`0`, and never construct a model — so they never read an API key. `--dry-run`
reports the full plan while making zero model calls, and `--max-batches`
(default 5) bounds the spend of any single invocation. That makes
`0 3 * * * cd /srv/app && npx dawn memory consolidate && npx dawn memory reflect`
free on an idle app and safe on an app with no credentials configured.

Configured under `memory.distill` in `dawn.config.ts` (`model` defaults to
`gpt-5-mini`; `provider` is inferred from the model id, falling back to
`openai`).

**Distilled records are written to be findable.** Recall is keyword match, and a
model asked to generalize writes an abstraction that names none of its sources
("earlier-week deployment windows are lower risk" for a batch about *griffin*) —
which no realistic question retrieves, and for consolidation the sources that did
carry the name are already superseded. Both distillation prompts now require the
concrete entities (service and project names, ticket/error identifiers,
filenames, people) to be carried through verbatim. Measured live, this is the
difference between an insight that ranks first for "griffin deploys" and one that
does not appear at all.

**`recall` no longer invites guessed time windows.** The `since`/`until` schema
descriptions now steer the model to relative offsets (`"-7d"`, resolved against
the request clock) and state that it does not know today's date. A model asked
"what did I work on last week?" would otherwise supply an absolute window from
around its training cutoff — observed live: a 2026 store queried with
`since: "2023-10-02"` — which matches nothing, silently, because an empty result
is indistinguishable from an empty store.

**`kind: "reflection"` is now accepted** by `defineMemory` and the generated
`remember` tool, where it previously threw. Reflections are append-only, like
episodic writes — a later insight never supersedes an earlier one. This is
**additive, not breaking**: no existing app changes behavior and no action is
required. `procedural` remains typed-but-unwired and still throws.
