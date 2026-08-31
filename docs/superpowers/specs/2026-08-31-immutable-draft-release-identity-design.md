# Immutable Draft Release Identity Design

## Problem

Dawn's release controller assumes that a GitHub draft Release created for
`v<version>` will continue to report that value in `tag_name`. GitHub does not
provide that invariant. A draft can be represented by a temporary
`untagged-<opaque>` identity until publication, including when the requested
annotated tag already exists. The v0.8.22 recovery demonstrated the behavior:
GitHub accepted the draft, all 45 base assets converged, and a later re-read
reported the temporary tag identity. The controller rejected the otherwise
valid draft and intentionally left its marker at `ATTACHING`.

The requested release tag remains an independently verifiable annotated Git
object throughout this process. The problem is the controller treating the
draft Release's temporary `tag_name` as that tag's identity.

## Goals

- Model GitHub drafts without depending on an opaque temporary tag name.
- Preserve exact annotated-tag verification before and after every mutation.
- Reconcile the existing v0.8.22 `ATTACHING` draft without recreating or
  replacing its 45 assets.
- Bind the exact requested tag during publication and require exact tag
  identity on the immutable published Release.
- Keep duplicate or conflicting drafts fail-closed.

## Non-goals

- Matching or interpreting GitHub's `untagged-*` naming convention.
- Disabling GitHub release immutability.
- Adding compatibility overrides, retries based on error strings, or a
  v0.8.22-only recovery path.
- Weakening artifact, provenance, publication-history, or npm checks.

## Identity Model

### Mutable draft

A managed mutable draft is identified by:

1. its positive GitHub Release ID;
2. `draft: true` and `immutable: false`;
3. the canonical Dawn release marker embedded in its body, whose exact tag,
   version, candidate commit, phase, and digests match the candidate;
4. the expected title, `target_commitish`, and prerelease state; and
5. an independently verified annotated Git ref whose tag object peels to the
   exact candidate commit.

The draft's `tag_name` remains validated as data but is not an identity field.
The controller does not inspect, match, or persist GitHub's temporary value.

Draft discovery accepts either a published-style exact `tag_name` match or a
draft whose canonical marker names the exact requested tag. More than one
matching Release is ambiguous and blocks all mutation.

### Published Release

Publication sends the exact requested `tag_name` together with `draft: false`.
After GitHub publishes the Release, the controller requires:

- `tag_name` equals `v<version>` exactly;
- `draft: false` and `immutable: true`;
- the Release ID, title, body, and asset set are unchanged; and
- the annotated tag still peels to the candidate commit.

Published Releases continue to use exact tag identity in observers, audit
coordination, and final verification.

## Component Changes

### GitHub writer boundary

Split draft and published identity assertions. Draft reads require stable
Release metadata but do not equate `tag_name` with the requested tag. Published
reads retain that exact check. Draft creation and race reconciliation discover
an existing draft by the exact canonical body and title as well as by an exact
published tag match. Publication explicitly includes `tag_name` in the PATCH.

### Release metadata controller

Discover managed drafts by parsing their canonical marker. Ignore unrelated or
unparseable drafts, but treat multiple candidate matches as ambiguous. The
existing marker and asset validation remains authoritative after discovery.

### Production observation and release phases

Any path that must observe a pre-publication managed Release selects a draft by
its canonical marker rather than by temporary `tag_name`. Paths that require a
published Release continue to require the exact tag. This distinction applies
to escrow, npm reconciliation, smoke reconciliation, audit coordination,
abandonment safety, and production observation.

## Recovery Flow

After the fix is merged, the controller re-runs escrow against Release
`379991871`. It discovers the draft from the exact v0.8.22 marker, re-reads and
verifies all 45 existing assets, and advances the marker from `ATTACHING` to
`ESCROWED`. No asset is replaced and no draft is recreated. The tagged
provenance workflow can then continue npm trusted publishing, release smokes,
independent audit, and final immutable publication.

## Error Handling

- Missing, malformed, or conflicting markers block mutation.
- Duplicate candidate drafts or a draft plus a conflicting published Release
  block mutation.
- An annotated tag that is missing, lightweight, moved, or peels to another
  commit blocks mutation.
- Publication that does not bind the exact tag or become immutable is rejected
  on re-read.
- Existing compare-and-swap checks for body and asset digests remain unchanged.

## Testing

Regression tests must fail against the current implementation and cover:

- creation re-reads where GitHub changes a draft's `tag_name` to an opaque
  temporary value;
- convergence of an existing `ATTACHING` draft discovered by marker;
- duplicate marker-bearing drafts failing closed;
- update and asset upload operations accepting only the marker-authorized
  mutable draft;
- publication sending the exact tag and requiring it on the immutable re-read;
- production observation and each pre-publication phase finding marker-backed
  drafts while published-release paths retain exact tag checks; and
- unchanged rejection of moved tags, malformed markers, conflicting metadata,
  and non-immutable publication.

Focused release-controller tests run first, followed by lint, the full release
controller suite, and the repository Definition of Done. GitHub Copilot reviews
the exact PR head before merge.
