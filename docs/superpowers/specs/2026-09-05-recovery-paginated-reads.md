# Recovery paginated conditional reads

Status: bounded continuation of the release-efficiency work. No production
admission or writes. This extends the earlier conditional-read contract only for
strict total-count collections; array-only and cursor inventories remain
unconditional. The raw service evidence is retained locally under
`artifacts/release-recovery/service-20260905/pagination-conditional-read-observations/`.

## Problem and choice

The HTTP fixture omits fence reads. Sixty observed fixture fence callbacks,
combined with the production release workflow's 514-run history, model 720
additional unconditional page reads, for at least 1,586 primary-consuming
requests in that modeled execution. This is not a live quota measurement.

Prefer fresh conditional requests for each validated page. Increasing privileges
or adding long waits for quota resets changes the operational cost without
removing repeated transfers. Reusing an earlier fence decision would weaken
freshness. Both alternatives are outside this change.

A read-only service experiment fetched all six 100-item pages (514 unique runs)
and then received authenticated 304 responses for every page URL. The responses
omitted Link and changed each weak ETag to a strong ETag with the same opaque
value. Equivalent weak/strong comparison is already implemented. The production
Link-following reader still needs its own live read-only validation.

## Page eligibility

Only `readPaginated` calls with `strictTotal: true`, numeric pagination and the
existing 100-item page size opt into page retention. A retained body must have an
integer `total_count` within existing record limits and the extracted collection
must have exactly the expected number of items for its page index and total.
Nonstandard partial-page fixtures continue through the existing unconditional
path. Array-only and cursor collections do not opt in.

Pagination metadata must pass the existing origin/repository/path/query and
relation validation. A next link must exist exactly when the total requires
another page, and must target the consecutive page. Any supplied first/prev/last
relations must match page 1, the preceding page, and the last page derived from
the total. The header is bounded. A valid last page may have no next link.

This predicate governs retention, not admission: every response still passes
all existing schema, ID, total, duplicate, consecutive-page, complete-count,
byte, time and topology checks. Unsupported retention falls back to a fresh
unconditional read on the next invocation; it does not broaden accepted inventory
shapes or hide an incomplete response.

## Transport and provenance

Extend the internal conditional reader with a separate trusted page-retention
predicate. Ordinary object reads keep their existing policy. Include the page
mode in the credential/URL/header-specific cache key so an ordinary reader
cannot consume page metadata accidentally. Re-check the active caller's
predicate after every 304.

Store the body text, body byte cost, validator and validated pagination link
separately. Count bounded pagination metadata in retention capacity. Keep the
existing 128-entry, 16 MiB total, 2 MiB body and 20-minute lifetime limits.
Eviction, disposal, concurrent generations and error invalidation remain intact.

Reuse requires a fresh authenticated request for that exact page, matching
opaque ETag, zero response body, no redirect and a still-valid page predicate.
A returned 304 Link, if present, must exactly match the retained validated link;
a conflict rejects instead of choosing one. An absent Link may use the retained
pagination metadata only because the revalidated body includes the total and
page size required to validate its next/last boundaries.

Never rewrite `response.headers.link` to claim it was observed on a 304. Return
the revalidated page metadata in a distinct internal field. `readJson` derives
its internal pagination navigation from that field while preserving actual
HTTP status, code and headers. A 200 uses its own metadata; no previous link can
fill a missing or invalid link on a changed response.

## Fence invariants

Request every page on both full inventory passes. Keep workflow state brackets,
complete topology/default-branch brackets, all-SHA run coverage and the original
30-second observation deadline. No persistent or cross-job cache, skipped page,
stale fallback, prior authorization reuse or reduced history coverage is allowed.
Conditional requests still occur and can incur secondary limits. Actual workflow
budget, token limits and reset windows remain separate live evidence obligations.

## Verification and integration

1. Add failing regressions for valid two-page fresh 200/304 reads, actual missing
   Link on 304, weak/strong validators, unchanged raw headers and metadata
   provenance. Require four network requests for two full two-page passes.
2. Reject mixed totals, missing/unsafe required links, duplicate IDs, malformed
   bodies, unsolicited 304s, missing/mismatched 304 validators, redirects, stale
   generations and expired original deadlines. Otherwise-valid 200 responses
   without ETags remain admissible but unretained. Valid changed 200 responses
   use their own pagination metadata; conflicting 304 metadata fails. Nonstandard
   page sizes receive no new admission exemption or prohibition. Preserve
   unconditional array/cursor/legacy tests. Include empty, single-page, exact-100,
   101-item, reduced byte-budget and numeric `/repositories/<id>` Link cases.
3. Add cold/warm and eviction coverage. Revalidate all pages after a changed
   representation; do not combine different totals or accept partial results.
4. Extend the complete HTTP rehearsal to call the actual fence observer with
   multi-page fixture history. Retain the explicit fixture trust roots; do not
   impersonate a production contract or change the admitted policy directories.
   Measure cold and separately initialized phase readers as well as warm reads.
5. Re-exercise the production adapter's Link-following path read-only on GitHub,
   preserving the actual 200/304 observations and the complete inventory.
6. Refresh closure/script pins and contract docs, run focused checks, the full
   controller/fault suites and applicable local/CI gates, and obtain independent
   review. No policy admission follows from passing implementation tests.

Independent spec review confirmed the design and service body hashes after the
200/304 eligibility distinction above was clarified. No production admission
follows from that review.
