---
"@dawn-ai/config-biome": patch
---

Skip generated `.dawn/` output when linting.

`dawn build` and `dawn dev` write `.dawn/`, which is gitignored and regenerated
on every run, so linting it reports diagnostics nobody can act on. The shared
config already set `vcs.useIgnoreFile`, but with `vcs.enabled` false it never
took effect — and enabling it is not an option here, because Biome resolves the
ignore file relative to each invocation's working directory and a workspace
package that has no `.gitignore` of its own then fails outright. Excluding the
directory in `files.includes` works from any directory.
