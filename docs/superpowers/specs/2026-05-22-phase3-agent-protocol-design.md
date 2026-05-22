# Phase 3 — Sub-project 7: Agent Protocol HTTP endpoints + Dawn-native SQLite checkpointer

**Status:** Design approved, ready for implementation plan
**Date:** 2026-05-22
**Phase:** 3 (Opinionated Agent Harness)
**Depends on:** Sub-projects 1–4.5 (planning, agents-md, skills, capability state mutation, subagents, workspace, permissions)

## Goal

Replace Dawn's ad-hoc `POST /runs/stream` surface with a minimal-viable subset of LangGraph's Agent Protocol (AP), backed by a Dawn-native SQLite checkpointer and a SQLite thread-metadata store. Conversation state survives process restart; thread lifecycle is explicit; the HTTP shape is interoperable with AP clients.

## Why now

- Sub-project 4.5 wired interrupt/resume via process-local `MemorySaver`. Resume works but state vanishes on restart — unacceptable for the upcoming subagents-as-async-tasks work (sub-project 7's downstream).
- Async subagents (deferred from sub-project 3) require a thread-keyed HTTP surface and durable checkpoints to dispatch and poll.
- AP-compatible HTTP makes Dawn routes consumable from langgraph-sdk clients and the LangGraph Studio UI without a custom adapter.

## Non-goals

- Assistants resource (`POST /assistants`, etc.) — Dawn routes are the assistants; no registry needed.
- Cron / scheduled runs.
- Multi-tenant auth on the HTTP surface.
- Postgres checkpointer (pluggable interface makes this a follow-on).
- Streaming protocols other than SSE.
- Migration tooling for existing in-memory threads.
- Wrapping `@langchain/langgraph-checkpoint-sqlite`. Dawn ships its own.

## Architecture

Three layers:

1. **HTTP surface** (`packages/cli/src/lib/dev/runtime-server.ts`): native `node:http` server exposes AP-shaped routes. Replaces existing `/runs/stream` block.
2. **Storage** (`packages/sqlite-storage/`): new package providing `sqliteCheckpointer` (a `BaseCheckpointSaver` subclass) and `createThreadsStore` (thread CRUD). Driver is `node:sqlite` (Node 22+ built-in, no native deps).
3. **Wiring** (`packages/cli/src/lib/runtime/execute-route.ts`, `packages/langchain/src/agent-adapter.ts`): default checkpointer + threads store instantiated from `dawn.config.ts`; both pluggable.

## Endpoint surface

All routes namespaced under the Dawn dev server root.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/threads` | Create thread. Body: `{metadata?}`. Returns `{thread_id, created_at, metadata, status}`. |
| `GET` | `/threads/{thread_id}` | Fetch thread metadata. 404 if unknown. |
| `DELETE` | `/threads/{thread_id}` | Delete thread + its checkpoints. |
| `POST` | `/threads/{thread_id}/runs/stream` | Start a run; stream SSE events (existing `/runs/stream` semantics, now thread-keyed). Body: `{input, route, config?}`. |
| `POST` | `/threads/{thread_id}/runs/wait` | Start a run; block until done; return final state. Body same as stream. |
| `GET` | `/threads/{thread_id}/state` | Return latest checkpoint as `{values, next, config, metadata, created_at, parent_config}`. |
| `POST` | `/threads/{thread_id}/resume` | Resume an interrupted run. Body: `{interruptId, decision}`. Replaces sub-project 4.5's `/api/permission-resume` proxy target. |

SSE event shape on `/runs/stream` is unchanged from current Dawn (preserves `event: interrupt` + capability-emitted envelopes).

## Request/response shapes

**Create thread**
```http
POST /threads
Content-Type: application/json

{"metadata": {"user": "brian"}}
```
```json
{
  "thread_id": "t-7f3c2a1b",
  "created_at": "2026-05-22T14:03:11.412Z",
  "updated_at": "2026-05-22T14:03:11.412Z",
  "metadata": {"user": "brian"},
  "status": "idle"
}
```

**Stream run**
```http
POST /threads/t-7f3c2a1b/runs/stream
Content-Type: application/json

{"input": {"messages": [{"role": "user", "content": "hi"}]}, "route": "chat"}
```
Returns `text/event-stream` (unchanged shape).

**State**
```json
{
  "values": { "messages": [...] },
  "next": [],
  "config": {"configurable": {"thread_id": "t-7f3c2a1b", "checkpoint_id": "1ef..."}},
  "metadata": {"source": "loop", "step": 4},
  "created_at": "2026-05-22T14:03:14.901Z",
  "parent_config": {"configurable": {"checkpoint_id": "1ee..."}}
}
```

**Resume** (sub-project 4.5 contract preserved, moved under thread path):
```json
{"interruptId": "perm-9a2", "decision": "once"}
```

Error responses are `{"error": "<message>", "code": "<machine_code>"}` with appropriate HTTP status.

## File structure

**New package: `@dawn-ai/sqlite-storage`**

```
packages/sqlite-storage/
  package.json          # peer dep: @langchain/langgraph-checkpoint (for BaseCheckpointSaver)
  src/
    index.ts            # re-exports sqliteCheckpointer + createThreadsStore + types
    checkpointer/
      index.ts          # sqliteCheckpointer({path}) factory
      saver.ts          # DawnSqliteSaver extends BaseCheckpointSaver
      schema.ts         # CREATE TABLE statements
      serde.ts          # checkpoint <-> Uint8Array via existing langgraph serde
    threads/
      index.ts          # createThreadsStore({path}) factory
      store.ts          # CRUD impl
      schema.ts
    internal/
      db.ts             # shared DatabaseSync open + pragmas (WAL, foreign_keys=ON)
      migrate.ts        # shared schema_version runner
```

**Checkpointer schema** (`checkpoints.sqlite`):
```sql
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB NOT NULL,
  metadata BLOB NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_thread ON checkpoints(thread_id, checkpoint_ns);

CREATE TABLE IF NOT EXISTS writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
```

Mirrors LangGraph's canonical shape so `DawnSqliteSaver` is a thin adapter over the four `BaseCheckpointSaver` methods (`getTuple`, `list`, `put`, `putWrites`).

**Threads schema** (`threads.sqlite`):
```sql
CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'idle'
);
CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
```

**Updates to existing packages**

- `packages/core/src/types.ts` — add to `DawnConfig`:
  ```ts
  readonly checkpointer?: BaseCheckpointSaver
  readonly threadsStore?: ThreadsStore
  ```
- `packages/cli/src/lib/dev/runtime-server.ts` — remove the current single `POST /runs/stream` block; add AP routes above. Permissions resume endpoint relocates to `/threads/:thread_id/resume`.
- `packages/cli/src/lib/runtime/execute-route.ts` — instantiate defaults when config omits them:
  ```ts
  const checkpointer = config.checkpointer
    ?? sqliteCheckpointer({ path: join(appRoot, ".dawn/checkpoints.sqlite") })
  const threadsStore = config.threadsStore
    ?? createThreadsStore({ path: join(appRoot, ".dawn/threads.sqlite") })
  ```
- `packages/langchain/src/agent-adapter.ts` — accept `checkpointer` from caller instead of constructing `MemorySaver` internally.
- `examples/chat/web/app/api/permission-resume/route.ts` — proxy target updated to `/threads/{thread_id}/resume`.

**On-disk layout**

```
<appRoot>/.dawn/
  checkpoints.sqlite    # LangGraph checkpoint hot path
  threads.sqlite        # thread metadata
  permissions.json      # unchanged from sub-project 4.5
```

`.dawn/` is auto-gitignored (permissions capability already does this; the check is idempotent).

## Testing strategy

- **Unit (`packages/sqlite-storage/`):** vitest against `:memory:` DB.
  - `BaseCheckpointSaver` contract: put → getTuple round-trip, list pagination + ordering, putWrites idempotence, parent-chain traversal.
  - Threads-store CRUD.
  - Migration: open v0 schema, run migrator, assert v1.
- **Integration (`test/runtime/run-agent-protocol.test.ts`):** packs `@dawn-ai/sqlite-storage` + cli + langchain. Exercises full HTTP shape: create thread → stream run → assert SSE → GET state → restart server → fetch state again → assert messages persist.
- **Smoke (`test/smoke/`):** extend existing smoke to issue two `runs/stream` calls against the same `thread_id` and confirm conversation memory survives via AP, not in-process state.
- **Resume regression:** packed test that uses the new `/threads/{id}/resume` endpoint URL to validate the sub-project 4.5 contract still works under the new path.

## Verification harness packing

Add `@dawn-ai/sqlite-storage` to every test that packs Dawn packages:
- `test/generated/run-generated-app.test.ts`
- `test/generated/harness.ts`
- `test/generated/cli-testing-export.test.ts`
- `test/runtime/run-runtime-contract.test.ts`
- `test/smoke/run-smoke.test.ts`
- `packages/create-dawn-app/src/index.ts` (internal-mode replacement + override entry)

## Open questions

None at design close. All decisions resolved:
- Driver: `node:sqlite` direct (no shim).
- Package boundary: one combined `@dawn-ai/sqlite-storage`.
- Storage: one SQLite per concern (checkpoints + threads); permissions stays JSON.
- Backward compat: full migration; no preservation of legacy `POST /runs/stream`.

## References

- LangGraph Agent Protocol: https://langchain-ai.github.io/langgraph/cloud/reference/api/api_ref.html
- `BaseCheckpointSaver`: `@langchain/langgraph-checkpoint`
- Node SQLite: https://nodejs.org/api/sqlite.html
- Sub-project 4.5 design: `docs/superpowers/specs/2026-05-21-phase3-permissions-design.md`
