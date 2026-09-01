# Dawn README and video awareness system — design

**Date:** 2026-08-31  
**Status:** Approved in design review  
**Primary goal:** Developer awareness among TypeScript developers  
**Primary product proof:** A small TypeScript route becomes a tested, running Dawn application

## Summary

Dawn's GitHub README, 21 npm package READMEs, and website homepage will tell one
coordinated story:

> Build LangGraph agents like Next.js apps.

Dawn is the TypeScript meta-framework for LangGraph.js. The awareness campaign
will make that category concrete through a deterministic product loop:

1. Author a small file-system route and route-local tool.
2. Prove it with the scaffold's offline test path.
3. Run the same route in the shipped Dawn Workbench.

The campaign will use one reproducible media system to produce a flagship video,
three short proof clips, a GitHub-safe GIF, and posters. The root README remains
the primary GitHub surface. Package READMEs become precise npm entry points
rather than copies of the root README. The homepage uses the same assets and
lets visitors choose video or code in the hero.

## Problem

The current root README contains many correct facts, but its first proof is a
terminal GIF followed by a dense capability list and a long raw-LangGraph code
sample. A reader has to infer Dawn's product loop before seeing the shortest
activation path.

The npm surface is also incomplete:

- All 21 public packages publish a README, but their depth and structure vary.
- Twenty public package manifests omit `description` and `keywords`.
- Several packages correctly document low-level boundaries, but the suite does
  not present a consistent path back to the main Dawn experience.

The website already has strong positioning and a code-first hero, but it does
not show the product loop. Dawn also has two media systems that should be
retired together: a deterministic but terminal-only VHS GIF and a stale manual
Screen Studio recording guide based on an older scaffold.

## Goals

- Make a broad TypeScript developer understand Dawn's category and product loop
  within the first GitHub or homepage viewport.
- Put a current, no-key activation path before the detailed feature inventory.
- Use the actual generated Workbench as the browser product surface.
- Create one deterministic capture pipeline that can be recut without a live
  provider call or manual staging.
- Give every public npm package a useful, package-specific README and complete
  discovery metadata.
- Keep GitHub, npm, docs, and the homepage aligned on commands, terminology,
  route examples, and maturity.
- Produce reusable 16:9 media for GitHub, the homepage, and social distribution.

## Non-goals

- Building a separate marketing demo application.
- Repositioning Dawn as a replacement for LangGraph.js, LangChain, LangSmith,
  model providers, or a hosted AI platform.
- Creating vertical social cuts without a concrete channel plan.
- Adding website analytics, tracking pixels, or product telemetry.
- Publishing repository metadata, uploading media, or changing external
  services without the required authorization.
- Turning every npm README into a copy of the root README.
- Adding benchmark or code-reduction claims that are not generated from checked
  in evidence.

## Audience and message hierarchy

### Primary audience

TypeScript developers exploring agent development, including developers who do
not yet know enough LangGraph.js internals to appreciate an app-layer
boilerplate comparison.

### Secondary audience

Teams already using or evaluating LangGraph.js and looking for repeatable
application structure, development tooling, tests, durable threads, and
deployment conventions.

### Message order

1. **Category:** TypeScript meta-framework for LangGraph.js.
2. **Mental model:** Build LangGraph agents like Next.js apps.
3. **Product proof:** Route -> offline test -> running Workbench.
4. **Relationship:** Keep LangGraph as the runtime; Dawn supplies the
   application-framework layer.
5. **Activation:** Scaffold, install, and test before requiring a provider key.

The root README and homepage may use "Keep the runtime. Drop the boilerplate."
as supporting copy. Package READMEs should prefer literal package purpose over
campaign language after their opening context.

## Cross-surface architecture

```text
checked-in route + fixture + capture script
                  |
                  v
      generated research workspace
                  |
         +--------+--------+
         |                 |
    terminal capture   Workbench capture
         |                 |
         +--------+--------+
                  |
             ffmpeg encode
                  |
     +------------+-------------+
     |            |             |
 GitHub GIF   homepage video   poster/transcript
     |            |             |
 root README  website sections  accessibility/fallback
                  |
            short social cuts
```

One content source should not mean one identical rendering. GitHub receives a
compact animated proof and link. The homepage receives higher-quality video.
Package READMEs receive a small campaign thumbnail only when the package is a
primary entry point.

## Video system

### Flagship story

The flagship is a 20-30 second, silent 16:9 product-loop video with four beats:

1. **Author (6-8 seconds).** Show the real generated research workspace in an
   editor. The file tree exposes `src/app/research/`, `index.ts`, `tools/`, and
   the co-located test. The camera emphasizes one `agent()` descriptor and one
   route-local tool; it does not show installation output.
2. **Prove (5-7 seconds).** Run the canonical root `npm test` path and show the
   deterministic research scenario passing without an API key.
3. **Run (9-12 seconds).** Open the generated Dawn Workbench, invoke the same
   route against a fixture-backed runtime, and show a useful result with visible
   tool activity and a thread in the rail.
4. **Close (2 seconds).** Show the scaffold command and the category line. Do
   not make a quantitative code-size claim.

The clip has no narration or essential audio. Short labels identify the three
acts. The transcript describes every observable action.

### Derivative clips

The same capture session produces three 8-12 second clips:

| Clip | Proof | Homepage placement |
| --- | --- | --- |
| Author | File-system route plus route-local tool | File-system routing section |
| Test | Offline deterministic scenario passes | Development loop section |
| Run | Workbench run and thread restoration | Durability section |

The flagship master is also suitable for ordinary 16:9 social posts. Vertical
or square reframing is deferred.

### Output contract

| Asset | Use | Contract |
| --- | --- | --- |
| H.264 MP4 | Homepage and social fallback | 16:9, 30 fps, target <= 2 MB |
| VP9 WebM | Homepage preferred source | 16:9, 30 fps, target <= 2 MB |
| Animated GIF | Root README and primary npm entry points | 1200x675 or smaller, target <= 4 MB |
| WebP poster | Reduced motion, load fallback, social preview source | Same composition as the video |
| Markdown transcript | Accessibility and static walkthrough | Exact scene and command description |

Large MP4/WebM outputs are generated into a gitignored artifact directory and
uploaded separately to a Dawn-owned public Vercel Blob store using stable
pathnames. Capture sources, fixtures, the final README GIF, posters, and the
transcript are committed. Uploading is an explicit authorized release step. If
the store cannot be created or verified, the homepage portion does not ship
with broken or temporary media URLs.

### Deterministic capture pipeline

The capture command will:

1. Check for the repository's required Node.js and package-manager versions,
   Playwright Chromium, and ffmpeg.
2. Build the packages needed by the scaffold.
3. Create a temporary research workspace from the local scaffold in internal
   mode.
4. Install dependencies inside that workspace.
5. Start only fixture-backed model/runtime services.
6. Start the Dawn server and generated Workbench on assigned local ports.
7. Record the fixed editor/terminal/browser scenes at a fixed viewport.
8. Encode all output variants and posters.
9. Validate duration, dimensions, codecs, byte budgets, and transcript presence.
10. Stop child processes and remove the temporary workspace on success or
    failure.

No capture command may silently fall back to a live model. The recording must
fail when a fixture does not match, a required UI state does not appear, or a
child service exits.

The implementation should reuse the existing aimock/fixture and Playwright
patterns from Dawn examples. It should retire the obsolete VHS pipeline and
replace the manual `docs/brand/recording-guide.md` instructions with the new
reproducible process.

## Root GitHub README

The root README is the primary GitHub conversion surface. Its order is:

1. Responsive light/dark Dawn brand block.
2. Category, established headline, and literal subheadline.
3. Canonical scaffold command.
4. Four focused links: Get started, Migrate from LangGraph.js, Documentation,
   and Discussions.
5. No more than five high-signal badges.
6. Product-loop GIF/poster linked to the full homepage video and transcript.
7. Immediate no-key quickstart with the exact observable test result.
8. Four proof pillars:
   - A project structure that scales.
   - Types without duplicate contracts.
   - A real development and testing loop.
   - Durable and deployable application primitives.
9. Compact Dawn/LangGraph.js stack model.
10. Small authored-vs-generated comparison with a link to the full migration
    guide.
11. "What are you building?" paths into the maintained research, chat/workspace,
    memory, and workflow examples.
12. Fit/non-fit and ecosystem compatibility guidance.
13. Collapsible coding-agent prompt.
14. Detailed live-provider, Workbench, Agent Protocol, build, and deployment
    paths.
15. Pre-1.0 maturity, support, security, contribution, and community links.
16. Final scaffold CTA.

The existing long raw-LangGraph sample leaves the early reading path. It may
move behind `<details>`, but the migration guide is the canonical complete
comparison.

GitHub rendering must not depend on an inline `<video>` element or embedded
third-party player. The committed GIF/poster is the durable README proof and
links to the higher-quality video. GitHub documents repository READMEs and
supported attached media separately; npm renders package READMEs as GitHub
Flavored Markdown through GitHub's API, so image-first fallbacks are the common
denominator.

## npm README system

All 21 public packages receive a shared information model with tier-specific
depth.

### Tier 1: primary entry points

- `create-dawn-ai-app`
- `@dawn-ai/sdk`
- `@dawn-ai/cli`

These READMEs include the Dawn category, a linked product-loop thumbnail,
install/activation, a package-specific example, supported surfaces, and clear
next actions.

### Tier 2: developer capabilities

- `@dawn-ai/testing`
- `@dawn-ai/evals`
- `@dawn-ai/workspace`
- `@dawn-ai/memory`
- `@dawn-ai/memory-pgvector`
- `@dawn-ai/permissions`
- `@dawn-ai/sqlite-storage`
- `@dawn-ai/postgres-storage`
- `@dawn-ai/sandbox`
- `@dawn-ai/ag-ui`
- `@dawn-ai/inspector`

These READMEs lead with the job the package solves, then show a minimal working
example, runtime constraints, related Dawn packages, and application guides.

### Tier 3: adapters and tooling

- `@dawn-ai/core`
- `@dawn-ai/langchain`
- `@dawn-ai/langgraph`
- `@dawn-ai/vite-plugin`
- `@dawn-ai/devkit`
- `@dawn-ai/config-biome`
- `@dawn-ai/config-typescript`

These READMEs emphasize package boundaries, intended consumers, supported
subpaths, and when application developers should choose `@dawn-ai/sdk` or the
CLI instead.

### Required package README fields

Every package README contains:

1. Package name.
2. One-sentence purpose.
3. A direct "Use this when" statement.
4. Correct install command or executable invocation.
5. Minimal package-specific example when it has an author-facing API.
6. Runtime, stability, and supported-subpath boundaries.
7. Related Dawn packages and exact docs links.
8. Consistent pre-1.0/support language.
9. License.

The README must remain useful when rendered independently on npm. Core images
therefore use durable absolute URLs rather than repository-relative paths.

### Package metadata

Every public package manifest receives:

- A concise `description` aligned with its README opening.
- A focused keyword set drawn from its actual package role.
- Existing package-specific `repository.directory` and `homepage` fields.

Keywords should not be copied wholesale across the suite. Shared terms such as
`dawn`, `typescript`, and `langgraph` may recur, while role terms such as
`testing`, `pgvector`, `sandbox`, or `ag-ui` belong only where true.

The change includes one patch changeset covering the fixed public package group.
The package version remains pre-1.0 and the work makes no runtime API claim.

## Homepage integration

The homepage keeps its current left-column hero positioning and scaffold CTA.
The right column becomes a `Video / Code` proof switcher:

- Video is the default medium and uses the flagship clip.
- Code preserves the current route example.
- Only the active medium mounts.
- The video is muted, inline, and carries an explicit accessible label.
- Reduced-motion users receive the poster and an explicit play action instead
  of autoplay.
- Failure to load a video leaves the poster and code path usable.

The three derivative clips replace or augment visuals in the existing routing,
development-loop, and durability sections. The homepage does not add a separate
video gallery.

A single typed media catalog owns MP4, WebM, poster, caption, transcript, and
faux-window labels. A reusable player owns source order, fallback, reduced
motion, and loading behavior. The switcher owns keyboard-accessible tabs and
ensures inactive media is absent from the DOM.

## Accessibility and performance

- Videos contain no essential audio and do not communicate information only by
  color.
- Every video has an accurate caption, poster, and transcript.
- No rapid flashes or camera motion.
- Tab controls use the ARIA tabs pattern with keyboard navigation.
- `prefers-reduced-motion` disables autoplay and animated GIF use on the
  homepage; GitHub receives a linked static transcript alternative.
- Homepage video uses `preload="metadata"` or a stricter strategy after
  measurement. Hidden videos and iframes are not mounted.
- Mobile and narrow layouts keep code and terminal text legible without opening
  the asset separately.

## Claim and content governance

Implementation begins with an evidence matrix for every material root README
claim. Each entry records the claim, current code/test/doc evidence,
conditionality, and drift control. Unsupported claims are removed or qualified.

Commands and examples should be sourced from checked-in fixtures or tested
snippets where practical. The following stay canonical across surfaces:

- `npm create dawn-ai-app@latest my-agent`
- Node.js and npm requirements
- Research starter workspace shape and ports
- `/research#agent` route identity
- `gpt-5-mini` in examples
- "file-system" terminology
- Pre-1.0 maturity language

The GIF caption and transcript describe what the capture actually shows. They
must not claim that scaffolding appears if the footage begins in an existing
workspace.

## Validation

### Media

- Capture completes with networking to live model providers disabled.
- Scene assertions verify editor file paths, passing test output, Workbench tool
  activity, and thread state.
- Encoded assets meet dimensions, codec, duration, and byte budgets.
- Poster and transcript exist for each clip.
- Stable remote URLs return successful responses with expected content types.

### README and package surface

- The canonical quickstart runs in a clean temporary directory on the required
  Node.js/npm versions.
- Every shell command is executed where credentials and infrastructure permit.
- Code examples typecheck or execute through checked-in fixtures.
- Root and package READMEs render through a GitHub-Flavored Markdown check.
- Relative links and asset paths resolve.
- Every public package has a README, manifest description, and focused keywords.
- Packed tarballs contain the intended README and metadata.
- `node scripts/check-docs.mjs` enforces new README/metadata contracts and the
  existing banned-content rules.

### Homepage

- Video/Code selection, ARIA state, keyboard behavior, and active-pane-only DOM
  rendering are tested.
- Reduced motion renders the poster-first path.
- Video load failure preserves a usable poster and code path.
- The homepage is checked at mobile, tablet, and desktop widths in light and
  dark mode.

### Repository gates

Run targeted checks during development, then the relevant full gates from the
repository Definition of Done, including `pnpm ci:validate` when practical.
Report exactly which clean-room, media, browser, package, and CI validations ran.

## Measurement and iteration

Dawn currently has no website analytics stack. This project does not add one.

For 30 days after launch, review the signals already available to maintainers:

- GitHub traffic and outbound behavior where GitHub exposes it.
- npm downloads for `create-dawn-ai-app`, `@dawn-ai/sdk`, and `@dawn-ai/cli`.
- Search/referral information available from the website host.
- Support and Discussion questions about install, category, and migration.
- Clean-room failures discovered through issues or maintainer observation.
- External examples and contributors.

Change one hypothesis at a time. The first hypotheses are whether the product
loop improves category comprehension and whether the no-key test path becomes a
more common first success.

## Delivery sequence

This is one coordinated project delivered in reviewable stages:

1. **Media foundation:** evidence matrix, deterministic capture scenario,
   encoding/validation, flagship and derivative assets, transcript, and asset
   documentation.
2. **GitHub and npm:** root README, all package READMEs, manifest metadata,
   changeset, and documentation/package checks.
3. **Homepage:** shared media catalog/player, hero Video/Code switcher,
   derivative clips in existing sections, responsive/accessibility tests, and
   production media upload verification.

Each stage must be internally reviewable and must not leave broken asset links.
The project can use multiple pull requests while preserving this single design.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Workbench footage looks like a generic chat demo | Always pair it with the authored route and passing test; use visible Dawn-specific tool/thread activity. |
| Capture drifts from the scaffold | Scaffold from the current local build and assert exact UI/file states. |
| Media bloats git history | Commit capture sources, GIF/posters, and transcripts; host MP4/WebM in a stable Dawn-owned store. |
| CDN upload blocks code review | Keep upload separate and authorized; do not merge homepage references until URLs verify. |
| Twenty-one READMEs become duplicated marketing copy | Use three content tiers and require package-specific purpose, example, and boundary copy. |
| README commands go stale | Source examples from fixtures and extend documentation checks. |
| Autoplay harms accessibility or performance | Poster-first reduced-motion path, active-medium-only mounting, muted inline video, strict byte budgets. |
| Awareness cannot be attributed precisely | Use existing aggregate signals and defer analytics to a separate consented project. |

## External rendering references

- [GitHub: About the repository README file](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
- [GitHub: Attaching files](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)
- [npm: About package README files](https://docs.npmjs.com/about-package-readme-files/)

## Approved decisions

- Optimize first for broad TypeScript developers.
- Use the product-loop-first concept.
- Use the shipped Dawn Workbench as the canonical browser surface.
- Include the homepage in the same coordinated project.
- Update all public npm package READMEs and their descriptions/keywords.
- Produce one flagship, one GitHub derivative, and three reusable short clips.
- Defer vertical media.
- Deliver in reviewable stages under one design.

No design questions remain open.
