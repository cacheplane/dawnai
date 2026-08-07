---
"@dawn-ai/postgres-storage": patch
---

Republish with the `pg` pool `'error'` handler.

**`@dawn-ai/postgres-storage@0.8.19` does not contain that fix, despite its changelog
entry saying so.** 0.8.19 was the package's first release, so it had to be published
by hand to create the name on npm before OIDC trusted publishing could take over — and
that tarball was built from a release branch that had not yet absorbed the fix. npm does
not allow a published version to be replaced, and the automated release skips any
version already on the registry, so 0.8.19 shipped and stayed the pre-fix build.

This release is the first one whose published artifact actually carries it. Anyone on
`@dawn-ai/postgres-storage@0.8.19` should upgrade: without the listener, `pg` raises an
unhandled `'error'` when an idle client is dropped — a server restart, failover,
`idle_session_timeout` — and an EventEmitter `'error'` with no listener terminates the
process. See the 0.8.19 entry for the full description of the fix itself.
