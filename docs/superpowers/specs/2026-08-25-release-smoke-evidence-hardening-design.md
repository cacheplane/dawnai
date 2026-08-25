# Release Smoke Evidence Hardening Design

## Scope

This addendum hardens the release-smoke work described by the release integrity
controller design. It covers five related boundaries:

1. the controller, rather than a caller, owns the exact required smoke lanes;
2. smoke reconciliation consumes canonical receipt bytes rather than pre-parsed
   objects;
3. the draft Release durably names the exact smoke run, attempt, lanes, result
   artifacts, and aggregate digest needed by an independent audit;
4. every production release-smoke subprocess runs inside mandatory Linux cgroup
   v2 containment, with verified cleanup;
5. the Docker smoke resource identity and cleanup are owned outside the probe
   process that may be terminated.

The production metadata verifier composes with the corrected official npm-audit
boundary rather than duplicating it. This addendum does not change a workflow or
any public service state.

## Controller-owned smoke inventory

`scripts/release/smoke-result.mjs` exports one deeply frozen inventory for the
currently implemented receipt emitters, in stable lexical order:

- `metadata`
- `published-harness`
- `runtime-targets`
- `scaffold`
- `storage`

Correlation and aggregation use this inventory internally. They do not accept a
caller-provided lane set. The release CLI requires exactly one canonical receipt
file for every inventory entry and rejects missing, duplicate, unexpected, or
misnamed files. When Task 10 splits a grouped lane into additional jobs, the
inventory, workflow contract, and tests change atomically.

## Canonical receipt ingestion and durable escrow

The release CLI reads each smoke file as a bounded regular-file byte sequence,
without JSON-decoding it. Reconciliation passes those bytes to
`parseSmokeResult`, preserving the canonical-byte check through the Release
mutation boundary. Duplicate keys, invalid UTF-8, alternate whitespace, and key
reordering therefore fail before any remote read or write.

The aggregate schema gains root `workflowRunId` and `runAttempt` fields. Direct
aggregate validation requires every lane to carry the same values. The trusted
reconciliation invocation obtains its current run ID and attempt from the
GitHub Actions environment and rejects receipts for any other run or attempt.

An Actions artifact name is not a durable locator. The run-artifact API is keyed
only by run ID, not attempt, and Actions artifacts expire. Reconciliation
therefore observes each deterministic attempt-qualified artifact name in the
exact trusted run, requires one match, re-reads its unique artifact ID, records
its service digest, downloads its bounded ZIP by ID, and requires that ZIP to
contain exactly the matching canonical receipt bytes supplied to reconciliation.
The exact run-attempt observation must bind the workflow path, tag ref, and
candidate commit before any Release mutation.

Successful evidence is then escrowed as five raw draft Release assets before the
marker may reach `SMOKES_COMPLETE`. The marker's `smoke` descriptor binds both
copies of every receipt:

```json
{
  "workflow": ".github/workflows/release.yml",
  "workflowRunId": 200,
  "runAttempt": 1,
  "requiredLanes": ["metadata", "published-harness", "runtime-targets", "scaffold", "storage"],
  "artifacts": [
    {
      "lane": "metadata",
      "actionsArtifactId": "901",
      "actionsArtifactName": "smoke-result-metadata-200-1",
      "actionsArtifactUrl": "https://github.com/cacheplane/dawnai/actions/runs/200/artifacts/901",
      "actionsArtifactServiceDigest": "sha256:...",
      "releaseAssetId": 802,
      "releaseAssetName": "smoke-result-metadata-200-1.json",
      "receiptSha256": "..."
    }
  ],
  "receiptAssets": [
    {
      "lane": "metadata",
      "workflowRunId": 199,
      "runAttempt": 1,
      "releaseAssetId": 801,
      "releaseAssetName": "smoke-result-metadata-199-1.json",
      "receiptSha256": "..."
    },
    {
      "lane": "metadata",
      "workflowRunId": 200,
      "runAttempt": 1,
      "releaseAssetId": 802,
      "releaseAssetName": "smoke-result-metadata-200-1.json",
      "receiptSha256": "..."
    }
  ],
  "aggregateSha256": "..."
}
```

There is exactly one locator per required lane, in inventory order. Actions
artifact IDs are positive decimal strings, URLs are the exact trusted-repository
run/artifact URL derived from that ID, and service digests use canonical
`sha256:<lowercase-hex>` syntax. Release asset names are deterministic and their
content digest is the canonical raw receipt digest. The human-readable body
renders the exact run, attempt, Actions identity, and durable Release asset
checklist. Reconciliation never accepts an artifact ID, URL, or digest from a
caller or upload-action output; it derives the URL solely from the trusted
repository/run plus the API-observed ID and obtains the digest from the exact API
re-read.

Escrow uses the disjoint attempt-scoped namespace
`smoke-result-<lane>-<run>-<attempt>.json`. Reconciliation uploads each raw
receipt with no-clobber/equal-byte semantics and re-reads the assets before the
single body compare-and-swap to `SMOKES_COMPLETE`. Faults before that CAS leave
the marker at `NPM_COMPLETE`; zero or a matching subset for an attempt is
resumable. A later workflow attempt uses a new namespace and retains, rather than
deletes, prior partial attempts. The final descriptor's sorted `receiptAssets`
array binds every retained smoke Release asset, while the root run/attempt and
five full Actions locators select exactly one complete successful attempt. Asset
count and cumulative bytes are bounded. A same-name different-byte asset,
malformed attempt subset, unbound post-completion asset, or completed marker with
an incomplete selected set is a conflict. Audit and publication accept smoke
evidence only from the selected Release-hosted bytes, so Actions retention cannot
erase the proof.

Idempotent replay validates the byte-identical descriptor and exact Release
assets. Once `SMOKES_COMPLETE` is durable, it does not require retained Actions
artifact bytes. Listing recent workflow runs or guessing an attempt is forbidden.

## Strict production subprocess containment

Generic best-effort process execution remains a separate API for non-release
callers. The four modules under `scripts/release/smoke/` and the release-mode
branch of `scripts/published-artifact-verify.mjs` cannot select it. Their command
defaults require the strict containment adapter. The verifier's manual,
non-release branch remains a separate best-effort consumer.

The supported production adapter is Linux on a GitHub-hosted Ubuntu 24.04 VM. It
uses a uniquely named transient systemd service so systemd creates the cgroup and
places a fixed Node shim before `exec`. The shim reads a bounded mode-0600
invocation descriptor, publishes readiness, and waits on a gate. The controller
opens the gate only after `systemctl show` has returned and validated the live
unit's `ControlGroup`, so the cgroup path is cached before the requested workload
can spawn. The service runs as the current non-root UID/GID, in the requested
working directory, with an explicitly constructed environment and captured
output. Unit names contain only generated safe characters and are never derived
from command text.

The exact transient-service policy includes `Type=exec`,
`KillMode=control-group`, `NoNewPrivileges=yes`, `RestrictSUIDSGID=yes`, empty
ambient and bounding capability sets, `Delegate=no`,
`ProtectControlGroups=yes`, `UMask=0077`, a bounded `RuntimeMaxSec`, and a
bounded `TimeoutStopSec`. `systemd-run` is invoked with
`--expand-environment=no`. The adapter uses only fixed absolute paths for
`sudo`, `timeout`, `systemd-run`, `systemctl`, and `tee`, and the probe requires
each to be a root-owned regular executable that is not group/world writable.
The stock Ubuntu 24.04 target uses systemd 255, so the adapter neither requests
the later `private`/`strict` modes nor installs or overrides systemd. The probe
must re-read and verify the effective live `ProtectControlGroups=yes` and
`Delegate=no` properties.

The capability probe requires:

- Linux and a unified cgroup v2 mount;
- non-interactive passwordless `sudo`;
- `systemd-run` and `systemctl` connected to the system manager;
- a transient probe service whose control group exposes `cgroup.kill` and
  `cgroup.events`;
- successful cleanup proved by `populated 0` or post-deactivation `ENOENT` for
  the previously validated exact path.

Every privileged control command uses exactly
`/usr/bin/sudo -n /usr/bin/timeout --signal=TERM --kill-after=5s 30s ...`.
The long-lived `systemd-run --wait` invocation instead uses the fixed workload
profile `--signal=TERM --kill-after=10s 25m`. Neither profile permits
`--foreground`. The non-root outer client waits at least 40 seconds for a
control command or 25 minutes 15 seconds for the workload profile before its
own termination/reap fallback, so it cannot race the root wrapper's guaranteed
hard-kill window. Every client has a fixed output bound and an awaited reap.
These client bounds complement, rather than replace, the transient unit's
`RuntimeMaxSec` and `TimeoutStopSec`. Workload
`systemd-run --wait --pipe` deliberately uses neither `RemainAfterExit` nor
`--collect`: those options conflict or garbage-collect the failed unit before
cleanup evidence can be read.

Timeout, abort, output-limit, spawn, nonzero-exit, and success paths all invoke
the same cleanup state machine. It asks systemd to signal the entire unit,
checks the cached exact control-group path, and, while populated, writes `1` to
`cgroup.kill` only through fixed `/usr/bin/sudo -n /usr/bin/timeout
--signal=TERM --kill-after=5s 30s
/usr/bin/tee -- <validated-path>/cgroup.kill`. It then waits a small fixed bound
for `cgroup.events` to report `populated 0`, stops/resets the unit, and verifies
emptiness again. Once the unit has deactivated, exact `ENOENT` for the previously
validated cgroup path is also proof that the cgroup was removed. Any other read,
control-child, termination, or emptiness failure is an additional cleanup error,
never a successful timeout. Detached sessions cannot escape the unit cgroup.

The capability probe is the first recorded check inside each lane's
receipt-producing boundary. An unsupported or unprovisioned host therefore
spawns no workload but still emits a correlated failure receipt.

Windows and macOS are unsupported for strict production release smoke. They
fail before spawning. Windows support requires a real Job Object adapter with
kill-on-close and breakaway disabled; `taskkill` is not represented as strict
containment.

Task 10 must select the `ubuntu-24.04` label, record the observed runner image
version, and ensure the first receipt-producing check in each release-smoke job
is the capability probe. A separate workflow preflight may provide diagnostics,
but cannot gate away the lane's failure receipt. The label is not an immutable
image pin. Standard GitHub-hosted Ubuntu VMs currently document passwordless
`sudo` and ship systemd, so the design does not require a new repository or cloud
privilege. The per-lane probe remains mandatory because the image behind the
label can change. The capability check validates and records the bounded
`ImageOS` and `ImageVersion` environment values in its raw lane receipt. Task 10
must fault-inject and prove the exact dual timeout/reap and cgroup cleanup
mechanism on that Ubuntu image, including a privileged control child that ignores
`SIGTERM`; the test must prove the hard-kill deadline leaves no survivor.

## Docker cleanup ownership

Docker resources belong to the daemon and are deliberately outside the CLI
process cgroup. Strict containment can kill a timed-out Docker client, but cannot
claim that the daemon-owned resource was removed.

The outer published-harness lane generates and validates a unique Docker thread
identity before starting the inner probe. It registers exact container and
volume cleanup immediately, then passes the identity to the probe. The storage
lane likewise preallocates and validates both pgvector and Postgres container
names and registers both cleanups before either `docker run`. This covers the
accepted-by-daemon/client-failed window. Inner cleanup remains an idempotent fast
path, while outer cleanup is authoritative and verifies exact absence. All
cleanup commands themselves use strict containment.

The initial published-harness install uses `--ignore-scripts`; package code does
not execute before exact npm audit evidence has been accepted.

## Testing

Tests follow red-green cycles and cover:

- omission of every required lane, especially `metadata`, plus caller attempts
  to provide subsets or supersets;
- raw duplicate-key, noncanonical, invalid UTF-8, oversized, symlinked, and
  changed-during-read receipts with zero Release mutation;
- exact descriptor rendering, Actions ID/service-digest binding, staged durable
  Release receipt escrow, idempotent replay, and conflicts across run IDs,
  attempts, artifacts, lanes, and digests;
- independent audit from the exact Release-hosted receipt assets, including
  simulated Actions-artifact expiry after reconciliation;
- capability refusal before spawn on unsupported/unprovisioned hosts;
- timeout, abort, and output-limit cleanup of a detached descendant that ignores
  graceful termination;
- propagation of containment cleanup failures;
- outer Docker cleanup after an accepted-then-failed client or forcibly
  terminated published-harness/storage probe; and
- contract tests showing every production release-smoke path, including the
  metadata verifier's release-mode branch, constructs only the strict runner.

The systemd boundary is dependency-injected for deterministic tests on non-Linux
development hosts. Task 10 supplies the real Ubuntu integration proof.
