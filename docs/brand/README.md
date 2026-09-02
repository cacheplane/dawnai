# Brand assets

The Dawn logos and reproducible product-loop media live here.

## Logos

- `dawn-logo-horizontal-black-on-white.png` — primary logo, light background.
- `dawn-logo-horizontal-white-on-black.png` — inverted, dark background.
- `dawn-social-avatar-white-on-black-1024.png` — square social/avatar.

## Product-loop media

- `product-loop.gif` — committed 1440×810, 30 fps GitHub/npm animation.
- `demo/transcript.md` — exact static walkthrough for the flagship and three
  derivative clips.
- `demo/scenario.mjs` — the canonical prompt and deterministic aimock fixture.
- `demo/capture.mjs` — real internal scaffold, test, Workbench, and Playwright
  capture orchestration.
- `demo/encode.mjs` — product-loop, Author, Test, and Run timeline encoder.
- `demo/check-media.mjs` — local codec, geometry, duration, size, poster,
  transcript, and caption contract checker.
- `../../apps/web/public/demo/*-poster.webp` — committed poster fallbacks.

MP4, WebM, raw Playwright recordings, test logs, summaries, and media manifests
are generated under the gitignored `demo/artifacts/` and
`demo/raw-recordings/` directories. Only the flagship GIF, four posters,
transcript, and capture sources are committed.

## Regenerate and validate

From the repository root:

```bash
pnpm media:readme:capture
pnpm media:readme:check -- --local
```

See [recording-guide.md](./recording-guide.md) for prerequisites, the four
timelines, deterministic capture boundaries, and asset inspection guidance.
These commands create local assets only. They do not upload media or create a
remote store.

## Determinism and truthfulness

The capture creates the current local research starter in internal mode, runs
its real `npm test` path, and drives the generated Workbench against aimock on a
loopback URL. Provider credentials are removed from child environments. The
Workbench has no demo or fixture mode; only its model endpoint is redirected by
the capture process to the deterministic fixture service.

The Author and Test compositors display generated source and real command output.
Normalization strips ANSI, replaces the temporary workspace root with
`<workspace>`, and replaces duration fields with `<time>`; it preserves test
names, PASS/FAIL text, commands, counts, ports, and other numeric output.

Because the raw captured scenes are intentionally brief, encoding uses honest
frozen-frame holds around those same frames for legibility. It never fabricates
a source file, test result, tool call, response, reload, or restored state.
Sharp renders deterministic **Author**, **Prove**, and **Run** label chips into
the ignored run artifacts; ffmpeg composites them over the matching captured
segments. Posters are extracted from the labeled MP4 output, so their act and
footage remain in sync without changing Dawn runtime behavior.
