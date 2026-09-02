# Consolidation Workflow Pagination Identity Design

## Status

Approved design; implementation pending.

## Problem

The duplicate-draft consolidation inspection reads every run of the release
workflow and rejects mutation while any run is nonterminal. The reader sends
an exact request through GitHub's owner/name endpoint:

`/repos/cacheplane/dawnai/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs`

GitHub's authenticated response can express pagination links through its
canonical numeric repository endpoint instead:

`/repositories/1210070282/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs`

Both paths identify the same repository and workflow. The current Link
verifier accepts only the owner/name form, so the live v0.8.22 inspection
failed closed before it could confirm that there were zero nonterminal runs.
It wrote no proposal or journal and performed no mutation.

## Goals

- Accept GitHub's two exact path representations of the already-authorized
  Dawn repository and release workflow.
- Preserve strict validation of origin, protocol, credentials, fragment,
  workflow path encoding, query fields, page values, Link relations, page
  counts, record counts, cumulative response bytes, and deadline.
- Continue rejecting pagination links for every other repository, including a
  different numeric repository ID.
- Resume the live consolidation inspection without an override, compatibility
  shim, synthesized pagination, or release-specific exception.

## Non-goals

- Following arbitrary GitHub API paths or redirects.
- Relaxing the workflow-run query, status set, page size, or maximum page
  count.
- Ignoring the Link header or calculating later-page URLs without validating
  GitHub's pagination graph.
- Changing consolidation authority, deletion authorization, or the approved
  v0.8.22 release identities.

## Approaches Considered

### 1. Trust an exact union of repository paths

Accept the existing owner/name path and the canonical numeric path containing
the fixed Dawn GitHub repository ID. Continue applying every current URL and
pagination invariant. This is the recommended approach because it models the
two equivalent identities GitHub actually returns without widening trust to
another repository or endpoint.

### 2. Send workflow-run requests through the numeric path

Changing the outbound request to use only the numeric path may make today's
response links textually identical to the request. It does not establish that
GitHub will always preserve that representation, and it unnecessarily changes
the request boundary. It therefore does not solve the underlying identity
model as directly.

### 3. Ignore or synthesize pagination links

The reader could disregard GitHub's Link header and derive page URLs locally.
That would remove validation of the server's pagination graph and weaken a
release-safety boundary. This approach is rejected.

## Design

The reader has two Link-validation layers: a transport-level graph validator
that protects all GitHub API responses and a workflow-specific verifier that
checks the release-workflow page shape. Both layers must apply the same narrow
identity rule for this endpoint.

The workflow pagination rule will recognize exactly two pathnames:

1. the current path derived from the trusted owner/name workflow-run URL; and
2. `/repositories/1210070282/actions/workflows/` followed by the same exactly
   encoded release workflow path and `/runs` suffix.

The numeric path is bound to the same fixed repository ID already required by
the consolidation authority capture. It is not parsed as an arbitrary numeric
identifier and is not learned from an untrusted response.

At the transport layer, the alternate numeric pathname is valid only when the
current request is the fixed owner/name release-workflow endpoint. The
transport validator will canonicalize either accepted representation to the
owner/name page URL before it records relation targets and checks compatible
`next`/`last` or `prev`/`first` aliases. Generic pagination for every other API
endpoint will retain its existing exact-request-path rule.

The workflow-specific verifier will apply the same pathname union and return
the canonical owner/name page URL. This preserves the enumerator's exact
comparison with the expected next owner/name page. The enumerator will
continue to construct and request that expected URL rather than following a
response URL directly.

At both layers, all validation after pathname recognition remains unchanged. A
trusted URL must use the exact GitHub API HTTPS origin, contain no user info or
fragment, and have exactly one `per_page=100` field and one positive decimal
`page` field with no other query parameters. The Link graph must retain its
current unique and compatible relation rules.

This is a representation fix at the authenticated GitHub reader boundary. It
does not change the authority captured by the consolidation operation or grant
the response control over a request target.

## Error Handling

- A numeric path containing any repository ID other than `1210070282` is
  untrusted.
- A different repository name, workflow path, origin, protocol, query shape,
  page size, or malformed page remains untrusted.
- A numeric repository path attached to any request other than the fixed
  owner/name release-workflow endpoint remains untrusted.
- Missing, repeated, aliased, or contradictory Link relations continue to
  fail closed.
- Unstable totals, duplicate run IDs, inconsistent page lengths, excessive
  pages, byte-budget exhaustion, and deadline exhaustion remain unchanged.

## Testing and Verification

Tests will first demonstrate the current failure, then cover:

- successful two-page enumeration when GitHub uses the numeric repository path
  for compatible `next`/`last` and `prev`/`first` links;
- rejection of the same path with a foreign numeric repository ID;
- rejection of numeric repository aliases by generic pagination endpoints;
- continued success for the existing owner/name path; and
- continued rejection of all existing malformed, cross-origin, extra-query,
  and contradictory Link cases.

Verification will run the focused adapter tests, the complete duplicate-draft
consolidation test suite, scoped formatting and documentation checks, and the
repository Definition of Done with Docker required. The exact PR head will be
reviewed by GitHub Copilot before merge. After merge, the dedicated release
worktree will be reset to the exact verified `main` commit and the live inspect
command will be rerun. Any proposal produced by that inspection must be
independently checked for private file mode, canonical envelope, survivor and
duplicate IDs, candidate commit, and digest before a separate perform decision.
