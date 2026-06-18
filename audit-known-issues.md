# Known dependency-audit issues

This file records advisories surfaced by `pnpm audit` that are known and
currently unfixable, so they don't surprise future maintainers. Review
periodically — an upstream fix may make a residual entry resolvable.

## js-yaml 3.14.2 — moderate (GHSA-h67p-54hq-rp68)

- **Advisory:** Quadratic-complexity DoS in merge-key handling via repeated aliases.
- **Path:** `@changesets/cli > @manypkg/get-packages > read-yaml-file > js-yaml`.
- **Why unfixable here:** `read-yaml-file@1.1.0` requires `js-yaml@^3.6.1` and calls
  `yaml.safeLoad()`, which was removed in js-yaml 4. Forcing 3.x → 4.x breaks the build.
  No js-yaml 3.x patch exists. The fix must come upstream (changesets replacing
  `@manypkg/get-packages`, or `read-yaml-file` migrating to `yaml.load()`).
- **Exposure:** Dev/release tooling only (changesets). Not pulled by any published
  `@dawn-ai/*` package or `create-dawn-ai-app` runtime dependency.
