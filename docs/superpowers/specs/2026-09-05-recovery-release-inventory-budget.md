# Recovery release inventory read budget

The Release run after PR #572 merged (`33984920810`, controller `cb84db8c`) stopped before mutation with `CANDIDATE_DISCOVERY_AMBIGUOUS`. A read-only reproduction threw `Invalid recovery evidence: snapshot byte limit`. The repository has 477 releases in five complete API pages, approximately 2.54 MB of JSON. A single page fits the default limit, which hid the issue in small fixtures.

`discoverRecoveryReleaseCandidates` already validates supplied complete release inventories against a 16 MiB bound. `routeRecoveryCandidate` also supports fetching the inventory itself, through `readerContext.read`. That path uses the 1 MiB selection default in `runRecoveryRead`. The same inventory therefore fails depending on which path supplied it.

Use the existing 16 MiB release-inventory allowance for `readerContext.read("listReleases")`, and name that allowance once for both paths. The fetched path counts its response envelope; the supplied path counts the array. These are nominal snapshot allowances, not exact serialized JSON byte measurements. Other operations keep their existing limits. Preserve descriptor, depth, node, unsafe-key, pagination and inventory checks. Do not change token permissions, candidate ownership semantics, policy activation, or publication behavior.

Alternatives: a global default increase would broaden unrelated reads; projecting release data would require defining and reviewing another authority surface. The operation-specific allowance is the smallest correction consistent with the existing discovery contract.

Regression evidence must exercise a 477-entry inventory larger than 1 MiB through the self-fetching production-routing path, show unchanged legacy selection, reject inventories exceeding 16 MiB and malformed metadata, and preserve duplicate-candidate rejection. The successful supplied-inventory path is a comparison control. Run focused routing/policy/production-discovery tests, required CI, and a read-only production reproduction against the corrected controller.

Recovery remains DORMANT. The separate policy-read credential, platform authority contract, real workflow-token publication and quota evidence remain activation obligations. Automated reviewer credits are excluded by the owner's instruction.
