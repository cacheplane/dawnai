# Release Repository-ID Recovery Design

## Context

The v0.8.22 provenance release reached the `escrow` job and stopped before any
GitHub Release or npm mutation. GitHub's Releases endpoint returned its next
page in canonical repository-ID form:

```text
/repositories/1210070282/releases?per_page=100&page=2
```

The release reader already accepts that form when initialized with the exact
repository ID. The job did not provide `GITHUB_REPOSITORY_ID` to the CLI, so
the reader correctly rejected the otherwise valid next-page URL as
`UNSAFE_PAGINATION_URL`.

The v0.8.22 tag and candidate commit are immutable. Its tagged workflow cannot
consume a workflow-only fix merged later on `main` for downstream jobs that
checkout the exact candidate.

## Decision

Keep strict pagination validation and explicitly bind the trusted GitHub
Actions `github.repository_id` context into the release controller's
environment. Do not loosen URL validation, add an override, or special-case an
error string.

For the already-tagged v0.8.22 candidate, use the existing release CLI with:

- the exact candidate, release record, payload, attestation set, and bundles
  downloaded by immutable artifact ID from the failed tagged run;
- the authenticated GitHub and npm adapters;
- the exact repository ID returned by GitHub for `cacheplane/dawnai`;
- the existing writer and attestation verifier without bypasses or mocks.

This one-time CLI execution performs only the `escrow` transition. npm
publication, provenance publication, smoke lanes, audit, and final Release
publication remain owned by the tagged GitHub Actions workflow.

## Alternatives Rejected

### Trust any repository-ID pagination path

Following any `/repositories/<id>/...` link from GitHub would remove the
runtime dependency on a known ID, but it weakens the existing repository
identity check. The exact repository ID is available from the Actions context,
so relaxing this boundary is unnecessary.

### Replace enumeration with the exact-tag Release endpoint

An exact-tag lookup is efficient, but the current reader intentionally treats
HTTP 404 as ambiguous because absence and hidden resources cannot be
distinguished generally. Changing those semantics expands the security design
well beyond this production failure.

### Move or recreate the v0.8.22 tag

Changing the tag target would invalidate the approved candidate identity and
its existing CI and provenance evidence. The tag remains untouched.

## Permanent Workflow Change

Every release-controller CLI step that may construct the production GitHub
reader will receive:

```yaml
env:
  GITHUB_REPOSITORY_ID: ${{ github.repository_id }}
```

The CLI continues to validate the value as a positive decimal ID and continues
to require the pagination suffix to match the original repository endpoint.
No adapter behavior changes.

Workflow contract tests will prove that the repository ID is explicitly wired
into all relevant release entrypoints, preventing a future runner-environment
change from silently removing it.

## Recovery Flow

1. Reconfirm that v0.8.22 is absent from npm and that no `v0.8.22` GitHub
   Release exists.
2. Run a guarded dry diagnostic with the real readers and attestation verifier
   and a writer that stops before mutation.
3. Run the existing `escrow` CLI once with the production writer and exact
   repository ID.
4. Verify the draft Release marker and exact asset inventory independently
   through read-only API calls.
5. Dispatch the exact tagged workflow for v0.8.22 reconciliation.
6. Observe npm publication, all published-artifact smoke lanes, independent
   audit, and final Release publication to completion.
7. Verify exact npm versions, provenance, GitHub Release identity/assets,
   production documentation, and the production browser smoke.

If any check is ambiguous, stop before the next mutation. The controller's
existing idempotency and compare-and-swap checks remain authoritative.

## Verification

The permanent change must pass focused workflow-contract tests, release
controller tests, lint, and the repository Definition of Done. The recovery
must preserve evidence from the exact candidate SHA
`2a80deece2ff958fe7fde8fddeb4f99bed70a1c8` and tag `v0.8.22`.

