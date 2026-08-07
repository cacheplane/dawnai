---
"@dawn-ai/cli": patch
---

`dawn memory --help` now lists the subcommands.

Commander only knew about `--cwd`, so the help output showed the description and that
one flag — `consolidate`, `reflect`, `prune` and every subcommand flag were discoverable
only by triggering an error (running no subcommand, or an unknown one). The usage text
already existed; it is now attached to `--help` as well.
