# D1 budget ledger — measured vs proposed

Both references below live in the **pretable** repo, not in dawn — `docs/superpowers/specs/`
here holds ~90 unrelated specs and neither path resolves from this checkout. Read them at
`/Users/blove/repos/pretable/.claude/worktrees/hopeful-cray-45f99a`:

- Design: `docs/superpowers/specs/2026-08-09-server-controlled-exploration-design.md` §11
- Plan: `docs/superpowers/plans/2026-08-10-dawn-inspector-verification.md`, Tasks 18, 21, 22

Every "§11" in this file is a reference into that design, whose own MEASURED block
(§11, immediately under the budget table) is the other half of this record — see the
frame-quantisation entry below, which reconciles the two.

This file replaces the plan's "Budget status" table. Every row that entered slice 5 as
*proposed* or *estimated* now carries either the number a run printed or an explicit
statement that no run has produced one. A cell that says "estimate" is not a soft pass —
it means nothing has been measured and the budget is still a proposal.

## Where the numbers came from

| Lane | Command | Run |
| --- | --- | --- |
| Server (SQLite) | `pnpm --filter @dawn-ai/memory bench:budgets -- --assert` | 2026-08-12, Apple M1 Max / macOS 26.5 / Node 24.18.0. 100 000 rows, 20 samples, nearest-rank p95 (the 19th observation, never interpolated). Load average 4.66 at the start of *measurement* — the bench prints `loadavg()` after `seed()` inserts the 100 000 rows, so that figure includes this process's own seeding and is not ambient machine load. |
| Server (Postgres) | — | **Never run.** See the Postgres record below. |
| Client (pretable) | `PRETABLE_BENCH_SCRIPT=replace pnpm bench:e2e apps/bench/tests/bench.spec.ts`, same for `append`, then `pnpm bench:budgets` | 2026-08-12, same machine, Chromium 151.0.7922.34, `pretable/default/S1/dev`, viewport 1440×900, seed 101, 2 000-row scenario. |
| Client heap | `pnpm bench:memory` | Same machine and run identity. |

Both client commands live in the pretable worktree
(`/Users/blove/repos/pretable/.claude/worktrees/hopeful-cray-45f99a`), not in dawn.

## The ledger

| Budget | Ceiling (§11) | Measured | Verdict |
| --- | --- | --- | --- |
| Server: windowed fetch, default order, keyset | p95 < 10 ms @100k SQLite | **1.61 ms** p95, whole `store.browse({ limit: 200 })` | **Met.** Supersedes the §5.5 per-statement 0.54 ms — this figure includes decode. |
| Server: filtered `COUNT(*)` | p95 < 25 ms @100k SQLite | **6.61 ms** p95, rows + COUNT in one `browse()` with a `status in` filter | **Met.** |
| Server: head refresh (rows+count, resident 1 000) | p95 < 50 ms @100k | **3.65 ms** p95 at `limit = 1000` | **Met — first measurement ever.** See the head-refresh record below. |
| Server: non-default sort window | p95 < 50 ms @100k | **12.32 ms** p95, `orderBy confidence desc` | **Met.** |
| Server: content contains | p95 < 150 ms @100k | **45.12 ms** p95, rare-term needle matching exactly one row | **Met.** |
| Server: any Postgres figure | < 30 ms windowed / < 100 ms filtered count | **No measurement.** | **Estimate only.** See the Postgres record below. |
| Client: replace (refresh, 200 rows) | < 20 ms grid work, no grid reconstruction | **7.90 ms** `interaction_latency_ms`, `grid_instance_reconstructed` 0, `scroll_position_drift_px` 0 | **Met**, with the frame-quantisation caveat below. |
| Client: append (200 onto 800, at the cap) | < 30 ms grid work, zero scroll movement | **9.90 ms** `interaction_latency_ms`, `scroll_position_drift_px` 0, `grid_instance_reconstructed` 0, resident 800 → 1 000 | **Met** at the worst case the design permits — §11 words the shape the same way. See the append record below. |
| Client memory at resident cap | ≤ 32 MB grid-attributable heap | **10.90 MB** page-attributable (11.37 MB at cap − 0.47 MB blank baseline) | **Met on a weaker instrument.** The number is the WHOLE bench page, not the grid alone; see the heap record below. |
| Poll tick, no changes | < 10 ms client CPU, zero announcements | **CPU: no measurement.** Announcements: 0, asserted by `packages/inspector/e2e/a11y-announcements.spec.ts` | **Half met.** The zero-announcement half is pinned by a test; the CPU half is still proposed and no task in this plan measures it. |
| End-to-end interaction | p95 < 300 ms local server | **No p95.** `01-beyond-window-filter.spec.ts` bounds one filter round trip at < 2 000 ms | **Unverified.** The e2e ceiling is a regression-of-kind guard (a client round-trip storm), deliberately loose, one sample. It is not the §11 p95 and must not be read as one. |

## No verdict here is defended by CI

**Every "Met" above is a one-shot measurement on one developer machine, not a regression
gate.** No workflow in either repo re-checks any of these numbers:

- dawn: `grep -rn bench .github/workflows/` returns nothing. `bench:budgets` exists as a
  package script and runs only when a human types it.
- pretable: `bench:budgets`, `bench:e2e` and `bench:memory` appear in no workflow. The root
  `test` script runs `check-bench-budgets.test.mjs`, which tests *the checker's own logic*
  against fixtures — it never reads a bench artifact and cannot fail on a slow grid.

So a change that doubles any of these costs merges green. "Met" means "was met once, on
2026-08-12, on an M1 Max" — read it as a dated observation, not a standing guarantee. Wiring
any of this into CI was not in scope for the task that produced this file; it is listed as
owed work below.

## Records

### head-refresh, measured for the first time

§11 grounds `head-refresh` by extrapolation — "~3–8 ms + decode" — and §5.5 has no row for
it. Nothing had ever been run at `limit = 1000`, which is the span that matters: the
resident cap is 1 000, and one head refresh covering the whole resident span is what makes
convergence arithmetic instead of a merge. The measured p95 is **3.65 ms**, inside the
extrapolated band and 13× under the 50 ms ceiling. The ceiling was set with decode margin
that the measurement shows is not needed at this row count; it is left alone rather than
tightened, because one machine's p95 is not grounds to move an approved number.

### Postgres stays an estimate

Task 18 was planned to add a gated container lane. **It did not.** What shipped is
`POSTGRES_BROWSE_BUDGETS_MS` in `packages/memory/src/browse-budget.ts` — two constants
(30 ms windowed, 100 ms filtered count) and a comment saying both are estimates. There is
no pgvector bench, gated or otherwise, and no container has been run. The three other
shapes are deliberately absent from that table so the checker reports them as *unbudgeted*
rather than inventing a ceiling.

So: **no Postgres number in this ledger is measured.** Anyone reading a Postgres figure as
a verified budget is reading an extrapolation from SQLite. Measuring it is owed work.

### The append shape is 200 onto 800, and §11 already says so

The measured shape is **200 onto 800**, arriving exactly at the 1 000 resident cap — the
largest append the design permits, and therefore the worst case that can actually occur.
The artifact records `resident rows: 800 to 1000 (scenario holds 2000)`.

§11 agrees. Its client-append row reads "200 onto 800 — the resident cap is 1 000, so
1 800 was never reachable", corrected in pretable `adcceccd` (#307). No follow-up is owed
here. An earlier draft of this ledger filed a §11 correction as outstanding work; that was
read off the *plan's* stale preamble table, which still carries the pre-`adcceccd` "200
onto 1 800" wording. The plan preamble is the stale copy — the design is not.

### Both client latencies sit at the one-frame floor — and §11 owns the instrument that resolves it

`interaction_latency_ms` is a difference between two `requestAnimationFrame` timestamps, so
it cannot resolve below one frame. The replace run reports 7.90 ms against a median frame
interval of 8.40 ms; the append run reports 9.90 ms against a 9.90 ms median. Both report
`frames to first change: 1`. Both are therefore **one frame** — the instrument's floor, not
a measurement of grid work that happens to be small. The correct reading is "the grid
finished inside the first frame after the update", which clears 20 ms and 30 ms
respectively. A regression would have to cost more than a frame before this number moves at
all, so treat these as *ceiling cleared*, not as a baseline to defend to the tenth of a
millisecond.

**This is a re-run, not a second opinion.** §11's MEASURED block records replace 8.6 / 8.3 ms
and append 8.9 / 8.3 ms from the 2026-08-11 run; the table above records 7.90 and 9.90 ms
from a 2026-08-12 re-run of the same two scripts at the same run identity. The numbers
differ by well under one frame interval, which is exactly what "the metric cannot resolve
below one frame" predicts — neither set is more correct, and a reader should not treat the
gap as drift. Where the two documents differ in *content*, §11 is the stronger record and
governs.

**§11's consequence, which this ledger must not be read without.** Because the metric
quantises to a frame, it **cannot discriminate replace from append** — which is the entire
point of D1-PERF-04 measuring them separately. The discrimination comes from the sliced
trace, which shows it plainly: `setRows` self-time is **78 µs for replace against 402 µs for
append** (1 000 rows vs 200). The standing rule §11 sets, restated here so this file cannot
be used to dodge it: *any future claim that replace and append have been compared must cite
the trace, not the latency metric.* A budget an instrument cannot resolve is a budget that
will be reported as met no matter what happens to the code.

Both runs also report `grid_instance_reconstructed: 0`, which is the clause the replace
budget actually rests on — §11 asks for "no grid reconstruction", and that is a 0/1 fact
rather than a timing.

### The heap figure measures the page, not the grid

§11 budgets **grid-attributable** heap. `apps/bench/tests/resident-cap-memory.spec.ts` (in
pretable, like the other client lanes) cannot isolate the
grid: its baseline is `about:blank`, so the 10.90 MB difference is the whole bench page —
app bundle, React, the generated 2 000-row scenario dataset, and the grid.

Over-counting is the safe direction (the grid is a subset of the page), so a page under
32 MB puts the grid under it too, and the verdict above is sound. What the instrument
**cannot** do is resolve resident row count: the same page holding all 2 000 scenario rows
measured 10.53 MB, i.e. **0.84 MB below** the 1 000-row cap state — a negative marginal
cost, which means the grid's per-row footprint is inside `Runtime.getHeapUsage` noise.

Consequence: at ~11 MB against a 32 MB ceiling, this assertion trips only on roughly a 3×
whole-page regression. Raising `BENCH_RESIDENT_CAP_ROWS` would not move it. It is a page
ceiling, not a per-row instrument, and it should not be cited as evidence about row cost.

### What is still owed

1. A Postgres/pgvector container bench. Until then both Postgres numbers are estimates.
2. A poll-tick CPU measurement. No task in this plan produces one.
3. A real §11 end-to-end p95. The e2e bound is a single sample at a deliberately loose
   ceiling, and `timeToFulfilled` measures the Playwright driver along with the page.
4. CI wiring for any of it — see "No verdict here is defended by CI" above. Every "Met"
   in the table is a one-shot local measurement that no workflow re-checks.
5. The recorded VoiceOver pass (plan Task 14). It needs a human with a screen reader and
   was deliberately not fabricated; `docs/superpowers/notes/2026-08-10-voiceover-walkthrough.md`
   holds the protocol, not results.
