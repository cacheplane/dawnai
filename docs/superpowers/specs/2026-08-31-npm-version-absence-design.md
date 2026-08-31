# Npm Exact-Version Absence Design

## Problem

The release controller currently accepts an unpublished npm version only when
the exact-version endpoint returns HTTP 404 with a JSON object containing
`code: "E404"`. The production npm registry instead returns HTTP 404 with a
JSON string such as `"version not found: 0.8.22"`. The adapter therefore marks
every genuinely unpublished package as ambiguous and prevents a new release
from starting.

Matching that human-readable string or treating every 404 as absence would be
fragile or unsafe. A 404 alone cannot distinguish a missing version from an
authorization, proxy, or registry inconsistency.

## Design

For every exact-version 404, the npm adapter performs a second bounded read of
the package's install-v1 packument. It accepts absence only when the packument:

- is a successful structured response from the already trusted registry origin;
- has the exact requested package identity;
- contains a well-formed `versions` mapping whose keys and embedded identities
  agree; and
- does not contain the requested version.

The adapter then returns the controller's existing canonical exact-absence
envelope (`ABSENT`, HTTP 404, `E404`). It does not expose or match npm error
text. Network failures, authentication failures, missing or malformed package
metadata, and disagreement between the two reads remain fail-closed.

The controller, planner, workflow, and release candidate identity do not
change. After this fix reaches `main`, the release workflow can reconcile the
original `0.8.22` candidate at commit
`2a80deece2ff958fe7fde8fddeb4f99bed70a1c8`.

## Verification

Tests reproduce npm's real string-body 404, prove the second request and
canonical absence result, and cover malformed metadata, missing package
metadata, and a conflicting packument that already contains the version. The
focused adapter and controller suites run before the full repository validation
and exact-head CI/review gates.
