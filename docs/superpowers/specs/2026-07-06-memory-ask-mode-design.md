# Memory `ask` mode — supersede-gated writes (Design)

**Status:** Approved (design phase) — 2026-07-06
**Roadmap:** Phase 4 (Richer Authoring Systems) — closes the long-term-memory design's deferred "permissions-gated auto writes" item (2026-06-18 spec §Write governance), re-scoped after per-tool approval gating (#291) shipped.
**Supersedes:** the 2026-06-18 spec's `auto`-mode HITL line and issue #260's original framing.

## Problem

The long-term-memory design specced HITL gating for agent memory writes, deferred in the v1 implementation (#250). Since then, #291 shipped generic per-tool approval: `tools: { approve: ["remember"] }` gates every `remember` call. That satisfies "a human can gate memory writes" — but at the wrong granularity for memory:

- The generic gate fires **per call**, before `run`, seeing only args. It cannot distinguish a benign ADD (new fact) from a SUPERSEDE (the agent overwriting a prior belief) — that classification is a function of **args × store state**, computed inside `remember`'s reconciliation.
- The resulting UX has two stable states: **noisy** (every ADD prompts — memory-active agents produce a stream of them) or, after fatigue drives the user to "Always", **blind** (supersedes never prompt again). Oversight erodes exactly where it matters most.
- This is **not** subsumable by #291's slice 3 (argument-level constraints): no pattern over args can express "prompt only if this contradicts an existing active record", because the answer depends on the store.

The sensitive event for memory is not "the agent called `remember`" — it is **"the agent is contradicting what it previously knew."** Gating that event requires a gate inside `remember`'s run, at the supersede branch.

## Decisions (from brainstorming)

1. **New `writes: "ask"` mode** — `memory.writes` widens to `"off" | "candidate" | "auto" | "ask"`. Default stays `"candidate"`; `auto` is unchanged (trust-all, no migration). `ask` = `auto`'s exact write semantics with one difference: the SUPERSEDE branch gates first.
2. **SUPERSEDE-only prompting.** ADDs land active silently; idempotent UPDATEs refresh silently; only contradictions prompt. Sustainable oversight — prompts are rare enough that nobody is driven to mute them.
3. **"Always" = per-route.** The persisted rule is the namespace's `workspace|route` prefix: "stop asking about overwrites in this route."
4. **Headless: allow through.** With no interactive human (non-interactive mode, CI, evals, deployed prod), `ask` behaves exactly as `auto` — the supersede proceeds. `ask` is a **supervision affordance, not a security boundary** (the #261 "honest scope" framing). This deliberately diverges from `gateToolOp`'s fail-closed ladder and is documented as such. Explicit persisted/config `deny` rules are still honored headless — the allow-through applies only to the `unknown` case. (`bypass` mode skips all gating including deny, consistent with every existing gate.)
5. **Deny = block only.** Old record stays `active`; nothing is written (no candidate queue — avoids the undrained-queue graveyard and the pre-existing `approve`-doesn't-supersede gap); the tool returns a model-legible result so the agent can adapt.
6. **Coexists with #291; warn on overlap.** `writes: "ask"` + `tools: { approve: ["remember"] }` on the same route draws a build-time warning (double prompt). Third instance of the established "capability-internal gate coexists with the generic gate" pattern (bash/path gates are the first two).

## Verified constraints (2026-07-06, via code inspection)

- **Namespace prefix is stable.** Serialization order is hardcoded `["workspace", "route", "tenant", "user", "agent"]` (`packages/memory/src/namespace.ts:8`), so `workspace=X|route=Y` always leads the string.
- **Prefix collision requires a terminator.** Values are not escaped, so `route=/a` would prefix-match `route=/ab`. Fix: the gate matches the candidate as `namespace + "|"` and suggests patterns ending in `"|"` — plain `startsWith` becomes collision-safe with **zero changes to `matchPermission`**.
- **Permissions store already reaches the memory marker.** `CapabilityMarkerContext.permissions` is populated for all routes (`execute-route.ts:518-546` — loaded outside the agent-only branch); the memory marker currently ignores it (`built-in/memory.ts:27-29`). No new wiring.
- **`remember` only exists on interrupt-capable routes.** The memory context is built inside the agent-only branch (`execute-route.ts:571+`), and `interruptCapable === (kind === "agent")` (`execute-route.ts:545`). The gate still checks `permissions.mode` before interrupting.
- **The testing harness needs no changes.** Interrupt collection is kind-agnostic (`packages/testing/src/run-result.ts:215-227`); `harness.resume({ decision })` flows `Command({resume})` through `streamResolvedRoute` (`harness.ts:182-186`).

## Design

### 1. Authoring surface

```ts
// dawn.config.ts
export default {
  memory: {
    writes: "ask", // "off" | "candidate" | "auto" | "ask"   (default "candidate")
  },
}
```

Touches: `DawnConfig.memory` type, `resolve-memory.ts` (`resolveMemoryWrites`), `MemoryContext.writes` union (`packages/core/src/capabilities/types.ts:39`), and typegen's writes-mode handling (`ask` generates `remember`, same as `auto`/`candidate`).

### 2. Write semantics in `ask` mode

Identical to `auto` — same reconciliation, same statuses — except the supersede branch:

| Outcome | `auto` | `ask` (interactive) | `ask` (headless) |
|---|---|---|---|
| ADD (no matching identity) | active, silent | active, silent | active, silent |
| UPDATE (same identity + data) | refresh, silent | refresh, silent | refresh, silent |
| SUPERSEDE (same identity, different value) | supersede, silent | **gate → prompt** | supersede, silent (≡ auto) |

In `packages/core/src/capabilities/built-in/memory.ts`: the `status` derivation treats `ask` like `auto` (active path), and the supersede branch calls the gate before `store.put` + `store.supersede`.

### 3. The gate (`packages/core/src/capabilities/permission-gate.ts`)

New `gateMemorySupersede(permissions, detail, opts?)` — sibling of `gateBashOp`/`gateToolOp`. Decision ladder:

1. No store, or `mode === "bypass"` → allow.
2. `match("memory", namespace + "|")` → explicit `allow` → proceed silently; explicit `deny` → block. Deny rules apply in every mode.
3. `unknown` + (`mode === "non-interactive"` or not interrupt-capable) → **allow** (ask ≡ auto headless — the documented divergence from `gateToolOp`; see Decision 4).
4. `unknown` + interactive → `interrupt()` with the `kind: "memory"` payload. **Once** → proceed; **Always** → `addAllow("memory", "<workspace=X|route=Y|>")` then proceed; **Deny** → block.

A blocked supersede keeps the old record `active`, writes nothing, and returns as the tool result:
`Kept existing memory <oldId> ("<oldContent>"); your contradicting value was not stored (approval denied).`

### 4. Interrupt payload — `kind: "memory"` (`packages/permissions/src/types.ts`)

`PermissionRequest.kind` widens to `"command" | "path" | "tool" | "memory"`:

```ts
export interface MemoryDetail {
  readonly namespace: string
  readonly identity: string        // rendered identity key, e.g. "acme / payment-terms"
  readonly oldId: string
  readonly oldContent: string      // what would be overwritten
  readonly newContent: string      // the replacement
  readonly suggestedPattern: string // "workspace=X|route=Y|" (terminator included)
}
```

This is the decision-quality prompt the generic `argsPreview` cannot provide — the human adjudicates a belief change (old vs new), not an opaque tool call.

### 5. Persistence (`.dawn/permissions.json`)

Reserved `"memory"` key in the existing `PermissionsFile` maps; native prefix matching (no `pattern-matching.ts` changes — the terminator lives in the gate's candidate construction). Config-seeded pre-approval falls out free:

```jsonc
// .dawn/permissions.json (written by "Always")
{ "version": 1, "allow": { "memory": ["workspace=app|route=/support|"] }, "deny": {} }
```

```ts
// dawn.config.ts (pre-seeded)
export default { permissions: { allow: { memory: ["workspace=app|route=/support|"] } } }
```

Docs recommend the trailing `"|"` on hand-authored patterns (collision safety); patterns without it still work as plain prefixes.

### 6. Validation (`packages/cli/src/lib/runtime/collect-tool-scope-errors.ts`)

Extend `collectToolScopeIssues`: when the app's memory `writes` mode is `"ask"` and a route's descriptor lists `"remember"` in `tools.approve` → **warning** (double prompt: per-call generic gate + supersede-level memory gate), analogous to the internally-gated workspace-tool warning (~line 103).

### 7. Client rendering (`examples/chat/web/app/page.tsx`)

`PendingInterrupt.kind` union gains `"memory"`; a render branch shows the belief change:

```text
Overwrite memory (route /support)?
  acme / payment-terms
  was:  net-30
  now:  net-45
[Once] [Always for this route] [Deny]
```

### 8. Exports

`MemoryDetail` from `packages/permissions/src/index.ts`; `gateMemorySupersede` from `@dawn-ai/core`'s barrel.

## Error handling / edge cases

- **Denied supersede** → old stays active, nothing written, denial returned as tool result (return-not-throw, matching #291's convention so the model sees and adapts).
- **Multiple supersedes in one turn** → each interrupts independently (existing LangGraph behavior, unchanged).
- **`ask` with no permissions store in context** → allow (ladder step 1; legacy/degraded context behaves as `auto`).
- **Determinism:** headless (evals, aimock replay, CI) `ask` never interrupts and behaves exactly as `auto`, so recorded fixtures and eval runs stay deterministic with no special-casing. Interactive interrupts use the existing `interruptId` scheme (`Date.now()`-based, same as bash/path/tool kinds — replay-safe under the harness because headless runs never reach it).
- **Renamed/moved routes:** an "Always" rule keys on the namespace prefix; renaming a route invalidates the rule naturally (re-prompts once).

## Testing

- **Unit (`@dawn-ai/core`, permission-gate):** ladder — bypass / explicit-allow / explicit-deny (honored headless) / unknown×non-interactive → **allow** / unknown×interactive → interrupt; Once/Always/Deny handling; Always persists the terminated route prefix.
- **Unit (`@dawn-ai/core`, memory capability):** in `ask` mode — ADD never gates; idempotent UPDATE never gates; SUPERSEDE gates; deny keeps old record active and returns the kept-memory message; `ask` ≡ `auto` when store absent.
- **Unit (`@dawn-ai/permissions`):** `"memory"` key prefix semantics incl. the `route=/a` vs `route=/ab` collision case (terminated candidate does not match).
- **aimock e2e (`@dawn-ai/testing`, mirroring `tool-approval.e2e.test.ts`):** probe route with seeded memory + `writes: "ask"`:
  1. contradicting `remember` → `kind: "memory"` interrupt with `oldContent`/`newContent` → `resume("once")` → supersede lands.
  2. `resume("deny")` → old value still active; tool result carries the kept-memory message.
  3. `resume("always")` → `.dawn/permissions.json` gains `allow.memory: ["…|route=…|"]`; a fresh contradicting run does not prompt.
  4. ADD-only run → zero interrupts.
- **Validation unit (`@dawn-ai/cli`):** ask+approve("remember") overlap warns.

## Documentation & website

- **`apps/web/content/docs/memory.mdx`** — replace the stale "auto writes are not gated by permissions" callout (now false: `approve: ["remember"]` exists); write-governance table gains the `ask` row; document supersede-only semantics, headless ≡ auto, and when to pick `ask` vs `candidate` vs `approve: ["remember"]` (per-call, blunter).
- **`apps/web/content/docs/permissions.mdx`** — "Memory write approval" section: prompt flow, the `memory` key, trailing-`|` pattern guidance, honest-scope note (supervision, not security).
- **`apps/web/content/docs/configuration.mdx`** — `writes: "ask"` in the memory block.
- **2026-06-18 long-term-memory spec** — annotate the `auto`-HITL line: superseded by this design.
- **Issue #260** — retitle/re-scope to track this implementation.
- **Changeset** — patch (fixed group, pre-1.0; keep patch, not minor).

## Out of scope (deferred, explicit)

- Finer "Always" granularity (per-subject, per-identity-key) — revisit if per-route proves too coarse.
- Queue-denied-supersedes-as-candidates — rejected for v1 (graveyard risk; depends on fixing `dawn memory approve` to honor supersession, itself a separate pre-existing gap worth its own issue).
- Gating `candidate`-mode writes (already human-reviewed by definition) or recalls (reads).
- Generalizing outcome-sensitive gating beyond memory (no second consumer yet).

## Risks

- **Double-prompt** if authors combine `ask` with `approve: ["remember"]` — mitigated by the build-time warning.
- **Headless allow-through surprises a user expecting fail-closed** — mitigated by docs (honest-scope framing) and by explicit `deny` rules being honored everywhere.
- **Interrupt-payload consumers** must render `kind: "memory"` — chat example updated in-repo; external clients degrade to their unknown-kind fallback.
