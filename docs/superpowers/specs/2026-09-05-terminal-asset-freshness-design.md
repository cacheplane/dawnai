# Fresh terminal abandonment asset verification

Global candidate discovery memoizes asset inventories for classification. It currently passes that memoized reader into terminal abandonment verification, so the explicit final asset check can reuse an earlier list and miss an intervening change.

Pass the original GitHub reader to `inspectAbandonmentRelease`. Keep classification caching and every terminal verification assertion unchanged. Downloads and other methods already forward to that same underlying reader; this change makes the final asset request reach the adapter again, where a conditional response must be freshly confirmed by the service. This does not promise an atomic snapshot.

Add regressions through `discoverScheduledCandidate`: stable evidence causes a second underlying asset read and still selects the next version; deleted or replaced terminal assets on that second read reject selection. Also reject an unavailable second read. Prove the tests fail under the old cache wiring. Refresh the candidate script pin, recovery verifier closure if affected, and pinned fixture manifest digest together. Run focused candidate/policy/workflow tests and complete CI before integration. No release writes or admission changes.
