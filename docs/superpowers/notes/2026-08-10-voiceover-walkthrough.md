# VoiceOver walkthrough — Inspector browse, D1 lifecycle states

> **STATUS: NOT RUN.** The nine stops below have no verbatim column because no screen
> reader was driven over them. An agent cannot hear speech, and enabling VoiceOver is a
> system accessibility setting it must not change. This file is the *prepared protocol*
> plus a DOM pre-check that corrects two stops of the original script; it is **not**
> evidence that the pass happened. Do not cite it as the design's "one real screen-reader
> pass" until the verbatim column is filled in by a human.

## Environment

| Field | Value |
| --- | --- |
| macOS | 26.5 (build 25F71) |
| Safari | 26.5 |
| Commit under test | `0d4a23331c439aaf56731f01c4a8657c5fbd21c3` |
| Worktree | `/Users/blove/repos/dawn/.worktrees/inspector-verification` |
| Fixture | `BROWSE_SEED_COUNT = 1250`, `BROWSE_PAGE_SIZE = 200`, `BROWSE_RESIDENT_CAP = 1000` |
| Protocol prepared | 2026-08-11 |
| Pass performed | — |

## Boot (verified)

```
cd /Users/blove/repos/dawn/.worktrees/inspector-verification
pnpm turbo run build --filter=@dawn-ai/inspector...
INSPECTOR_E2E_PORT=3919 node packages/inspector/e2e/serve.ts
```

Both steps ran clean on the commit above; `/healthz` answered `{"status":"ready"}` within a
second and `/api/memory/stats` reported `total: 1250`. Open `http://127.0.0.1:3919/memory`
in Safari.

Keep the Safari window **frontmost** for the whole pass. `usePolling` skips every tick while
`document.visibilityState === "hidden"`, which is deliberate — but it means a backgrounded
window leaves the facet rail showing `all —` with no namespaces, and stop 5's silence would
be vacuous rather than earned.

## The nine stops

| Stop | What VoiceOver said (verbatim) | Verdict | Follow-up |
| --- | --- | --- | --- |
| 1. Enter the grid (`VO+Shift+Down`) | | NOT RUN | script corrected — see C1 |
| 2. `VO+Right` across a row, then `VO+Down` | | NOT RUN | script corrected — see C2 |
| 3. Tab to the status funnel, open it, check `active` | | NOT RUN | |
| 4. Utterance while the filter is in flight (throttle the network) | | NOT RUN | |
| 5. Ten seconds on the settled grid with `live` on | | NOT RUN | |
| 6. Load-more control: its label, then activate it | | NOT RUN | |
| 7. Tab past the load-more control | | NOT RUN | |
| 8. Stop the server, wait for the poll to fail | | NOT RUN | |
| 9. Restart, find and activate retry by keyboard | | NOT RUN | |

A stop that fails gets an issue reference here, not a softened verdict.

## Script corrections

Two stops of the original script contradict the shipped, test-pinned behavior. A human
following them as written would record two failures against correct code.

### C1 — stop 1 expects "1251 rows"; the landing view publishes 204

The unscoped landing view is **grouped** (`list-page.tsx`:
`groupByNamespace={namespace === undefined}`), and design §4.5 downgrades `aria-rowcount`
to the loaded model whenever grouping is on. Measured on the running fixture:
`aria-rowcount="204"` — 200 records + 3 namespace group headers + 1 header row. The
population 1,250 is spoken by the **status bar**, not by the grid.

`1251` corresponds to no reachable state: it would require an unscoped grid that was also
ungrouped, and unscoped implies grouped here.

Corrected expectation for stop 1: the grid's label ("Memories"), a row count of the loaded
model (204 on a pristine fixture), and the first cell's position. The 1,250 arrives
separately, from the polite status region: `200 loaded of 1,250 matching.`

### C2 — stop 2 forbids the very thing §4.5 requires

The script says positions must read "row 3 of 1251" and "never row 3 of 200". On the
landing view the correct utterance *is* out of the loaded model — "row 3 of 204" — because
of the same grouping downgrade. As written the stop would flag conformant behavior.

Corrected expectation: on the landing view, positions out of the loaded model. To exercise
the global-position claim the stop is actually reaching for, first scope to a namespace
facet (`route=/notes`, 667 records) — ungrouped, so `aria-rowcount` becomes 668 and
positions are global. `a11y-counts.spec.ts` pins both halves; both were green on this
commit in this worktree:

```
  ✓  1 e2e/a11y-counts.spec.ts:194:3 › ARIA counts and positions › an exact total publishes the POPULATION, and positions are global (3.7s)
  ✓  2 e2e/a11y-counts.spec.ts:234:3 › ARIA counts and positions › GROUPING downgrades the rowcount to the loaded model (409ms)
  7 passed (14.8s)
```

## DOM pre-check — what the stops should produce

Read off the running fixture (landing view) or off source. This is what the attributes
promise; whether they *become a usable sentence* is exactly what the VoiceOver pass decides,
and this table cannot answer it.

| Stop | Source of the utterance | Value |
| --- | --- | --- |
| 1 | grid `aria-label` / `aria-rowcount` / `aria-colcount` | `Memories` / `204` / `7` |
| 1 | first three rows | row 1 header; row 2 group `▾ route=/chat (53 loaded)` at `aria-level="1"`; row 3 first record at `aria-level="2"` |
| 3 | funnel buttons | `Filter status`, `Filter content`, `Filter kind`, `Filter confidence`, `Filter updated` |
| 3, 6 | polite region (`role="status"`, `aria-atomic="true"`) | `200 loaded of 1,250 matching.` |
| 4 | `memory-grid.tsx` `staleAnnouncement` | `Updating results…` |
| 5 | — | no periodic writer to the live region; silence is the assertion |
| 6 | load-more label | `Load more — 200 of 1,250 loaded` |
| 6 | append announcement | `Loaded 200 more. 400 loaded of 1,250 matching.` |
| 6 | at the end of the set | `End of the N loaded memories, of 1,250 matching.` |
| 8, 9 | error banner (`role="alert"`) and its control | banner text, then a `Retry` button *outside* the atomic region |
| all | grid `aria-busy` | absent in every phase |

`aria-busy`'s absence and the four `aria-rowcount` downgrade branches are covered by
`a11y-counts.spec.ts`; the single-channel announcement rules by `a11y-announcements.spec.ts`;
focus continuity by `a11y-focus.spec.ts`. VoiceOver is the only thing that can decide
whether those attributes read as English, which is why this file exists and why it is
still empty.

## What remains

Stop 2 of the plan's Task 14 — the pass itself — with the corrected stops 1 and 2. One
human, one Safari window, `Cmd+F5`, nine stops, verbatim into the table above.
