# Dawn README and Video Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one deterministic route-to-test-to-Workbench media system, use it to rebuild Dawn's root GitHub README and all 21 npm package READMEs/metadata, and integrate the same proof into the homepage.

**Architecture:** A capture-only browser compositor renders real generated files and normalized real test output, while Playwright records the real generated Workbench against an aimock server. One checked-in media catalog connects verified remote MP4/WebM assets to committed posters/GIF/transcripts. README contracts and homepage component tests prevent the three surfaces from drifting.

**Tech Stack:** Node.js 24, pnpm 10, Node test runner, Playwright Chromium, ffmpeg/ffprobe, aimock through `@dawn-ai/testing`, Markdown/GitHub Flavored Markdown, Next.js 16, React 19, Vitest, TypeScript 7.

**Design:** `docs/superpowers/specs/2026-08-31-dawn-readme-video-awareness-design.md`

---

## Delivery boundaries

This plan has three dependent lanes, each ending in a working review point:

1. **Media foundation:** deterministic capture, encoded assets, transcript, and verified stable URLs.
2. **GitHub/npm:** root README, all package READMEs, package metadata, changeset, and drift checks.
3. **Homepage:** typed media catalog, accessible player/switcher, and existing-section integration.

The external media upload is an explicit authorization gate. Do not upload, create a store, or mutate a remote service until the user authorizes that exact step. Lanes 2 and 3 must not merge references to the full video before the verified URLs exist.

## File structure

### Media foundation

- Create: `docs/brand/demo/scenario.mjs` — the single prompt and aimock fixture sequence used by the Workbench capture.
- Create: `docs/brand/demo/normalize-log.mjs` — remove ANSI and normalize only durations and temporary paths for display.
- Create: `docs/brand/demo/stage.mjs` — render escaped generated files and normalized test output into capture-only HTML.
- Create: `docs/brand/demo/processes.mjs` — spawn, readiness-check, and terminate aimock/server/Workbench child processes.
- Create: `docs/brand/demo/capture.mjs` — scaffold, test, serve, and record the three scenes.
- Create: `docs/brand/demo/encode.mjs` — ffmpeg composition and MP4/WebM/GIF/poster production.
- Create: `docs/brand/demo/check-media.mjs` — local asset and remote media contract validation.
- Create: `docs/brand/demo/upload.mjs` — authorized stable-path upload and HEAD verification.
- Create: `docs/brand/demo/demo.test.mjs` — focused tests for scenario, normalization, escaping, manifest validation, and cleanup.
- Create: `docs/brand/demo/transcript.md` — exact static walkthrough of every flagship and derivative scene.
- Create: `docs/brand/product-loop.gif` — committed GitHub/npm animation.
- Create: `apps/web/public/demo/product-loop-poster.webp` — committed flagship fallback.
- Create: `apps/web/public/demo/author-poster.webp` — committed author clip fallback.
- Create: `apps/web/public/demo/test-poster.webp` — committed test clip fallback.
- Create: `apps/web/public/demo/run-poster.webp` — committed restoration clip fallback.
- Create after authorized upload: `apps/web/app/lib/demo-media.json` — verified URL/content-type catalog.
- Modify: `docs/brand/README.md` — replace VHS instructions with the deterministic pipeline.
- Modify: `docs/brand/recording-guide.md` — replace manual Screen Studio steps with exact capture/upload/regeneration commands.
- Modify: `.gitignore` — ignore `docs/brand/demo/artifacts/` and raw Playwright recordings.
- Modify: `package.json` — add `media:readme:capture`, `media:readme:check`, and `media:readme:upload` scripts.
- Delete after replacement verification: `docs/brand/build-gif.sh`, `docs/brand/capture-fixture.mjs`, `docs/brand/quickstart-fixture.json`, `docs/brand/quickstart.tape`, `docs/brand/quickstart.gif`, and `docs/brand/stub-openai.mjs`.

### GitHub/npm surface

- Create: `docs/brand/demo/evidence-matrix.md` — material root README claims mapped to current evidence, conditions, and drift controls.
- Create: `scripts/lib/readme-contracts.mjs` — root/package README and package discovery metadata validators.
- Create: `scripts/readme-contracts.test.mjs` — unit tests for the validators.
- Modify: `scripts/check-docs.mjs` — invoke the validators for the root and release-inventory public packages.
- Modify: `scripts/lib/published-artifacts.mjs` — require `description` and `keywords` in published metadata.
- Modify: `scripts/published-artifacts.test.mjs` — cover the new metadata contract.
- Modify: `README.md` — product-loop-first GitHub funnel.
- Modify: all `packages/*/README.md` files for the verified 21-package public inventory.
- Modify: all 21 public `packages/*/package.json` manifests.
- Create: `.changeset/<generated-name>.md` — one patch changeset naming the edited public packages.

### Homepage

- Create: `apps/web/app/lib/demo-media.ts` — validate and type the JSON catalog.
- Create: `apps/web/app/lib/demo-media.test.ts` — catalog completeness and path/content contracts.
- Create: `apps/web/app/components/ui/ClipPlayer.tsx` — poster-first, muted inline video with reduced-motion and error fallback.
- Create: `apps/web/app/components/ui/ClipPlayer.test.tsx` — playback, reduced-motion, and fallback behavior.
- Create: `apps/web/app/components/landing/MediaSwitcher.tsx` — accessible Video/Code tabs with active-pane-only rendering.
- Create: `apps/web/app/components/landing/MediaSwitcher.test.tsx` — click and keyboard behavior plus DOM-mount guarantees.
- Modify: `apps/web/vitest.config.ts` — include `.test.tsx` files.
- Modify: `apps/web/package.json` — add `jsdom` for focused React DOM tests.
- Modify: `apps/web/app/components/landing/Hero.tsx` — make flagship video the default right-column proof and retain code as the second pane.
- Modify: `apps/web/app/components/landing/FeatureRouting.tsx` — add the Author/Code proof switcher.
- Modify: `apps/web/app/components/landing/FeatureDevLoop.tsx` — add the Test/Animation proof switcher.
- Modify: `apps/web/app/components/landing/DurableByDefault.tsx` — add the Run restoration clip.
- Modify: `apps/web/app/page.tsx` — add the stable `#product-loop` target if the hero component cannot own it cleanly.

---

### Task 0: Establish the root README claim-evidence matrix

**Files:**
- Create: `docs/brand/demo/evidence-matrix.md`

- [ ] **Step 1: Inventory every material planned root README claim**

Create a table with the columns `Claim`, `Code/test/doc evidence`,
`Conditionality`, `Drift control`, and `Disposition`. Include one row for each
of these planned claim families before writing README prose:

- Dawn is a TypeScript meta-framework for LangGraph.js.
- File-system routes and route identity, including `/research#agent`.
- Shared and route-local tools.
- Generated TypeScript types.
- Deterministic fixture-backed tests.
- Durable thread/checkpoint behavior, distinguishing browser reload from server
  restart.
- Build/deployment targets and their stated boundaries.
- The research starter workspace shape, default ports, and `gpt-5-mini` example.
- The canonical `npm create dawn-ai-app@latest my-agent` activation path.
- Pre-1.0 maturity and support language.
- Each comparison made in `How Dawn fits` and `When Dawn fits`.

- [ ] **Step 2: Populate evidence from checked-in sources**

For each row, cite exact repository paths and, where practical, a test name or
export rather than a general directory. Mark environment-dependent claims as
conditional. Set `Disposition` to `keep`, `qualify`, or `remove`; no row may be
left undecided. Do not add benchmark, popularity, adoption, or quantitative
code-reduction claims.

- [ ] **Step 3: Verify the published canonical activation in a clean room**

Run the exact public command in a fresh temporary directory and retain its
observed success line in the matrix:

```bash
activation_root="$(mktemp -d)"
(
  cd "$activation_root"
  npm create dawn-ai-app@latest my-agent
  cd my-agent
  npm install
  npm test
)
```

Expected: the published scaffold installs and its default no-key test passes.
Record the exact Node/npm versions and output; if it fails, mark the activation
claim `qualify` or `remove` and do not write the stronger README claim.

- [ ] **Step 4: Verify current implementation evidence**

Run the existing local scaffold tests and inspect the current scaffold help and
generated package scripts:

```bash
pnpm build
pnpm --filter create-dawn-ai-app test
node packages/create-dawn-app/dist/bin.js --help
```

Expected: build and scaffold tests PASS; the matrix records the exact observed
template/default behavior, supported Node/package-manager requirements, and
generated dev ports. If any planned README wording conflicts with this evidence,
change the planned wording before Task 6 rather than weakening the evidence row.

- [ ] **Step 5: Commit the evidence baseline**

```bash
git add docs/brand/demo/evidence-matrix.md
git commit -m "docs: establish README claim evidence"
```

---

### Task 1: Establish README and metadata contracts

**Files:**
- Create: `scripts/lib/readme-contracts.mjs`
- Create: `scripts/readme-contracts.test.mjs`

- [ ] **Step 1: Write failing unit tests for root and package README contracts**

Create table-driven Node tests that prove:

```js
assert.deepEqual(
  validatePackageReadme({
    tier: "entry",
    manifest: {
      name: "@dawn-ai/sdk",
      private: false,
      description: "Author-facing TypeScript SDK for defining Dawn agents.",
      keywords: ["dawn", "typescript", "langgraph"],
    },
    readme: `# @dawn-ai/sdk

Author-facing TypeScript SDK.

**Use this when:** You are authoring a Dawn route.

## Install

## Example

## Runtime and stability

## Related

## Maturity and support

## License

![Dawn product loop](https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif)`,
  }),
  [],
)
```

Add negative cases for missing `Use this when`, install/invocation heading, example on author-facing packages, runtime boundary, related links, maturity, license, entry-tier product-loop image, description, empty/duplicate/invalid keywords, and README H1/name mismatch.

Add a root contract test requiring these headings in order:

```js
[
  "Quickstart",
  "Why Dawn",
  "How Dawn fits",
  "What Dawn writes for you",
  "What are you building?",
  "When Dawn fits",
  "Build with a coding agent",
  "Run it live",
  "Maturity and support",
]
```

Also require the canonical scaffold command, `docs/brand/product-loop.gif`, the migration link, transcript link, and no occurrence of the old GIF caption.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test scripts/readme-contracts.test.mjs`

Expected: FAIL because `scripts/lib/readme-contracts.mjs` does not exist.

- [ ] **Step 3: Implement the focused validators**

Export:

```js
export function validateRootReadme(source) { /* string[] failures */ }
export function validatePackageReadme({ tier, manifest, readme }) { /* string[] failures */ }
export function validatePackageDiscoveryMetadata(manifest) { /* string[] failures */ }
```

Rules:

- Description is a trimmed string between 30 and 180 characters.
- Keywords are 3-8 unique lowercase strings matching `/^[a-z0-9]+(?:-[a-z0-9]+)*$/u`.
- All public README files contain the package name H1, purpose, `**Use this when:**`, install/invocation, runtime/stability, related links, maturity/support, and license.
- Capability and entry packages require an example.
- Entry packages require the product-loop GIF.
- Tooling packages may use a configuration example instead of an API example.
- Root section-order comparison uses parsed Markdown headings, not substring positions inside code fences.

- [ ] **Step 4: Define and test the complete public-package tier map**

Export a tier resolver that accepts the package names discovered from the release
inventory. Classify packages with this exact tier map:

```js
const entryPackages = new Set(["create-dawn-ai-app", "@dawn-ai/sdk", "@dawn-ai/cli"])
const capabilityPackages = new Set([
  "@dawn-ai/ag-ui",
  "@dawn-ai/evals",
  "@dawn-ai/inspector",
  "@dawn-ai/memory",
  "@dawn-ai/memory-pgvector",
  "@dawn-ai/permissions",
  "@dawn-ai/postgres-storage",
  "@dawn-ai/sandbox",
  "@dawn-ai/sqlite-storage",
  "@dawn-ai/testing",
  "@dawn-ai/workspace",
])
```

All remaining public packages are tooling/adapters. Fail if the release inventory
contains a public package absent from the resolved three categories, or if a
package is classified more than once. Keep this task at the pure-validator layer;
wire it into repository-wide checks only after the README and manifest migrations
are complete in Task 10, so every checkpoint remains green.

- [ ] **Step 5: Run targeted tests**

Run: `node --test scripts/readme-contracts.test.mjs`

Expected: PASS. Do not run the validator against the still-unmigrated repository
surfaces in this task.

- [ ] **Step 6: Commit the contract foundation**

```bash
git add scripts/lib/readme-contracts.mjs scripts/readme-contracts.test.mjs
git commit -m "test(docs): define README and package metadata contracts"
```

---

### Task 2: Build deterministic capture primitives

**Files:**
- Create: `docs/brand/demo/scenario.mjs`
- Create: `docs/brand/demo/normalize-log.mjs`
- Create: `docs/brand/demo/stage.mjs`
- Create: `docs/brand/demo/processes.mjs`
- Create: `docs/brand/demo/demo.test.mjs`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing tests for the fixture and capture compositor**

Use `node:test` to require:

- One exported prompt: `What are common agent architectures?`
- An aimock script that calls `searchCorpus`, calls `readDoc`, and replies with the cited fixture answer already used by `server/test/research.test.ts`.
- HTML escaping of route/tool source and test output.
- A file tree containing the exact generated paths:
  `server/src/app/research/index.ts`, `server/src/app/research/state.ts`,
  `server/src/app/research/plan.md`, `server/src/tools/searchCorpus.ts`, and
  `server/test/research.test.ts`.
- Log normalization that replaces only the generated temporary root with
  `<workspace>`, strips ANSI, and replaces duration fields such as `143ms` or
  `1.27s` with `<time>`.
- Preservation of test names, PASS/FAIL text, commands, and all non-duration
  numeric output.
- Child cleanup that sends `SIGTERM`, waits, and escalates only the known child
  PID to `SIGKILL` after a bounded timeout.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test docs/brand/demo/demo.test.mjs`

Expected: FAIL because the new modules do not exist.

- [ ] **Step 3: Implement the fixture and narrow normalization policy**

Build the fixture with `script()` from `packages/testing/dist/index.js`. Do not
add fixture behavior to the scaffold or Workbench. Export pure functions from
the normalizer so tests do not spawn commands.

- [ ] **Step 4: Implement the capture-only HTML stage**

`renderStage({ act, tree, primarySource, secondarySource, testLog })` returns a
complete HTML document with three possible acts:

- `author`: Dawn-branded file tree and exact generated route/tool source.
- `test`: Dawn-branded terminal chrome and normalized real `npm test` output.
- `close`: category, headline, and scaffold command.

Use plain escaped `<pre><code>` output and CSS; do not add Monaco, xterm, Shiki,
or another application dependency.

- [ ] **Step 5: Implement bounded process helpers**

Provide `spawnManaged()`, `waitForHttp()`, and `stopManaged()` with injected
spawn/fetch/timers for unit tests. Reject on early exit or readiness timeout.

- [ ] **Step 6: Run the tests**

Run: `pnpm build && node --test docs/brand/demo/demo.test.mjs`

Expected: PASS.

- [ ] **Step 7: Add artifact ignores and commit**

Add:

```gitignore
docs/brand/demo/artifacts/
docs/brand/demo/raw-recordings/
```

Commit:

```bash
git add .gitignore docs/brand/demo
git commit -m "feat(brand): add deterministic demo capture primitives"
```

---

### Task 3: Orchestrate the real scaffold, test, and Workbench capture

**Files:**
- Create: `docs/brand/demo/capture.mjs`
- Extend tests: `docs/brand/demo/demo.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing orchestration tests with injected command/process adapters**

Assert this order and cleanup behavior:

```text
check toolchain -> build -> scaffold --mode internal -> install -> npm test
-> start aimock -> start Dawn server with aimock env -> start Workbench
-> record author -> record test -> run Workbench scenario -> reload -> record run
-> record close -> stop all children -> remove temporary workspace
```

Assert the child server receives these exact model/telemetry overrides on top of
a sanitized inherited operational environment:

```js
{
  OPENAI_BASE_URL: aimock.baseUrl,
  OPENAI_API_KEY: "test-not-used",
  COPILOTKIT_TELEMETRY_DISABLED: "true",
  DO_NOT_TRACK: "1",
}
```

Assert `OPENAI_BASE_URL` starts with loopback and reject any capture whose model
base URL resolves to a public host. Preserve only environment needed to run the
local toolchain (for example `PATH`, package-manager configuration, locale, and
temporary-directory settings); remove provider API keys and provider base URLs
before applying the four overrides. Test that representative OpenAI, Anthropic,
Google, and AWS provider credentials from the parent are absent in children.

Test port assignment by asking the OS for free loopback ports. If either chosen
port loses a bind race, retry that service with a newly assigned port up to three
times; never silently fall back to the scaffold defaults `3002` or `3010`.

- [ ] **Step 2: Run the orchestration tests and verify they fail**

Run: `node --test docs/brand/demo/demo.test.mjs`

Expected: FAIL because `capture.mjs` is missing.

- [ ] **Step 3: Implement the orchestration entry point**

Use `mkdtemp()` for the workspace. Invoke the local scaffold exactly as the
existing GIF builder does, but with the research template and current workspace
shape:

```bash
node packages/create-dawn-app/dist/bin.js <tmp>/my-agent --mode internal
```

Run all generated-app commands from `<tmp>/my-agent`. Save raw test output in
the ignored artifact directory; send only normalized output to the compositor.

Start aimock in the parent process with the scenario fixture. Spawn the Dawn
server with its URL/key environment and the Workbench with telemetry disabled.
Use a `node:net` helper in `processes.mjs` to obtain distinct loopback ports,
then launch the generated server with
`npm exec -- dawn dev --port <serverPort>` from `server/` and the generated
Workbench with
`npm exec -- next dev --hostname 127.0.0.1 -p <workbenchPort>` from `web/`.
Pass `DAWN_SERVER_URL=http://127.0.0.1:<serverPort>` to the Workbench. Retry only
an `EADDRINUSE` startup failure, up to three assigned ports per service.

- [ ] **Step 4: Record exact Playwright scene assertions**

At 1440x810:

- Author: capture the compositor after it contains all five generated paths and
  the literal `export default agent({` plus `searchCorpus`.
- Test: capture only after the command exits `0` and the log contains the named
  research scenario plus a passing summary.
- Workbench: submit the canonical prompt; wait for visible `searchCorpus`,
  `readDoc`, and the cited final answer.
- Restoration derivative: store the active thread id, reload the page, select
  the same rail row, observe a successful `GET /api/dawn/threads/<id>/state`,
  and wait for the cited answer to reappear before recording.
- Close: capture the static compositor end card.

Do not claim a Dawn server restart in the restoration scene.

- [ ] **Step 5: Add the capture script**

Add to root `package.json`:

```json
"media:readme:capture": "node docs/brand/demo/capture.mjs"
```

- [ ] **Step 6: Run unit tests, then one local smoke capture**

Run:

```bash
pnpm build
node --test docs/brand/demo/demo.test.mjs
pnpm media:readme:capture -- --record-only
```

Expected: unit tests PASS; raw recordings and a capture summary appear only
under the ignored artifact directories; no live-provider request occurs.

- [ ] **Step 7: Commit**

```bash
git add package.json docs/brand/demo/capture.mjs docs/brand/demo/demo.test.mjs
git commit -m "feat(brand): capture the Dawn product loop"
```

---

### Task 4: Encode, validate, and document media outputs

**Files:**
- Create: `docs/brand/demo/encode.mjs`
- Create: `docs/brand/demo/check-media.mjs`
- Create: `docs/brand/demo/transcript.md`
- Create generated: `docs/brand/product-loop.gif`
- Create generated: `apps/web/public/demo/*-poster.webp`
- Modify: `docs/brand/README.md`
- Modify: `docs/brand/recording-guide.md`
- Modify: `package.json`
- Delete after pass: old VHS files listed in File structure

- [ ] **Step 1: Write failing media-contract tests**

Extend `demo.test.mjs` so the checker rejects:

- Wrong dimensions or aspect ratio.
- Flagship duration outside 20-30 seconds.
- Derivative duration outside 8-12 seconds.
- GIF over 4 MB or MP4/WebM over 2 MB per file.
- Missing poster/transcript.
- A caption that claims scaffolding occurs in the footage.
- Missing H.264 MP4 or VP9 WebM codec.

Use injected ffprobe output for unit tests.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test docs/brand/demo/demo.test.mjs`

Expected: FAIL because encoder/checker modules do not exist.

- [ ] **Step 3: Implement the ffmpeg encoder**

Create four timelines from the raw scenes:

- `product-loop`: author -> test -> Workbench -> close.
- `author`: author only.
- `test`: test only.
- `run`: completed Workbench run -> reload -> restored transcript.

Generate MP4, WebM, and a WebP poster for each. Generate only one GIF, from the
flagship. Use 30 fps and 16:9 output; preserve legible code at README width.

- [ ] **Step 4: Implement local validation**

`check-media.mjs --local` reads ffprobe JSON, file sizes, transcript, and
posters. It prints one PASS line per contract and exits nonzero on any failure.

Add the root command before invoking it:

```json
"media:readme:check": "node docs/brand/demo/check-media.mjs"
```

- [ ] **Step 5: Write the exact transcript and regeneration docs**

The transcript must name the generated paths, the `npm test` action, the two
tool calls, and the browser-reload restoration. Replace the manual guide with:

```bash
pnpm media:readme:capture
pnpm media:readme:check -- --local
```

Document prerequisites and the narrow test-log normalization. Document that
the Workbench itself has no demo/fixture mode.

- [ ] **Step 6: Generate and inspect assets**

Run:

```bash
pnpm media:readme:capture
pnpm media:readme:check -- --local
```

Use local image/video inspection at desktop and reduced widths. Confirm exact
caption/transcript correspondence.

- [ ] **Step 7: Remove the replaced VHS implementation**

Delete only after the new GIF exists and local media checks pass:

```text
docs/brand/build-gif.sh
docs/brand/capture-fixture.mjs
docs/brand/quickstart-fixture.json
docs/brand/quickstart.tape
docs/brand/quickstart.gif
docs/brand/stub-openai.mjs
```

- [ ] **Step 8: Commit generated small assets and sources**

Do not commit raw recordings or MP4/WebM:

```bash
git add package.json docs/brand apps/web/public/demo .gitignore
git commit -m "docs(brand): publish reproducible product-loop assets"
```

---

### Task 5: Publish full video assets and record the verified catalog

**Files:**
- Create: `docs/brand/demo/upload.mjs`
- Create after upload: `apps/web/app/lib/demo-media.json`
- Extend tests: `docs/brand/demo/demo.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing upload/manifest tests**

With injected `fetch`, require stable, suffix-free pathnames:

```text
demo/product-loop.mp4
demo/product-loop.webm
demo/author.mp4
demo/author.webm
demo/test.mp4
demo/test.webm
demo/run.mp4
demo/run.webm
```

Require every catalog entry to contain `mp4`, `webm`, `poster`, `caption`,
`ariaLabel`, and `transcript`. Require HEAD verification of `200`,
`video/mp4`, and `video/webm` before writing the catalog.

- [ ] **Step 2: Run tests and verify they fail**

Run: `node --test docs/brand/demo/demo.test.mjs`

Expected: FAIL because upload/manifest support is missing.

- [ ] **Step 3: Implement dry-run-first upload support**

`upload.mjs` must:

- Default to `--dry-run`.
- Require `--apply` and `BLOB_READ_WRITE_TOKEN` for mutation.
- Require `DAWN_MEDIA_PUBLIC_BASE_URL` so the public store hostname is explicit.
- Upload with stable pathnames and no random suffix.
- Verify every URL and content type.
- Write `apps/web/app/lib/demo-media.json` only after all files verify.
- Never print the token.

Add the root command:

```json
"media:readme:upload": "node docs/brand/demo/upload.mjs"
```

- [ ] **Step 4: Run dry-run and tests**

Run:

```bash
node --test docs/brand/demo/demo.test.mjs
node docs/brand/demo/upload.mjs --dry-run
```

Expected: PASS; no remote mutation; planned paths and local source files shown.

- [ ] **Step 5: Stop and obtain explicit authorization for the upload**

Present the exact store, public base URL, eight remote paths, and overwrite
behavior. Do not continue to `--apply` until authorized.

- [ ] **Step 6: Apply the authorized upload and verify**

Run only after authorization:

```bash
BLOB_READ_WRITE_TOKEN=<in-environment-secret> \
DAWN_MEDIA_PUBLIC_BASE_URL=<verified-public-base> \
pnpm media:readme:upload -- --apply
pnpm media:readme:check -- --remote
```

Expected: all eight URLs return `200` with the expected video content type;
`apps/web/app/lib/demo-media.json` is written with no secrets.

- [ ] **Step 7: Commit the uploader and verified catalog**

```bash
git add package.json docs/brand/demo/upload.mjs docs/brand/demo/demo.test.mjs apps/web/app/lib/demo-media.json
git commit -m "build(brand): verify hosted demo media"
```

---

### Task 6: Rewrite the root GitHub README around the product loop

**Files:**
- Modify: `README.md`
- Modify if new claims appear: `docs/brand/demo/evidence-matrix.md`
- Test: `scripts/readme-contracts.test.mjs`

- [ ] **Step 1: Add a failing full-root fixture test**

Add a test that reads the actual root `README.md` and expects zero
`validateRootReadme()` failures.

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test scripts/readme-contracts.test.mjs`

Expected: FAIL on missing section order, product-loop asset, transcript, and
canonical first activation.

- [ ] **Step 3: Replace the hero and first-scroll content**

Use this exact hierarchy and opening copy:

```md
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/dawn-logo-horizontal-white-on-black.png">
    <img src="docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="360">
  </picture>
</p>

<p align="center"><strong>TypeScript meta-framework for LangGraph.js</strong></p>

# Build LangGraph agents like Next.js apps.

Dawn adds file-system routes, shared and route-local tools, generated types,
deterministic tests, durable threads, and build targets around LangGraph.js.
Keep the runtime. Drop the boilerplate.
```

Put the canonical command before the animation:

```bash
npm create dawn-ai-app@latest my-agent
```

Use four links: Get started, Migrate from LangGraph.js, Documentation, and
Discussions. Keep at most five badges: npm version for `create-dawn-ai-app`, CI,
MIT, GitHub stars, and OpenSSF Scorecard.

Embed `docs/brand/product-loop.gif` with alt text that says the animation shows
an existing generated research workspace, a deterministic test, and the Dawn
Workbench. Link the image to `https://dawnai.org/#product-loop`; link the
transcript separately.

- [ ] **Step 4: Write the no-key Quickstart before the feature inventory**

Use:

```bash
npm create dawn-ai-app@latest my-agent
cd my-agent
npm install
npm test
```

State only the clean-room-observed result. Keep live-provider setup in the later
`Run it live` section.

- [ ] **Step 5: Replace the body with the approved information architecture**

Before retaining any material sentence, match it to a `keep` or `qualify` row
in `docs/brand/demo/evidence-matrix.md`; apply the recorded condition in prose.
Delete claims marked `remove`. If implementation reveals a new material claim,
add and resolve its matrix row in the same commit.

Write these exact sections in order:

- `## Why Dawn` — four outcome-first pillars.
- `## How Dawn fits` — compact table for LangChain, LangGraph.js, Dawn, and
  deployment/observability choices.
- `## What Dawn writes for you` — authored-versus-generated table; link the full
  migration guide; no line-count claim.
- `## What are you building?` — research example, chat/workspace example, memory
  example, and routes/workflows guide.
- `## When Dawn fits` — fit, raw-LangGraph non-fit, and ecosystem compatibility.
- `## Build with a coding agent` — collapsible prompt using the current
  `https://dawnai.org/AGENTS.md` and `https://dawnai.org/llms-full.txt` guidance.
- `## Run it live` — provider key, server, Workbench, Agent Protocol, build, and
  deployment links.
- `## Maturity and support` — pre-1.0, releases, support, security, contribution,
  discussions, and code of conduct.
- Final scaffold CTA and License.

Move the long raw-LangGraph sample out of the early path; link the migration
guide instead of duplicating it.

- [ ] **Step 6: Run root README checks**

Run:

```bash
node --test scripts/readme-contracts.test.mjs
node scripts/check-docs.mjs
```

Expected: root contract and the pre-existing docs check PASS. Package contracts
are still exercised only by their generic fixtures until Tasks 7-9 add
actual-file coverage.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/brand/demo/evidence-matrix.md scripts/readme-contracts.test.mjs
git commit -m "docs(readme): lead with the Dawn product loop"
```

---

### Task 7: Rewrite the three npm entry-point READMEs

**Files:**
- Modify: `packages/create-dawn-app/README.md`
- Modify: `packages/sdk/README.md`
- Modify: `packages/cli/README.md`
- Test: `scripts/readme-contracts.test.mjs`

- [ ] **Step 1: Add failing entry-tier actual-file tests**

Read each actual manifest/README and call `validatePackageReadme({ tier:
"entry", ... })`. Expected initial failures include missing product-loop image,
`Use this when`, related packages, and maturity/support.

- [ ] **Step 2: Run tests and verify they fail**

Run: `node --test scripts/readme-contracts.test.mjs`

- [ ] **Step 3: Apply the entry README template**

Each file receives:

```md
<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180">
</p>

# PACKAGE_NAME

PURPOSE

**Use this when:** PACKAGE_SPECIFIC_DECISION.

<p align="center">
  <a href="https://dawnai.org/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif" alt="Dawn product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>

## Install
## Example
## Runtime and stability
## Related
## Maturity and support
## License
```

Use these package decisions/examples:

| Package | Use this when | Example |
| --- | --- | --- |
| `create-dawn-ai-app` | Starting a new Dawn application from a supported template | Canonical scaffold + `cd` + `npm install` + `npm test`; list research default and basic optional template |
| `@dawn-ai/sdk` | Authoring routes, tools, middleware, memory declarations, or typed runtime contracts | Current `agent`, `defineMemory`, `defineMiddleware` import plus a minimal `agent()` route |
| `@dawn-ai/cli` | Developing, checking, testing, building, serving, or embedding a Dawn runtime | `pnpm exec dawn dev`, `dawn check`, `dawn build`, and the existing `serveRuntime` import boundary |

The maturity paragraph is identical in meaning, not necessarily byte-for-byte:
Dawn is pre-1.0, package versions release as a fixed group, and users should
review the changelog when upgrading.

- [ ] **Step 4: Run entry tests**

Run: `node --test scripts/readme-contracts.test.mjs`

Expected: entry-tier actual files and the generic contract fixtures PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/create-dawn-app/README.md packages/sdk/README.md packages/cli/README.md scripts/readme-contracts.test.mjs
git commit -m "docs(packages): rebuild npm entry-point READMEs"
```

---

### Task 8: Tighten the eleven capability READMEs

**Files:**
- Modify: `packages/ag-ui/README.md`
- Modify: `packages/evals/README.md`
- Modify: `packages/inspector/README.md`
- Modify: `packages/memory/README.md`
- Modify: `packages/memory-pgvector/README.md`
- Modify: `packages/permissions/README.md`
- Modify: `packages/postgres-storage/README.md`
- Modify: `packages/sandbox/README.md`
- Modify: `packages/sqlite-storage/README.md`
- Modify: `packages/testing/README.md`
- Modify: `packages/workspace/README.md`
- Test: `scripts/readme-contracts.test.mjs`

- [ ] **Step 1: Add failing capability-tier actual-file tests**

Load the 11 manifests/READMEs and expect no contract failures. Run once and
record the missing sections per file.

- [ ] **Step 2: Add the common capability structure without deleting useful depth**

Every file gets `Use this when`, `## Install`, `## Example`, `## Runtime and
stability`, `## Related`, `## Maturity and support`, and `## License`.

Preserve the detailed AG-UI customization ladder, memory safety notes, Postgres
lifecycle caveats, and testing concurrency warning. The task tightens entry and
navigation; it does not flatten accurate package-specific documentation.

- [ ] **Step 3: Use these exact decision/example anchors**

| Package | Use this when | Example anchor |
| --- | --- | --- |
| `@dawn-ai/ag-ui` | Translating Dawn runs or activities to AG-UI clients | Existing `fromRunAgentInput`, `toAguiEvents`, and `/sse`; keep React renderers |
| `@dawn-ai/evals` | Defining repeatable evaluations, scorers, or release gates | Existing `contains`, `defineEval`, `gate`, `runEval` |
| `@dawn-ai/inspector` | Running the browser inspector for memory/runtime review | `pnpm exec dawn inspect`; state that the package is launched, not imported |
| `@dawn-ai/memory` | Accessing stores/ranking directly instead of only `defineMemory()` | Existing `sqliteMemoryStore` plus supported subpaths |
| `@dawn-ai/memory-pgvector` | Sharing vector memory across instances | Existing `pgvectorMemoryStore` and `pg` peer requirement |
| `@dawn-ai/permissions` | Building permission matching or approval-store integrations | Existing `matchPermission` and root/Node boundaries |
| `@dawn-ai/postgres-storage` | Replacing local durable stores with shared Postgres | Existing `createPostgresThreadsStore`; retain pool ownership caveat |
| `@dawn-ai/sandbox` | Isolating workspace filesystem/shell execution | Existing `dockerSandbox` and `fakeSandbox` |
| `@dawn-ai/sqlite-storage` | Using Dawn's local checkpoint/thread persistence directly | Existing `createThreadsStore`, `sqliteCheckpointer` |
| `@dawn-ai/testing` | Testing agent behavior without live model calls | Existing `createAgentHarness`, `script`, `expectFinalMessage` |
| `@dawn-ai/workspace` | Supplying filesystem/shell backends or workspace tools | Existing `compose`, `FilesystemBackend`, `localFilesystem` |

- [ ] **Step 4: Add Related and maturity links**

Related sections link only to real package/docs relationships. Do not place the
campaign GIF in these files. Use the current package-specific API and guide URLs.

- [ ] **Step 5: Run tests and docs checks**

Run:

```bash
node --test scripts/readme-contracts.test.mjs
node scripts/check-docs.mjs
```

Expected: entry and capability actual-file contracts plus the existing docs
check PASS. Tooling actual-file coverage is added in Task 9.

- [ ] **Step 6: Commit**

```bash
git add packages/ag-ui/README.md packages/evals/README.md packages/inspector/README.md packages/memory/README.md packages/memory-pgvector/README.md packages/permissions/README.md packages/postgres-storage/README.md packages/sandbox/README.md packages/sqlite-storage/README.md packages/testing/README.md packages/workspace/README.md scripts/readme-contracts.test.mjs
git commit -m "docs(packages): tighten capability READMEs"
```

---

### Task 9: Tighten the seven adapter/tooling READMEs

**Files:**
- Modify: `packages/core/README.md`
- Modify: `packages/langchain/README.md`
- Modify: `packages/langgraph/README.md`
- Modify: `packages/vite-plugin/README.md`
- Modify: `packages/devkit/README.md`
- Modify: `packages/config-biome/README.md`
- Modify: `packages/config-typescript/README.md`
- Test: `scripts/readme-contracts.test.mjs`

- [ ] **Step 1: Add failing tooling-tier actual-file tests**

Run the actual READMEs through the tooling contract and observe the missing
`Use this when`, installation/configuration, related, and maturity sections.

- [ ] **Step 2: Apply the tooling structure and boundary copy**

Use these anchors:

| Package | Use this when | Example/boundary |
| --- | --- | --- |
| `@dawn-ai/core` | Building Dawn integrations or tooling below the author SDK | Existing `config`, `renderDawnTypes`; direct route authors use SDK |
| `@dawn-ai/langchain` | Materializing or extending Dawn's LangChain agent/chain bridge | Existing `chainAdapter`, `openaiEmbedder`; retain edge-safe boundary |
| `@dawn-ai/langgraph` | Integrating raw graphs/workflows with Dawn route contracts | Existing `defineEntry`, `graphAdapter`; list supported subpaths |
| `@dawn-ai/vite-plugin` | Working on Dawn's type-generation pipeline | Existing default `dawn` import; state internal/node-only boundary |
| `@dawn-ai/devkit` | Working on Dawn scaffold templates or generator tests | Existing `resolveTemplateDir`; state internal/node-only boundary |
| `@dawn-ai/config-biome` | Extending Dawn's internal/shared Biome configuration | Install as dev dependency and show `extends`/config path usage |
| `@dawn-ai/config-typescript` | Extending Dawn's shared TypeScript configurations | Install as dev dependency and show an `extends` example |

Configuration packages use `## Configuration` instead of `## Example`; the
validator accepts that explicit alternative.

- [ ] **Step 3: Run all README contracts**

Run:

```bash
node --test scripts/readme-contracts.test.mjs
node scripts/check-docs.mjs
```

Expected: all 21 README actual-file contracts and the existing docs check PASS.
Manifest actual-file coverage and repository-wide wiring are added in Task 10.

- [ ] **Step 4: Commit**

```bash
git add packages/core/README.md packages/langchain/README.md packages/langgraph/README.md packages/vite-plugin/README.md packages/devkit/README.md packages/config-biome/README.md packages/config-typescript/README.md scripts/readme-contracts.test.mjs
git commit -m "docs(packages): clarify adapter and tooling READMEs"
```

---

### Task 10: Complete npm discovery metadata and changeset

**Files:**
- Modify: all 21 public `packages/*/package.json`
- Modify: `scripts/check-docs.mjs`
- Modify: `scripts/lib/published-artifacts.mjs`
- Modify tests: `scripts/readme-contracts.test.mjs`, `scripts/published-artifacts.test.mjs`
- Create: `.changeset/<generated-name>.md`

- [ ] **Step 1: Add actual-manifest tests**

Read the release-inventory public manifests and assert zero metadata failures.
Run once; expect 20 missing descriptions and 21 missing keyword arrays.

- [ ] **Step 2: Add exact descriptions and focused keywords**

Use this table verbatim unless implementation evidence disproves a phrase:

| Package | Description | Keywords |
| --- | --- | --- |
| `@dawn-ai/ag-ui` | AG-UI protocol adapters for streaming Dawn agent runs to compatible clients. | `dawn`, `typescript`, `langgraph`, `ag-ui`, `ai-agents`, `streaming` |
| `@dawn-ai/cli` | Command-line development, testing, build, and runtime tools for Dawn applications. | `dawn`, `typescript`, `langgraph`, `cli`, `ai-agents`, `developer-tools` |
| `@dawn-ai/config-biome` | Shared Biome configuration for Dawn TypeScript workspace packages. | `dawn`, `biome`, `linting`, `formatting`, `typescript`, `configuration` |
| `@dawn-ai/config-typescript` | Shared TypeScript compiler configurations for Dawn packages and applications. | `dawn`, `typescript`, `tsconfig`, `configuration`, `nodejs`, `nextjs` |
| `@dawn-ai/core` | Low-level Dawn APIs for route discovery, configuration, state resolution, and type generation. | `dawn`, `typescript`, `langgraph`, `ai-agents`, `routing`, `type-generation` |
| `create-dawn-ai-app` | Scaffold a Dawn TypeScript agent application with supported starter templates. | `dawn`, `typescript`, `langgraph`, `ai-agents`, `scaffolding`, `create-app` |
| `@dawn-ai/devkit` | Scaffold templates and development utilities shared by Dawn tooling. | `dawn`, `typescript`, `scaffolding`, `templates`, `developer-tools` |
| `@dawn-ai/evals` | Evaluation definitions, scorers, datasets, and runners for Dawn agents. | `dawn`, `typescript`, `ai-agents`, `evals`, `testing`, `llm` |
| `@dawn-ai/inspector` | Browser inspector for reviewing memory and runtime state in a Dawn application. | `dawn`, `typescript`, `ai-agents`, `inspector`, `memory`, `developer-tools` |
| `@dawn-ai/langchain` | LangChain adapters for Dawn agents, chains, tools, streaming, embeddings, and retry. | `dawn`, `typescript`, `langchain`, `langgraph`, `ai-agents`, `streaming` |
| `@dawn-ai/langgraph` | LangGraph.js adapters and route contracts for Dawn agents, workflows, and graphs. | `dawn`, `typescript`, `langgraph`, `langgraphjs`, `ai-agents`, `workflows` |
| `@dawn-ai/memory` | Long-term memory storage, ranking, recall, and distillation primitives for Dawn agents. | `dawn`, `typescript`, `ai-agents`, `memory`, `retrieval`, `llm` |
| `@dawn-ai/memory-pgvector` | Postgres and pgvector storage for shared Dawn agent memory and vector retrieval. | `dawn`, `typescript`, `ai-agents`, `memory`, `postgres`, `pgvector` |
| `@dawn-ai/permissions` | Permission matching, approval gates, and access-control stores for Dawn agents. | `dawn`, `typescript`, `ai-agents`, `permissions`, `access-control`, `human-in-the-loop` |
| `@dawn-ai/postgres-storage` | Postgres persistence for Dawn checkpoints, threads, and permission decisions. | `dawn`, `typescript`, `langgraph`, `postgres`, `persistence`, `ai-agents` |
| `@dawn-ai/sandbox` | Docker and Kubernetes sandbox providers for isolated Dawn workspace execution. | `dawn`, `typescript`, `ai-agents`, `sandbox`, `docker`, `kubernetes` |
| `@dawn-ai/sdk` | Author-facing TypeScript SDK for defining Dawn agents, tools, middleware, memory, and routes. | `dawn`, `typescript`, `langgraph`, `ai-agents`, `sdk`, `agent-framework` |
| `@dawn-ai/sqlite-storage` | SQLite persistence for Dawn checkpoints, Agent Protocol threads, and local state. | `dawn`, `typescript`, `langgraph`, `sqlite`, `persistence`, `ai-agents` |
| `@dawn-ai/testing` | Deterministic harnesses, fixtures, and matchers for testing Dawn agent applications. | `dawn`, `typescript`, `ai-agents`, `testing`, `fixtures`, `llm` |
| `@dawn-ai/vite-plugin` | Vite integration for Dawn route discovery and generated TypeScript types. | `dawn`, `typescript`, `vite`, `langgraph`, `type-generation`, `developer-tools` |
| `@dawn-ai/workspace` | Filesystem and shell workspace contracts and tools for Dawn agent applications. | `dawn`, `typescript`, `ai-agents`, `filesystem`, `shell`, `developer-tools` |

- [ ] **Step 3: Add the patch changeset**

Name all 21 public packages as `patch`. Body:

```md
Refresh the GitHub and npm documentation surfaces, add package discovery
metadata, and introduce reproducible product-loop media. No runtime API changed.
```

- [ ] **Step 4: Wire the now-satisfied contracts into repository checks**

In `scripts/check-docs.mjs`, use the same public manifest set already traversed
by `packageManifests()`. Resolve each package through the tested tier map, read
its README, run `validatePackageReadme()`, and run
`validatePackageDiscoveryMetadata()`. Run `validateRootReadme()` against the
repository root. Report package/file context for every failure.

Extend `validatePackageMetadata()` in
`scripts/lib/published-artifacts.mjs` to require `description` and `keywords`;
reuse `validatePackageDiscoveryMetadata()` rather than copying its grammar. Add
positive and negative fixture cases to `scripts/published-artifacts.test.mjs`.

- [ ] **Step 5: Run metadata, docs, and pack tests**

Run:

```bash
node --test scripts/readme-contracts.test.mjs scripts/published-artifacts.test.mjs
node scripts/check-docs.mjs
pnpm pack:check
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/*/package.json scripts/check-docs.mjs scripts/lib/published-artifacts.mjs scripts/readme-contracts.test.mjs scripts/published-artifacts.test.mjs .changeset
git commit -m "docs(packages): add npm discovery metadata"
```

---

### Task 11: Build the typed homepage media primitives with TDD

**Files:**
- Create: `apps/web/app/lib/demo-media.ts`
- Create: `apps/web/app/lib/demo-media.test.ts`
- Create: `apps/web/app/components/ui/ClipPlayer.tsx`
- Create: `apps/web/app/components/ui/ClipPlayer.test.tsx`
- Create: `apps/web/app/components/landing/MediaSwitcher.tsx`
- Create: `apps/web/app/components/landing/MediaSwitcher.test.tsx`
- Modify: `apps/web/vitest.config.ts`
- Modify: `apps/web/package.json`

- [ ] **Step 1: Enable focused TSX/jsdom tests**

Update the Vitest include to `app/**/*.test.{ts,tsx}` and add `jsdom` to the web
package dev dependencies. Use `// @vitest-environment jsdom` only on component
tests; keep catalog tests in Node.

- [ ] **Step 2: Write failing catalog tests**

Import `demo-media.json` through `demo-media.ts` and assert exact keys:
`productLoop`, `author`, `test`, `run`. For each entry assert HTTPS MP4/WebM,
local `/demo/*.webp` poster, nonempty caption/ARIA label, and transcript URL.

- [ ] **Step 3: Write failing player tests**

With React DOM and mocked `matchMedia`, prove:

- Normal motion mounts one `<video>` with WebM first, MP4 second, poster,
  `muted`, `playsInline`, and no server-rendered `autoplay` attribute.
- An effect calls `play()` for normal motion.
- Reduced motion does not call `play()` and shows an explicit Play button.
- Clicking Play calls `play()`.
- Video error removes the video and leaves the poster plus transcript link.

- [ ] **Step 4: Write failing switcher tests**

Prove Video is selected initially; only the selected panel exists; click,
ArrowLeft/ArrowRight, Home, and End update `aria-selected`, focus, and mounted
content.

- [ ] **Step 5: Run tests and verify they fail**

Run: `pnpm --filter @dawn-ai/web test`

Expected: FAIL because the components/modules are missing.

- [ ] **Step 6: Implement the typed catalog**

Export:

```ts
export interface DemoClip {
  readonly mp4: string
  readonly webm: string
  readonly poster: string
  readonly caption: string
  readonly ariaLabel: string
  readonly transcript: string
}

export const demoMedia: Readonly<Record<"productLoop" | "author" | "test" | "run", DemoClip>>
```

Validate the imported JSON shape before exporting; throw during build on drift.

- [ ] **Step 7: Implement player and switcher minimally**

Use an effect-driven `video.play()` instead of the `autoPlay` attribute so
reduced-motion users never receive autoplay markup before hydration. Handle
rejected `play()` promises without replacing the poster/code fallback.

Switcher tabs own roving focus and render exactly one panel.

- [ ] **Step 8: Run web tests, typecheck, and lint**

Run:

```bash
pnpm --filter @dawn-ai/web test
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web lint
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/package.json apps/web/vitest.config.ts apps/web/app/lib/demo-media.ts apps/web/app/lib/demo-media.test.ts apps/web/app/components/ui/ClipPlayer.tsx apps/web/app/components/ui/ClipPlayer.test.tsx apps/web/app/components/landing/MediaSwitcher.tsx apps/web/app/components/landing/MediaSwitcher.test.tsx pnpm-lock.yaml
git commit -m "feat(web): add accessible demo media primitives"
```

---

### Task 12: Integrate the flagship video into the homepage hero

**Files:**
- Modify: `apps/web/app/components/landing/Hero.tsx`
- Extend: `apps/web/app/components/landing/MediaSwitcher.test.tsx`
- Modify if needed: `apps/web/app/page.tsx`

- [ ] **Step 1: Add a failing hero source/render contract**

Assert the hero uses `demoMedia.productLoop`, labels the tabs `Video` and
`Code`, preserves the current `ROUTE_CODE`, keeps the scaffold and coding-agent
buttons, and owns or is wrapped by `id="product-loop"`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter @dawn-ai/web test`

- [ ] **Step 3: Replace only the hero's right-column visual**

Keep the existing left copy/CTA hierarchy. Pass:

- Video pane: `ClipPlayer` with `demoMedia.productLoop`.
- Code pane: the existing highlighted route inside `CodeFrame`.

Video is the initial pane. Add a visible caption and transcript link below the
player without duplicating the caption inside the player.

- [ ] **Step 4: Verify hero behavior and layout**

Run web tests/typecheck/lint, then render the homepage at 320 px, 768 px, and
desktop. Confirm the product-loop anchor, video/code switcher, command, and copy
remain legible.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/landing/Hero.tsx apps/web/app/components/landing/MediaSwitcher.test.tsx apps/web/app/page.tsx
git commit -m "feat(web): lead the homepage with the Dawn product loop"
```

---

### Task 13: Add the three proof clips to existing homepage sections

**Files:**
- Modify: `apps/web/app/components/landing/FeatureRouting.tsx`
- Modify: `apps/web/app/components/landing/FeatureDevLoop.tsx`
- Modify: `apps/web/app/components/landing/DurableByDefault.tsx`
- Extend: `apps/web/app/lib/demo-media.test.ts`

- [ ] **Step 1: Add failing section-media ownership tests**

Assert one and only one homepage owner for each clip:

```text
author -> FeatureRouting
test   -> FeatureDevLoop
run    -> DurableByDefault
```

Assert the Run caption says browser reload/checkpoint restoration and never
claims the clip shows a Dawn server restart.

- [ ] **Step 2: Run tests and verify they fail**

Run: `pnpm --filter @dawn-ai/web test`

- [ ] **Step 3: Integrate Author and Test as Video/Code alternatives**

- `FeatureRouting`: Video defaults to `demoMedia.author`; Code retains the
  existing route/state frame.
- `FeatureDevLoop`: Video defaults to `demoMedia.test`; Code/Terminal retains
  `DevLoopAnimation` with the tab label `Dev loop`.

Only the selected pane mounts.

- [ ] **Step 4: Integrate Run into durability**

Place `ClipPlayer(demoMedia.run)` below the existing durability copy/payoff
grid. Keep the text claim that threads survive `dawn dev` restarts, but make the
clip caption narrower: it demonstrates browser reload and checkpoint-backed
transcript restoration.

- [ ] **Step 5: Run targeted tests and visual checks**

Run:

```bash
pnpm --filter @dawn-ai/web test
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web build
```

Inspect light/dark, reduced motion, mobile, tablet, and desktop. Confirm only
the active hero/feature videos are present in the DOM.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/components/landing/FeatureRouting.tsx apps/web/app/components/landing/FeatureDevLoop.tsx apps/web/app/components/landing/DurableByDefault.tsx apps/web/app/lib/demo-media.test.ts
git commit -m "feat(web): add product proof clips to the homepage"
```

---

### Task 14: Clean-room activation, GFM/npm rendering, and final verification

**Files:**
- Modify: `docs/brand/demo/evidence-matrix.md` — record final clean-room evidence and any corrected disposition.
- Modify only if failures expose real drift in files already in scope.

- [ ] **Step 1: Verify toolchain and clean worktree intent**

Run:

```bash
node --version
pnpm --version
git status --short
```

Expected: Node 24+, pnpm 10.33.0, only intended changes.

- [ ] **Step 2: Run the canonical clean-room quickstart**

From a fresh `mktemp -d` directory, run exactly:

```bash
npm create dawn-ai-app@latest my-agent
cd my-agent
npm install
npm test
```

Record the observed success text in the evidence matrix and confirm the root
README matches it. Do not use a globally linked local package for this published
command check. Separately run the local/internal scaffold capture path to prove
the pending branch assets.

- [ ] **Step 3: Validate media locally and remotely**

Run:

```bash
pnpm media:readme:check -- --local
pnpm media:readme:check -- --remote
```

Expected: all codec, size, duration, poster, transcript, URL, and content-type
contracts PASS.

- [ ] **Step 4: Render root and representative package READMEs**

Render GitHub Flavored Markdown for:

- Root `README.md`.
- `packages/create-dawn-app/README.md` (entry).
- `packages/testing/README.md` (capability).
- `packages/core/README.md` (tooling).
- `packages/config-typescript/README.md` (configuration).

Use GitHub's GFM renderer through the installed GitHub CLI, writing only to a
fresh temporary directory:

```bash
readme_render_dir="$(mktemp -d)"
gh auth status
gh api --method POST markdown -f mode=gfm -f context=cacheplane/dawnai -F text=@README.md > "$readme_render_dir/root.html"
gh api --method POST markdown -f mode=gfm -f context=cacheplane/dawnai -F text=@packages/create-dawn-app/README.md > "$readme_render_dir/create-dawn-ai-app.html"
gh api --method POST markdown -f mode=gfm -f context=cacheplane/dawnai -F text=@packages/testing/README.md > "$readme_render_dir/testing.html"
gh api --method POST markdown -f mode=gfm -f context=cacheplane/dawnai -F text=@packages/core/README.md > "$readme_render_dir/core.html"
gh api --method POST markdown -f mode=gfm -f context=cacheplane/dawnai -F text=@packages/config-typescript/README.md > "$readme_render_dir/config-typescript.html"
```

Expected: every request exits `0` and produces non-empty HTML. Open those exact
files in the browser; because the API returns an HTML fragment, inspect emitted
`href`/`src` attributes directly as well as the visual output.

Inspect image URLs, section hierarchy, code fences, `<details>`, and link targets
at narrow and desktop widths. Confirm npm-safe absolute image URLs in package
READMEs.

- [ ] **Step 5: Run targeted and repository verification**

Run in order:

```bash
node --test scripts/readme-contracts.test.mjs scripts/published-artifacts.test.mjs docs/brand/demo/demo.test.mjs
node scripts/check-docs.mjs
pnpm --filter @dawn-ai/web test
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web build
pnpm pack:check
pnpm ci:validate
```

Expected: all PASS. If the full lane is impractical, run every narrower command
and report the exact unrun gate; do not claim the full lane passed.

- [ ] **Step 6: Review final diff and claims**

Check:

- No unrelated changes.
- No provider-prefixed model IDs or banned phrases.
- No hard-coded popularity/version claims in prose.
- No caption says scaffolding is visible.
- No clip overstates browser reload as server restart.
- Every package description matches its README opening.
- Every public package is covered once by the release inventory/tier map.
- Changeset names the complete fixed group intended by the package edits.
- No secret, token, temp path, or local username appears in media or source.

- [ ] **Step 7: Commit any verification-only corrections**

```bash
git add <only-the-corrected-files>
git commit -m "docs: finish README awareness verification"
```

Skip this commit when verification required no correction.

---

## Execution checkpoints

- **Checkpoint A — after Task 4:** deterministic local assets exist and the old
  VHS pipeline is gone.
- **Authorization gate — Task 5:** user approves the exact remote upload.
- **Checkpoint B — after Task 10:** root GitHub and all npm surfaces pass docs,
  metadata, and pack contracts.
- **Checkpoint C — after Task 13:** homepage media is integrated and accessible.
- **Completion — Task 14:** clean-room activation, media, GFM, npm pack, web,
  and repository validation evidence is recorded.
