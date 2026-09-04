---
"@dawn-ai/cli": patch
---

Cut a new patch release. The previous version bump was never tagged or published: its merge commit failed CI on a literal chart-version pin in the Kubernetes documentation checks, and the release controller binds a candidate to the commit that introduced its version. The pin is now a floor, so this bump can be released. No runtime behavior changes.
