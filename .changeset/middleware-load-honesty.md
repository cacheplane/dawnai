---
"@dawn-ai/cli": patch
"@dawn-ai/sdk": patch
---

Fail loudly when middleware is present but cannot be loaded, and load it
correctly on Windows.

The middleware probe wrapped every candidate import in a bare `catch {}`, so a
`src/middleware.ts` that threw while being imported — a missing environment
variable, an ESM/CJS interop break, a syntax error, an unresolved dependency —
was indistinguishable from an app with no middleware at all. The server started,
reported healthy, and served every gated Agent Protocol endpoint ungated, with
no log line anywhere.

**If your middleware file has been quietly broken, this release turns that into
a startup failure.** Dawn now decides existence before importing, and a
middleware file that exists but cannot be loaded exits with `DAWN_E3004`, naming
the file and the underlying cause. In `dawn dev` the watcher restarts the child
once you fix it; under `dawn start` or a built `server.mjs` the process exits
non-zero, so a deploy fails its health check instead of shifting traffic onto an
ungated server. Existence is probed with `lstat`, and only `ENOENT`/`ENOTDIR`
count as absent, so an unreadable middleware file is no longer read as "this app
has none". An app with no middleware file is unaffected.

Two related fixes ride along. The probe no longer falls through to a later
candidate when an earlier one fails, so a broken `src/middleware.ts` can no
longer silently bind a `middleware.ts` at the app root instead. And the dynamic
import now builds a `file://` URL rather than handing Node's ESM loader a raw
path: on Windows that path is a drive letter, which the loader rejects as an
unknown protocol, and the old `catch {}` swallowed it — middleware never ran on
Windows. It does now, so a Windows app with a middleware file that was inert
will start gating requests.

A middleware file that exports no middleware function is still ignored rather
than fatal, because the built manifest binds the same way, but it now warns on
stderr and names the file.
