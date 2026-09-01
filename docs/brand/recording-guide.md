# Dawn product-loop recording guide

This guide rebuilds the silent flagship product-loop video, its three proof
clips, the GitHub/npm GIF, and four poster fallbacks from the current local Dawn
source tree.

## Prerequisites

- Node.js 24 or newer. The capture summary records the exact version.
- Corepack with the repository's exact pnpm 10.33.0.
- Playwright Chromium installed for `@playwright/test` 1.62.1.
- ffmpeg and ffprobe with `libx264` and `libvpx-vp9`; these assets are tested
  with version 8.1.1. The checked-in `sharp` development dependency encodes the
  WebP poster after ffmpeg extracts its exact source frame.
- Repository dependencies installed and enough temporary disk space for a local
  generated research workspace and raw recording.

Run every command from the repository root.

## Capture and encode

```bash
pnpm media:readme:capture
```

The command checks Node and pnpm before it builds the repository, creates the
current research starter in a temporary directory with `--mode internal`,
installs it, and runs the generated root `npm test` command. It then starts
aimock, the Dawn server, and the generated Workbench on assigned loopback ports
and records at 1440×810. ffmpeg is exercised when encoding begins; ffprobe is
exercised by the local checker, so a missing executable, encoder, or probe fails
at that boundary with the command's diagnostic.

Aimock is the only model endpoint. Provider credentials are excluded from child
environments and capture fails if the model base URL is not loopback. The
generated Workbench has no demo or fixture mode and receives no marketing-only
runtime branch.

The browser compositor reads all five generated paths and the real test log. Its
normalization is deliberately narrow: it strips ANSI, replaces the temporary
workspace root with `<workspace>`, and replaces durations such as `143ms` or
`1.27s` with `<time>`. Test names, PASS/FAIL text, commands, counts, ports, and
all other numeric output remain untouched.

After Playwright finalizes its recording and the capture summary is published,
ffmpeg creates four timelines:

1. `product-loop` — **Author** source → **Prove** test → **Run** Workbench →
   Close, 24 seconds.
2. `author` — **Author**, the generated route and shared tool, 9 seconds.
3. `test` — **Prove**, the real offline passing result, 9 seconds.
4. `run` — **Run**, completed Workbench run → browser reload → restored
   transcript, 10 seconds.

Sharp renders the three short label chips as transparent PNGs inside the
gitignored run artifacts. ffmpeg overlays each chip only on its matching
timeline segment; this needs neither ffmpeg `drawtext` nor a WebP encoder.
Posters are extracted from the labeled MP4 output so the fallback and video
always identify the same act.

The raw scenes are shorter than their delivery windows. The encoder uses only
frozen-frame holds around actual captured frames to make source, terminal, and
restored transcript text legible. It does not synthesize product events. The Run
clip demonstrates browser-reload restoration while the same Dawn server remains
running; it does not claim a server restart.

## Validate

```bash
pnpm media:readme:check -- --local
```

The checker invokes ffprobe with JSON output and verifies:

- exact 1440×810 16:9 geometry and 30 fps;
- a 20–30 second flagship and 8–12 second derivatives;
- H.264 MP4 and VP9 WebM for all four clips;
- no MP4 or WebM above 2,000,000 bytes and no GIF above 4,000,000 bytes;
- all four WebP posters and the Markdown transcript;
- captions that describe the existing workspace footage without claiming the
  scaffold command is shown.

It prints one `PASS` line for each contract group and exits nonzero if any
contract fails.

## Generated files

The latest run has its own roots under:

```text
docs/brand/demo/raw-recordings/runs/<run-id>/
docs/brand/demo/artifacts/runs/<run-id>/
```

Its local MP4 and WebM files are in the run's `output/` directory. A gitignored
`docs/brand/demo/artifacts/latest-media.json` pointer lets the local checker find
the most recent successful encode. Posters and the GIF are first completed and
validated in that run's `publication/` directory, then published together with
the pointer using rollback backups. The checker requires exact run-scoped paths
and verifies that the fixed poster/GIF hashes match the selected run. Raw
recordings, logs, MP4, and WebM files are not committed.

## Authorized publication convergence

Preview the publication plan without credentials or remote I/O:

```bash
pnpm media:readme:upload -- --dry-run
```

The local checker records a SHA-256 digest for each validated MP4/WebM alongside
its ffprobe and byte-size facts. An authorized `--apply` re-reads all eight
run-scoped files and requires each in-memory body's size and SHA-256 digest to
match those validation-time facts. No upload starts unless the entire preflight
succeeds. Every upload then uses its stable `demo/*.mp4` or `demo/*.webm` path
with overwrites enabled and random suffixes disabled.

If an upload fails or returns a mismatched URL, the command reports three exact
sets: the prior stable paths whose upload calls are confirmed complete, the
current stable path as potentially completed or mutated, and the later stable
paths as definitely pending. The media catalog is withheld. The command does
not claim or attempt remote rollback.

If a `HEAD` check fails after all eight upload calls return, all eight remote
paths may have changed while the verification outcome for the current public
URL remains uncertain; the catalog is again withheld. Use exactly one
credential mode: the preferred short-lived `VERCEL_OIDC_TOKEN` together with
`BLOB_STORE_ID`, or the legacy `BLOB_READ_WRITE_TOKEN`. The OIDC store ID and
the store ID encoded in a canonical legacy token must both match the authorized
Dawn media store. In either mode, `DAWN_MEDIA_PUBLIC_BASE_URL` is pinned to that
store's exact public origin. Credential values with surrounding whitespace are
rejected before local validation or remote I/O.

Vercel issues local OIDC tokens only for the development environment through
`vercel env pull`, even when another environment was previously pulled. The
Dawn Blob store connection must therefore include the development environment
for local publication. Pull the token into an untracked or temporary environment
file, export it without printing it, and remove that file after the command. The
preferred invocation is:

```bash
VERCEL_OIDC_TOKEN='<short-lived OIDC token>' \
BLOB_STORE_ID='store_9RQ8eZyGheVy0wOp' \
DAWN_MEDIA_PUBLIC_BASE_URL='https://9rq8ezyghevy0wop.public.blob.vercel-storage.com' \
pnpm media:readme:upload -- --apply
```

With that correct credential/base/store pairing, rerunning the same authorized
command is the safe convergence path: it performs a fresh complete preflight,
overwrites all eight stable paths idempotently, verifies every public URL with
`HEAD`, and only then atomically publishes the catalog. Equivalently, an
operator may re-verify all eight public URLs before publishing the catalog
through the same atomic path.

Committed outputs are:

```text
docs/brand/product-loop.gif
apps/web/public/demo/product-loop-poster.webp
apps/web/public/demo/author-poster.webp
apps/web/public/demo/test-poster.webp
apps/web/public/demo/run-poster.webp
apps/web/app/lib/demo-media.json
docs/brand/demo/transcript.md
```

## Visual inspection

Inspect every poster and representative frames from every local MP4/WebM at full
1440×810 size and at reduced README/mobile widths. Confirm that file paths, the
`npm test` result, `searchCorpus`, `readDoc`, the cited answer, browser reload,
restored transcript, and the **Author**, **Prove**, and **Run** labels correspond
exactly to
[the transcript](./demo/transcript.md). No remote upload or store mutation is
part of regeneration or local validation.
