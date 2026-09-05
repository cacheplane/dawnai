# Fresh conditional GitHub reads for recovery

This refines the approved efficiency work after the full HTTP rehearsal exposed
an operational quota failure. It does not change release admission or authorize
production recovery. The recovery policy remains dormant.

At controller `358420ae`, the 100-item-page fixture issues 3,059 GitHub API calls
across adoption, evidence, audit, publication, published replay and next-version
selection. Evidence collection alone issues 1,348. GitHub documents a 1,000-call
hourly GITHUB_TOKEN quota per repository outside Enterprise. Authenticated 304
responses do not consume that primary quota. Read-only production probes of a
release, asset list and workflow list confirmed 200 then 304 with unchanged
rate-limit usage. Secondary limits still apply.

Sources: [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
and [conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests).

## Decision

Use bounded process-local JSON representations only after a fresh authenticated
conditional GET confirms the exact ETag. A higher-privilege credential would add
operational authority and still leave repeated transport work. Removing repeated
eligibility checks would change the integrity model. Conditional revalidation
preserves those checks and the existing writer transport identity.

The cache belongs to one recovery runtime/credential, is never persisted, and
never crosses to the independent auditor. It holds raw serialized JSON and
validators, not schema verdicts, admission decisions, or mutation success.
Every successful read repeats normal schema, identity, provenance and policy
validation. No stale-on-error response is permitted. Existing legacy readers
remain stateless by default.

Only object reads and single-page object collections qualify. Collections must
have an exact nonnegative total_count equal to the extracted array length and no
Link header. Array-only inventories and multi-page collections stay unconditional.
A 304 must have a matching opaque ETag (weak/strong forms compare by their quoted
value), an empty body, and no pagination/redirect header. Missing, malformed or
changed validators fail closed; they never authorize reuse. A changed 200 response
replaces the representation only when it still qualifies. Failed reads invalidate
that URL. No internal retries or request coalescing are added.

The transport retains actual HTTP 304 and explicit NOT_MODIFIED provenance in its
result. This must not be reported as an HTTP 200. The opt-in recovery reader may
return PRESENT/304/NOT_MODIFIED after successful revalidation. Legacy envelope
normalization is not widened. Binary downloads and write APIs are unchanged.

Bound retention to 128 entries, 16 MiB total, 2 MiB per representation, and the
20-minute recovery runtime lifetime. Keys include URL, all request headers,
credential and API version; hash keys to avoid retaining extra credential copies.
Return fresh parsed objects so callers cannot poison retained data. Enforce the
current request's byte limit against reused bytes. Abort, timeout, closure and
late overlapping responses cannot restore closed/invalidated entries. Explicit
runtime disposal clears retention on success and failure; auditor/read-only
runtime instances have separate state.

## Evidence and acceptance

A body-based projection with a fresh cache per phase predicts 866 primary calls
across the complete fixture arc, including replay and next-version selection;
evidence collection falls to 150. This is a projection, not an observed service
quota result. The fixture supplies admission/fence callbacks and cannot prove the
complete production budget. Run the actual adapter rehearsal with real 304
transport responses, retain per-origin/per-phase/304 counts, and require no change
to the 32 effects, fault convergence, original assets or no-op behavior. Real
workflow quota observations remain an activation prerequisite, including all
historical fence pages and the five smoke jobs under the shared repository quota.

## Implemented verification checkpoint

The adapter-backed rehearsal matches the projection: 2,193 actual HTTP 304
responses and 866 other GitHub API responses, with evidence collection at 150.
All 32 writes converge to COMPLETE with unchanged original assets, no repeated
publication, a zero-write replay and next-version selection. The cache resets
between phases and fault retries, and the auditor uses its own reader.
`/tmp/dawn-conditional-rehearsal-cost.json` retains counts. Upload-host traffic,
synthetic authority callbacks and live workflow bootstrap are not included in
those API counts; these numbers are not production budget certification.

Read-only probes using the new production adapter returned PRESENT/304/
NOT_MODIFIED for the real release, completed CI job inventory and repository
workflow inventory. Each 200/304 pair retained the same quota usage and remaining
count. Evidence: `/tmp/dawn-conditional-live.json`. This uses the operator's
read credential; the eventual workflow-token rehearsal is still required.

The separate Administration(read) immutable-policy reader remains unconditional.
It does not account for the repeated reads addressed here and has a distinct
credential. Raw adapter and GitHub reader tests cover both enabled behavior and
the legacy default. Full validation and interruption-matrix reruns are pending.
