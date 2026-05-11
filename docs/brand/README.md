# Brand assets

The Dawn logos and the README demo gif live here.

## Logos

- `dawn-logo-horizontal-black-on-white.png` — primary logo, light background.
- `dawn-logo-horizontal-white-on-black.png` — inverted, dark background.
- `dawn-social-avatar-white-on-black-1024.png` — square social/avatar.

## README demo gif

- `quickstart.gif` — the embedded gif in the root README.
- `quickstart.tape` — the [VHS](https://github.com/charmbracelet/vhs) script that produces it.
- `quickstart-fixture.json` — a captured `POST /v1/chat/completions` response replayed by the stub so the gif is fully deterministic.
- `stub-openai.mjs` — minimal Node HTTP server (no deps) that replays the fixture on a configurable port.
- `capture-fixture.mjs` — one-shot script that scaffolds a temp Dawn app, calls real OpenAI through a recording proxy, and rewrites `quickstart-fixture.json`.
- `build-gif.sh` — convenience driver that scaffolds a temp app, starts the stub, runs `vhs`, and cleans up.

### Rebuild the gif

Requires `brew install vhs`.

```bash
./docs/brand/build-gif.sh
```

That script:

1. Builds `create-dawn-ai-app` if needed and scaffolds a fresh `basic` app into a temp dir.
2. Symlinks it to `/tmp/dawn-demo-app` (the path the `.tape` references).
3. Starts `stub-openai.mjs` on `127.0.0.1:4317` serving `quickstart-fixture.json`.
4. Runs `vhs docs/brand/quickstart.tape`, which writes `docs/brand/quickstart.gif`.
5. Cleans up the temp app, symlink, and stub.

### Recapture the fixture

Only needed if the captured response should change (different model output, new prompt). Requires `OPENAI_API_KEY` in the repo's `.env`.

```bash
node docs/brand/capture-fixture.mjs
```

The capture script:

- Reads `OPENAI_API_KEY` from `.env`.
- Starts a local recording proxy on `127.0.0.1:4318` that forwards `/v1/chat/completions` to `api.openai.com` and saves the response body.
- Scaffolds a temp `basic` app, installs deps, points `OPENAI_BASE_URL` at the proxy, and runs `pnpm exec dawn run "hello/[tenant]"` with a JSON input on stdin.
- Writes `{ contentType, body }` to `docs/brand/quickstart-fixture.json`.
- Cleans up the temp app.

The fixture preserves the upstream `Content-Type`, so SSE streaming replays correctly through the stub.

### Determinism mechanism

`@dawn-ai/langchain`'s `ChatOpenAI` honors `OPENAI_BASE_URL`. The `.tape` sets that env var to `http://127.0.0.1:4317`, so every recording reads the same fixture instead of calling OpenAI. No flaky live LLM responses; no API key needed to rebuild the gif.
