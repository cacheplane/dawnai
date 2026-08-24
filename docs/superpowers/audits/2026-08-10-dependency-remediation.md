# Dependency Security Remediation Audit

**Status:** Draft. The compatible dependency remediation is committed, but the
Task 7 audit recapture, Task 8 reviewed-base evidence, final CI/gated results,
merge, and post-merge reconciliation are pending. Nothing in those pending
sections is a claim about merged `main`.

**Repository:** `cacheplane/dawnai`

**Dependency-fix commit:**
`b4b5bf088fbb982fdc9110524d651b8c07da6f23`
(`fix(deps): refresh compatible security resolutions`)

## Scope and decision summary

This change repairs the compatible dependency graph and adds regressions at
boundaries Dawn owns. It does not remove the Vercel CLI or the real native
deployment lane, does not dismiss or mute findings, and does not add fragile
major-forcing policies for CopilotKit, Hono, node-server, UUID,
provider-utils, AG-UI, or Vercel.

Breaking changes were acceptable for the private examples. They therefore move
directly to CopilotKit V2 imports and catch-all runtime handlers without a
compatibility shim. CopilotKit's stable `1.68.3` release is the direct owner in
both examples, and AG-UI's direct packages remain on `0.0.57`.

The dependency strategy is:

1. upgrade the real direct owners where appropriate;
2. let compatible declared ranges select patched transitive versions;
3. keep only a policy that is demonstrably necessary when an upstream owner
   pins a vulnerable exact version; and
4. test Dawn's integration boundaries instead of copying upstream internals.

## Evidence ledger

### Immutable historical receipt

The canonical historical receipt is
[`2026-08-10-dependency-remediation-baseline.json`](./2026-08-10-dependency-remediation-baseline.json).
It was committed by
`d2032eadf672e32432ce8cc32c2b95d3fd98d03c` and must not be rewritten to
represent a newer base.

| Field | Exact value |
|---|---|
| Schema/kind | `1` / `dependency-security-baseline` |
| Captured at | `2026-08-10T21:13:32Z` |
| Receipt source SHA | `550fe96223addc42982b62276f36a9c171255fa6` |
| Observed default SHA | `3887079d400bdf019d3ff90bc89599c1899fa422` |
| Canonical receipt SHA-256 | `c0c9da1136817a892adcd9f287c51fd577f942f426ba04fba4e3c201199b20d9` |
| Historical open alerts | 27 exact records |
| Publication inventory | 21 packages, current `0.8.21`, absent target `0.8.22` |
| npm reads | 63 bounded requests: version document, packument, and attestation for each package |

The implementation plan also preserves
`8398c908844cf961f1d64e575c8b9a0000923f41` as the earlier branch/base
precondition. That precondition is distinct from the receipt's source and
observed-default identities above; none is a current-base assertion.

The historical capture proved both publication workflows were
`disabled_manually`, all target package documents and attestations were absent,
and the exact target tag, Release, and artifact identities were absent. Later
read-only checks have continued to observe the two workflows disabled, but the
exact-reviewed-head containment rerun remains pending under Task 8.

### Historical incident classifications

Historical workflow activity is preserved rather than described as absent.

| Workflow/run | Head | Recorded result |
|---|---|---|
| Release `31356780088` | `3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb` | Cancelled; one job, 20 steps; publication and attestation steps skipped |
| Release `31356940801` | `b6adaa982b25adf5fac61733a13ac65320c70bcd` | Cancelled; zero jobs and zero steps |
| Release `31357014583` | `cfa55478cf8e35dc8a00ae7041c0c12479fda2d9` | Cancelled; one zero-step job |
| Publish Chart `31356780047` | `3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb` | Completed successfully; both chart jobs were bounded, verified no-ops |

The successful chart jobs are not mislabeled as skipped. Their normalized
no-op booleans and bounded-log digests are in the canonical receipt.

### Commit provenance

| Commit | Evidence or decision |
|---|---|
| `3bce3c86293a953a13ceaf59b46bdbf92807ee55` | Completed the fail-closed dependency evidence controller |
| `d2032eadf672e32432ce8cc32c2b95d3fd98d03c` | Committed the immutable August 10 baseline receipt |
| `45af1184d411ee2c2e22fbd1cb1982b6e6b96707` | Updated direct private-example CopilotKit owners to stable `1.68.3` |
| `b3c5b910d57df98808a4b5a4f5bb354ff88ec626` | Adopted V2 catch-all runtime handlers in both examples |
| `8bf90c5c1b145c94b8def763cbb6c6e78001a245` | Added model-free V2 transport verification |
| `8b7658503ec583aaf75b0f7a6fffcc1ee1370593` | Reconciled the current working alert identity fixture before the lock fix |
| `4de8f25114a9c0279da4d35fa73d745236625180` | Committed the Dawn-owned hostile-path tests and audited workflow gates against the pre-fix graph |
| `b4b5bf088fbb982fdc9110524d651b8c07da6f23` | Applied the compatible lock refresh and minimal final policy |

### Bounded pre-fix RED observations

The exact committed pre-fix source is
`4de8f25114a9c0279da4d35fa73d745236625180`. Before the dependency-fix commit,
the focused observations were bounded and specific:

| Surface | Pre-fix bounded result | Vulnerable identity exposed |
|---|---|---|
| Isolated Mermaid/jsdom workers | 6 failed, 4 passed | `mermaid@11.16.0` and its sanitizer path |
| Real Chromium example renderer | 3 failed, 2 passed | The same chat/research Streamdown-to-Mermaid path |
| Kubernetes SOCKS loopback smoke | 1 version receipt failed, 7 controls passed | `ip-address@10.2.0` |

The raw external RED output was intentionally kept outside the worktree. Its
durable path and digest are not presently available in checked-in evidence and
therefore remain **PENDING EVIDENCE IDENTIFICATION**. This draft does not invent
a receipt identity. The checked-in tests and exact pre-fix source commit remain
reproducible provenance for the asserted test boundaries.

## Pre-remediation Dependabot set

The immutable receipt contains the following complete 27-alert snapshot. Every
record was npm, transitive, in `pnpm-lock.yaml`, open, and undismissed; the table
retains the fields that distinguish the findings. Severity names in this table
use Dependabot's `medium` spelling.

| Alert | Package | Advisory | Severity | Scope |
|---|---|---|---|---|
| #122 | `@ai-sdk/provider-utils` | `GHSA-866g-f22w-33x8` | low | runtime |
| #123 | `@hono/node-server` | `GHSA-frvp-7c67-39w9` | medium | runtime |
| #124 | `dompurify` | `GHSA-c2j3-45gr-mqc4` | low | runtime |
| #125 | `fast-uri` | `GHSA-v2hh-gcrm-f6hx` | high | development |
| #160 | `js-yaml` | `GHSA-52cp-r559-cp3m` | high | development |
| #162 | `postcss` | `GHSA-6g55-p6wh-862q` | high | development |
| #163 | `postcss` | `GHSA-r28c-9q8g-f849` | high | development |
| #164 | `brace-expansion` | `GHSA-mh99-v99m-4gvg` | high | runtime |
| #170 | `ip-address` | `GHSA-22jq-vg5j-6vgg` | medium | runtime |
| #171 | `ip-address` | `GHSA-4xrf-jv44-h6hh` | medium | runtime |
| #172 | `hono` | `GHSA-8j4g-w8fx-2239` | medium | runtime |
| #176 | `brace-expansion` | `GHSA-3jxr-9vmj-r5cp` | high | runtime |
| #178 | `brace-expansion` | `GHSA-rgw5-rvv9-x895` | high | runtime |
| #179 | `postcss` | `GHSA-fxqj-rqcc-2cmp` | medium | development |
| #180 | `fast-uri` | `GHSA-7p8r-x3mc-p8w7` | high | development |
| #181 | `ip-address` | `GHSA-mwp4-54f8-5fhr` | high | runtime |
| #191 | `mermaid` | `GHSA-2v8p-3f2j-5mp7` | medium | runtime |
| #192 | `mermaid` | `GHSA-3rrr-jr9j-h3q3` | medium | runtime |
| #193 | `mermaid` | `GHSA-6x64-9x62-f2gx` | medium | runtime |
| #194 | `mermaid` | `GHSA-c4c3-pg64-4m4v` | low | runtime |
| #195 | `mermaid` | `GHSA-rhh3-jpg6-66xh` | medium | runtime |
| #196 | `js-yaml` | `GHSA-5p4m-2wfm-xmqj` | high | development |
| #197 | `js-yaml` | `GHSA-5p4m-2wfm-xmqj` | high | development |
| #198 | `dompurify` | `GHSA-55q2-fjhq-7xh7` | medium | runtime |
| #199 | `hono` | `GHSA-54fx-42gc-7vw4` | medium | runtime |
| #200 | `hono` | `GHSA-79qm-7rj5-m7r9` | low | runtime |
| #201 | `hono` | `GHSA-f23p-vx2j-j53r` | medium | runtime |

Alert `#123` belongs only to this historical snapshot. It is absent from the
current GitHub API and must not be restored or treated as a current open alert.

## Pre-remediation audit set

The exact fixture is
[`audit-baseline.json`](../../../test/security-dependencies/fixtures/audit-baseline.json),
SHA-256
`20be79fddd8407da02a768d05389606dc9d907ec2604988ebfc0d2ddcf3c8051`.
Both modes have explicit empty `muted` arrays.

- Full: 30 advisories — 13 high, 12 moderate, 5 low, 0 critical.
- Production: 27 advisories — 10 high, 12 moderate, 5 low, 0 critical.
- The three `brace-expansion` records were full-audit-only. Every other row
  below appeared in both modes.
- The two Nano ID advisories and the body-parser advisory were present in the
  audit before corresponding Dependabot alerts existed.

| Package | Version | Advisory | Reported severity | Modes |
|---|---|---|---|---|
| `@ai-sdk/provider-utils` | `3.0.28` | `GHSA-866g-f22w-33x8` | low | full + production |
| `@hono/node-server` | `1.19.14` | `GHSA-frvp-7c67-39w9` | moderate | full + production |
| `body-parser` | `1.20.5` | `GHSA-v422-hmwv-36x6` | low | full + production |
| `brace-expansion` | `2.1.1` | `GHSA-3jxr-9vmj-r5cp` | high | full only |
| `brace-expansion` | `2.1.1` | `GHSA-mh99-v99m-4gvg` | high | full only |
| `brace-expansion` | `2.1.1` | `GHSA-rgw5-rvv9-x895` | high | full only |
| `dompurify` | `3.4.11` | `GHSA-55q2-fjhq-7xh7` | moderate | full + production |
| `dompurify` | `3.4.11` | `GHSA-c2j3-45gr-mqc4` | low | full + production |
| `fast-uri` | `3.1.3` | `GHSA-7p8r-x3mc-p8w7` | high | full + production |
| `fast-uri` | `3.1.3` | `GHSA-v2hh-gcrm-f6hx` | high | full + production |
| `hono` | `4.12.28` | `GHSA-54fx-42gc-7vw4` | moderate | full + production |
| `hono` | `4.12.28` | `GHSA-79qm-7rj5-m7r9` | low | full + production |
| `hono` | `4.12.28` | `GHSA-8j4g-w8fx-2239` | moderate | full + production |
| `hono` | `4.12.28` | `GHSA-f23p-vx2j-j53r` | moderate | full + production |
| `ip-address` | `10.2.0` | `GHSA-22jq-vg5j-6vgg` | moderate | full + production |
| `ip-address` | `10.2.0` | `GHSA-4xrf-jv44-h6hh` | moderate | full + production |
| `ip-address` | `10.2.0` | `GHSA-mwp4-54f8-5fhr` | high | full + production |
| `js-yaml` | `3.15.0` | `GHSA-5p4m-2wfm-xmqj` | high | full + production |
| `js-yaml` | `4.2.0` | `GHSA-52cp-r559-cp3m` | high | full + production |
| `js-yaml` | `4.2.0` | `GHSA-5p4m-2wfm-xmqj` | high | full + production |
| `mermaid` | `11.16.0` | `GHSA-2v8p-3f2j-5mp7` | moderate | full + production |
| `mermaid` | `11.16.0` | `GHSA-3rrr-jr9j-h3q3` | moderate | full + production |
| `mermaid` | `11.16.0` | `GHSA-6x64-9x62-f2gx` | moderate | full + production |
| `mermaid` | `11.16.0` | `GHSA-c4c3-pg64-4m4v` | low | full + production |
| `mermaid` | `11.16.0` | `GHSA-rhh3-jpg6-66xh` | moderate | full + production |
| `nanoid` | `3.3.15` | `GHSA-28wg-ghj8-5hjv` | high | full + production |
| `nanoid` | `3.3.15` | `GHSA-2v37-7h3g-55p8` | high | full + production |
| `postcss` | `8.5.10` | `GHSA-6g55-p6wh-862q` | high | full + production |
| `postcss` | `8.5.10` | `GHSA-fxqj-rqcc-2cmp` | moderate | full + production |
| `postcss` | `8.5.10` | `GHSA-r28c-9q8g-f849` | high | full + production |

## Compatible remediation

### Selected graph and owned controls

The selected versions below are the lock state in dependency-fix commit
`b4b5bf088fbb982fdc9110524d651b8c07da6f23`. Floors are acceptance
invariants, not new exact-version policies.

| Package/path | Patched acceptance floor | Selected identity | Real graph root | Dawn-owned control |
|---|---|---|---|---|
| CopilotKit React/runtime | stable `1.68.3` owner | `1.68.3` | Private chat/research web examples; `packages/ag-ui` dev owner | V2 catch-all handler loopback, example transport tests, typecheck/build |
| Direct AG-UI | `0.0.57` | `0.0.57` | Examples and `@dawn-ai/ag-ui` | Fail-closed graph receipt and V2 encoded AG-UI forwarding |
| `hono` | `4.12.34` | `4.13.3` | CopilotKit runtime, MCP SDK, CLI | Graph receipt, CLI HTTP roundtrip, V2 loopback |
| `@hono/node-server` 1.x | `1.19.15` | `1.19.17` | CopilotKit runtime and MCP SDK | Real V2 server boundary and Windows encoded-backslash regression |
| `@hono/node-server` 2.x | `2.0.10` | `2.1.1` | CLI development owner | CLI HTTP roundtrip and graph receipt |
| `uuid` 11.x/14.x | `11.1.1` | `11.1.1`, `14.0.1` | AG-UI/CopilotKit; Mermaid and Vercel | Fail-closed graph receipt; no forced collapse across majors |
| `ip-address` 10.x | `10.3.1` | `10.5.0` | `@dawn-ai/sandbox` → Kubernetes client → SOCKS agent → SOCKS | Real bounded IPv4 and proxy-resolved hostname loopback smoke |
| `mermaid` | `11.16.1` | `11.16.1` | Example React Core → Streamdown | Fresh-realm worker cases and real Chromium renderer cases |
| `dompurify` | `3.4.13` | `3.4.13` | Mermaid under the same Streamdown chain | Exact resolution receipt plus strict HTML/SVG/CSS integration control |
| `postcss` | `8.5.23` | `8.5.23` | Next `16.3.0`, Tailwind `4.3.3`, Vite `6.4.3` | Manifest-policy invariant plus web/example/inspector builds |
| `nanoid` 3.x | `3.3.18` | `3.3.18` | PostCSS | Exact resolution/audit receipt plus owning builds |
| `fast-uri` 3.x | `3.1.5` | `3.1.5` | AJV through MCP/CopilotKit and the private Verdaccio harness | Exact resolution/audit receipt and downstream focused/full lanes |
| `brace-expansion` 2.x | `2.1.4` | `2.1.4` | Testcontainers/archiver; safe 1.x and 5.x siblings remain | Exact resolution/audit receipt and integration harnesses |
| `body-parser` 1.x | `1.20.6` | `1.20.6` | Express 4 through CopilotKit runtime and Verdaccio; safe 2.x remains | V2 runtime loopback and exact resolution/audit receipt |
| `js-yaml` 3.x | `3.15.1` | `3.15.1` | gray-matter and Changesets/read-yaml-file | Exact resolution/audit receipt, docs and release-tooling lanes |
| `js-yaml` 4.x | `4.3.1` | `4.3.1` | Changesets parser, Kubernetes client, Vercel Python analysis | Exact policy/resolution receipt plus sandbox, release, and native Vercel lanes |
| Unrelated safe `js-yaml` line | unaffected | `5.2.2` | Verdaccio config | Preserved as a separate compatible line |

The lock refresh also preserves `brace-expansion@1.1.18` and `5.0.9` and
`body-parser@2.3.0`; it does not force unrelated consumers onto one major.
No workspace package dependency range was changed for the lock-only fixes.

### CopilotKit V2 prerequisite

Both examples now use `@copilotkit/react-core/v2` and
`@copilotkit/runtime/v2`. Their required catch-all route creates one
`createCopilotRuntimeHandler`, registers Dawn through a real AG-UI `HttpAgent`,
uses `basePath: "/api/copilotkit"`, and shares the handler for `GET` and `POST`.
The model-free loopback test verifies the info route, malformed input rejection,
the exact encoded chat/research AG-UI targets, ordered SSE forwarding, and
cleanup.

This prerequisite removed the obsolete UUID override. It also made Hono
`4.13.3` and node-server `1.19.17`/`2.1.1` naturally selectable. No legacy
single-route response or compatibility adapter remains.

### Why there is no public-owner override

There is no CopilotKit, Hono, node-server, UUID, provider-utils, AG-UI, or
Vercel override. In particular:

- forcing every node-server consumer to `2.x` would cross a major and erase a
  valid patched `1.x` line;
- forcing provider-utils `3.x` to `4.x` would cross an upstream API boundary
  owned by CopilotKit's Google Vertex dependency;
- pinning CopilotKit or AG-UI transitives would hide whether their actual owner
  manifests can select a maintained graph; and
- a Vercel-wide transitive override set would be large, fragile, and likely to
  conflict with upstream CLI updates.

The graph tests reject these selector families and reject malformed,
dangling, orphaned, ambiguous, or cyclic lock evidence.

## Root dependency-policy register

The final root manifest has exactly seven policies. Six predate this
remediation and remain out of scope for unrelated owner migrations. The one
policy needed for this remediation is the scoped `js-yaml` 4.x policy.

| Selector | Selected policy | Why it exists | Removal trigger |
|---|---|---|---|
| `langsmith` | `0.7.10` | Existing protection for the prompt-pull advisory in an older transitive LangSmith graph | Every real owner naturally selects a reviewed patched line without the selector; then rerun audit, LangSmith build/runtime coverage, and the frozen install |
| `ws@>=8 <8.21.0` | `8.21.0` | Existing protection for the WebSocket memory-exhaustion DoS | All owner ranges exclude affected `ws` versions and a no-selector frozen graph plus network/runtime tests stays green |
| `esbuild@<0.25.0` | `0.25.10` | Existing protection for the development-server request-disclosure line | No owner resolves an affected `<0.25` line without the selector; builds and browser tooling pass on the natural graph |
| `esbuild@>=0.27.3 <0.28.1` | `0.28.1` | Existing protection for the Windows file-read line | Owners naturally select `>=0.28.1` or another unaffected line; Windows and cross-platform build controls pass |
| `js-yaml@>=4 <4.3.1` | `4.3.1` | `@vercel/python-analysis@0.13.1` pins vulnerable `4.1.1` exactly; even `0.14.0` still pins it | Vercel's owner pin admits `4.3.1+` or the exact vulnerable path disappears; remove the selector and require exact audit, native Vercel, sandbox, release-tooling, and frozen-lock verification |
| `qs@>=6.11.1 <=6.15.1` | `^6.15.2` | Existing `GHSA-q8mj-m7cp-5q26` protection for the Verdaccio/Cypress-request test-harness path | All transitive owners naturally select `6.15.2+`; rerun the local-registry and release harnesses without the selector |
| `vite@>=5 <6.4.3` | `6.4.3` | Existing protection for Vite path-traversal and NTLMv2 disclosure advisories | All owners naturally exclude `<6.4.3`; remove only after browser, Vite-plugin, test, and production builds pass |

The previous global `postcss: 8.5.10` policy was removed rather than replaced.
Next `16.3.0` declares exact PostCSS `8.5.23`, while Tailwind and Vite admit the
same safe line, so a permanent override would add fragility and had previously
forced Next down to a vulnerable version. The previous `uuid@<11.1.1` policy
was also removed because the direct-owner refresh naturally selects patched
11.x and 14.x lines.

## Why Vercel stays in the graph and CI

`vercel@58.9.0` is a required development dependency of `@dawn-ai/cli`. The
`vercel-native` CI job uses the real CLI and credentials for same-repository
pull requests and `main` to verify both source-built and prebuilt preview
deployments, project/API binding, persistence behavior, reconciliation, and
resource cleanup. A unit mock cannot establish those deployment facts.

Removing the CLI or lane would trade away the only real deployment signal for
this supported target. Therefore Vercel-owned findings are handled as a
separate full-development-audit boundary, never by deleting the lane. They are
not muted, dismissed, or evidence that the real-deploy test is optional. Task 7
must record their exact final package/version/advisory tuples; this draft does
not infer them from an earlier graph.

The existing `vercel-native` job and all of its executables are preserved by
the workflow allowlist tests. The security work adds only the audited Windows
regression, an isolated read-only Chromium lane, and a separate manual
post-merge receipt uploader.

## Intermediate verification already completed

These are focused implementation checks, not substitutes for the final Task 7
matrix or Task 8 Definition of Done.

| Check | Intermediate result |
|---|---|
| Security TypeScript project | Passed |
| Complete security Vitest project | 334 passed; one intentional non-Windows skip |
| Mermaid worker suite | 10 passed |
| Real Chromium security suite | 5 passed |
| Kubernetes SOCKS suite | 8 passed |
| Dependency-resolution + Windows-focused suite on non-Windows | 20 passed; one Windows-only skip |
| Workflow contract suite | 56 passed |
| Root lint at the focused checkpoint | Passed |

The worker suite runs each hostile Mermaid case in a fresh bounded worker after
installing a fresh jsdom realm. The browser suite renders the actual
`CopilotChatAssistantMessage.MarkdownRenderer` from
`@copilotkit/react-core/v2`. The SOCKS suite uses only controlled loopback
servers and proves the real Kubernetes client → SOCKS agent → SOCKS →
`ip-address` chain. Windows CI owns the encoded-backslash disclosure test that
cannot execute as a passing native assertion on non-Windows.

## Pending Task 7: final audit and upstream boundaries

**PENDING — do not treat this section as final disposition.** Task 7 must run
the reviewed audit reader under Node `24.19.0` against
[`audit-upstream-boundaries.json`](../../../test/security-dependencies/fixtures/audit-upstream-boundaries.json).
That fixture has separate `production` and `full` schemas and both `muted`
arrays must remain exactly empty.

### Conditional provider-utils record

The current candidate graph still contains
`@ai-sdk/provider-utils@3.0.28` / `GHSA-866g-f22w-33x8` on the private-example
path through `@copilotkit/runtime@1.68.3` and
`@ai-sdk/google-vertex@3.0.146`. The graph invariant requires every affected
3.x path to remain below that private CopilotKit Google Vertex owner. Task 7
must recapture the exact path, reported severity, and reachability before using
the `UPSTREAM_BLOCKED` disposition.

If it remains, the reviewed record is:

- owner: `@blove`;
- review expiry: `2026-09-10`;
- no force to provider-utils 4.x; and
- recheck on a patched compatible 3.x release, CopilotKit/Google Vertex
  migration, a newly reachable import, severity or reachability change, or any
  Dawn Vertex example/use.

If the advisory is absent from the final production audit, Task 7 must instead
record the resolved version/path and reason and omit the exception. The final
production mode contains this record only if it remains. The final full mode
adds only exact Vercel-owned records actually observed by the final audit.

### Exact final audit tuples

**PENDING TASK 7:** replace this paragraph with the accepted production/full
tuple sets, severity totals, exact command status, empty-muted proof, and the
provider-utils/Vercel outcome produced by the fail-closed reader. Candidate
fixture contents are not final evidence until the live audit and expected
multisets agree exactly.

## Pending Task 8: reviewed-base alert disposition

**PENDING — the default branch has moved during implementation, so a fresh
exact-base capture is mandatory.** The current working identity fixture has 59
candidate open alerts. It is useful for planning but is not the final reviewed
set.

- Candidate fixed after merge (26): `124, 125, 160, 162, 163, 164, 170, 171,
  172, 176, 178, 179, 180, 181, 191, 192, 193, 194, 195, 196, 197, 198, 199,
  200, 201, 236`.
- Candidate retained open (33): `122, 204, 205, 206, 207, 208, 209, 210, 211,
  212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226,
  227, 228, 229, 230, 231, 232, 233, 234, 235`.
- Historical-only `#123` is absent from the current API and is in neither
  candidate partition.

Task 8 must recapture every identity against the exact reviewed base, review
every addition/removal/change, update this partition, and confirm every fixed
record preserves its original identity, has no dismissal, and has a qualifying
post-merge `fixed_at`. It must also confirm the complete final open set has no
suppressions, dismissals, or auto-dismissals. No candidate count or list above
substitutes for that read.

## Pending Task 8: reviewed-base receipt and final verification

The planned current-base receipt path is
`docs/superpowers/audits/2026-08-20-dependency-remediation-reviewed-base.json`.
Its exact source SHA, default SHA, capture time, and SHA-256 are **PENDING TASK
8**. It must be generated by the evidence CLI after the final rebase and must be
refreshed after any later base movement. The immutable August 10 receipt remains
unchanged.

Also pending:

- the final `pnpm why`/`pnpm list` receipts;
- the accepted full and production audit receipt;
- the full focused matrix, including native Docker-required CLI roundtrip;
- Docker sandbox, pgvector, Postgres storage, and memory dogfood lanes;
- CI-owned Kubernetes and full-arc smoke lanes;
- scoped static hygiene on the final evidence state;
- `DAWN_REQUIRE_DOCKER=1 pnpm ci:validate` on the finalized state;
- independent specification and code-quality/security reviews; and
- exact-head pull-request CI, including Windows, Chromium, Vercel native,
  CodeQL, Scorecard, and required gated jobs.

## Changeset decision

No changeset is required for the current implementation:

- root manifest additions and policies are private test/tooling state;
- chat and research are private examples;
- `packages/ag-ui` changes only its CopilotKit development owner;
- `packages/ag-ui` runtime dependencies, optional peer floor, and `src/` are
  unchanged; and
- lock resolutions remain within existing published dependency ranges.

If later work changes a publishable package's normal dependency or `src/`, this
conclusion is invalid and that package needs a patch changeset.

## Pending pull request, merge, and post-merge receipt

**PENDING:** no PR number, reviewed head, merge SHA, or post-merge observation
head is recorded here before it exists.

The pull request may merge only on the exact reviewed green head while Release
workflow `260503756` and Publish Chart workflow `309127405` remain
`disabled_manually`. This work must not enable, dispatch, publish, or generate a
version candidate.

After merge, the bounded reader must correlate the exact PR, reviewed base,
reviewed head, merge SHA, stable observation head, fixed/open Dependabot sets,
final full/production audit, publication containment before and after alert
reads, and exact required CI/CodeQL/Scorecard runs. The manual receipt workflow
then seals the canonical redacted receipt into a content-addressed, write-once
Actions artifact. The PR comment is only an index to that artifact, not the
evidence store.

The final post-merge section must record the artifact ID, URL, service digest,
receipt SHA-256, uploader manifest digest, audit digest, reviewed-base receipt
digest, fixture digest, and final alert/containment verdict. Until that sequence
completes, all merge and post-merge claims remain pending.
