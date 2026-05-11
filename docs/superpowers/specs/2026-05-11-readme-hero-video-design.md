# README hero video — Screen Studio multi-scene MP4

**Date:** 2026-05-11
**Status:** Design approved, pending spec review
**Supersedes:** the VHS-driven gif infrastructure shipped in [apps#105](https://github.com/cacheplane/dawnai/pull/105).

## Problem

The current README hero is a VHS-rendered terminal gif ([docs/brand/quickstart.gif](../../../docs/brand/quickstart.gif), 146KB). It works mechanically — real `dawn` invocation, deterministic stubbed LLM output — but visually it reads as generic: small monospace font, a single terminal pane, no narrative, no editor context, no zoom or motion. The user's verdict: "pretty generic and hard to read and follow."

The Richard Kim README playbook's strongest tip is the hero visual; the bar set is "super attractive" — on par with what Vercel, Resend, Mastra, tRPC use for their landing demos. VHS cannot reach that bar. It is a script-to-terminal renderer, not a cinematic capture tool.

## Goals

1. Replace the current quickstart gif with a hand-recorded, cinematically polished MP4 hero video at the top of the README.
2. Multi-scene story: fullscreen scaffold → editor reveal of the agent file → fullscreen `dawn run` with streaming response → closing text overlay.
3. Target ~24 seconds total runtime, MP4 1080p 60fps, sized for fast first-load (< 4MB if achievable, < 8MB hard ceiling).
4. Aesthetic ceiling matches modern devtool hero gifs (Vercel/Resend/Mastra tier): consistent dark theme across editor and terminal, subtle gradient background frame, soft drop shadow, auto-zoom on key moments, polished cursor highlights, one closing text overlay.
5. Delete the VHS-era recording infrastructure as part of this PR.

## Non-goals

- Not embedding via gif. Webm is also out — Screen Studio doesn't export it, and the OBS+editor route is a multi-day project for a marketing asset.
- Not commiting the recording session as a reproducible script (Screen Studio is a GUI tool; reproducibility is "re-record manually if Dawn's CLI output changes"). This is an explicitly accepted tradeoff.
- Not adding a `dawn dev` scene. Out of scope; a separate asset later if useful.
- Not building a soundtrack/voiceover. README hero plays muted with autoplay loop.

## Tool

**Screen Studio** ($9/mo annual). Chosen after research over Tella, CleanShot X, ScreenFlow, and the OBS+Resolve path. Wins on three axes specifically: auto-zoom on cursor activity that requires no manual keyframing for ~80% of the polish, padded/gradient background presets that produce the modern devtool aesthetic with a single click, and a timeline editor scoped tightly enough that a one-person production can ship in an evening. The user has purchased it.

Export format: **MP4** (Screen Studio cannot export WebM). MP4 plays natively in GitHub README via `<video>` tag; this is what every modern devtool repo uses.

## Storyboard

Four scenes. Times shown are *gif duration*, not *recording duration* — scene 1 will be speed-ramped from real time.

### Scene 1 — Scaffold (~8s in gif, real time ~30s)

- **Capture:** iTerm fullscreen, no other windows.
- **Commands:**
  - `pnpm create dawn-ai-app my-app` (one fluid type, ~2s)
  - Scaffold output streams (real time ~25s of pnpm fetching + template writing)
  - Final "Next steps:" block appears
- **Speed ramp:** play the streaming output at 2× until the "Next steps:" block, then normal speed for the final beat.
- **Zoom keyframe:** subtle zoom into the package name on the first line, then zoom out as scaffold output streams.
- **Cut to scene 2.**

### Scene 2 — Editor (~7s)

- **Capture:** VS Code window, project loaded, [src/app/(public)/hello/[tenant]/index.ts](../../../packages/create-dawn-ai-app/templates/basic/src/app/) open.
- **Layout:**
  - File tree visible on the left, pinned to the scaffolded route directory (`src/app/(public)/hello/[tenant]/`) so `tools/`, `state.ts`, `index.ts` are visible — this passively communicates "real project structure."
  - File contents centered, ~6–8 lines visible.
- **Action:**
  - File visible, ~1s pause for eye to land.
  - Cursor click selects the entire `agent({...})` block (the scaffolded default already contains the agent descriptor — no typing, no paste).
  - Zoom keyframe: smooth zoom into the selected `agent({...})` block. Hold ~1.5s.
- **Cut to scene 3.**

### Scene 3 — Run (~7s)

- **Capture:** iTerm fullscreen again.
- **Commands:**
  - `echo '{"tenant":"acme"}' | pnpm exec dawn run "src/app/(public)/hello/[tenant]"` (typed at normal speed, ~2s)
  - **Real OpenAI call** streams the response. Cost ~$0.001 per take.
- **Zoom keyframe:** subtle zoom on the first streaming tokens.
- **Hold final frame for ~1s** so the eye lands on the result before scene 4 overlays.

### Scene 4 — Closing overlay (~2s)

- **Capture:** Final frame of scene 3 (no new recording).
- **Action:** Text overlay fades in over the lower half of the frame:
  > **8 lines of code → a real LangGraph agent**
- Hold 1.5s, then fade out and loop.

**Total target: ~24s.**

## Pre-shoot checklist

User does these before recording. Spec records them so they're not lost.

**Environment:**
- [ ] Hide Dock: `Cmd-Opt-D`
- [ ] Enable macOS Focus mode (no notifications) for the recording window
- [ ] Set display to a clean wallpaper (Screen Studio will replace the background, but cleaner desktop = less leak during transitions)
- [ ] Close all other apps (memory + visual cleanliness)

**VS Code:**
- [ ] Theme: Tokyo Night or GitHub Dark Default (high contrast, screencast-friendly)
- [ ] Font: JetBrains Mono or Fira Code, size 16–18
- [ ] Disable: minimap, breadcrumbs, statusbar (View → Appearance), Activity Bar if cramped
- [ ] Keep file tree visible (left)
- [ ] Zoom level: 1 (`Cmd-0`) — Screen Studio handles zoom in post
- [ ] Pre-open the target file: `src/app/(public)/hello/[tenant]/index.ts`

**iTerm (or terminal of choice):**
- [ ] Theme: matched dark theme to VS Code (consistent palette is the single biggest "looks professional" lever)
- [ ] Font: same as VS Code, size 18–20 (slightly larger than the editor, so terminal text reads clearly at full-screen capture)
- [ ] Set prompt to a clean PS1 (e.g. `my-app $ `) — strip any verbose RPS/git status
- [ ] Window size: full-screen but with `Cmd-Enter` toggleable
- [ ] Pre-warm pnpm cache: `pnpm install` on a throwaway project so scaffold doesn't sit on a cold network
- [ ] Confirm `OPENAI_API_KEY` is set in the shell for scene 3

**Workspace:**
- [ ] Scaffold a real demo app to `/tmp/dawn-demo-hero/my-app` ahead of time, then `rm -rf` it before recording so scene 1 is fresh
- [ ] Open VS Code on a pre-scaffolded *copy* of the project for scene 2 (so we don't re-scaffold during the take)
- [ ] Verify scene 3 invocation works against the real LLM end-to-end before recording

## Recording session protocol

1. **Three separate Screen Studio recordings** — one per scene. Don't try to record all three in a single take; the cuts and resets are easier as discrete clips.
2. **Drop all three on the timeline** in order.
3. **Background preset:** apply Screen Studio's default dark gradient with ~40px padding and soft shadow — same preset on all three clips for continuity.
4. **Speed ramp scene 1's streaming output** to 2× (Screen Studio: clip → Speed → 2× on the middle section; leave the type beat and the "Next steps:" beat at 1×).
5. **Zoom keyframes:** add the three documented above (package name, agent block, first streamed tokens). Auto-zoom handles cursor activity in between.
6. **Cross-dissolve 0.3s between scenes 1→2 and 2→3.**
7. **Text overlay** in scene 4 — fade in 0.3s, hold 1.5s, fade out 0.3s.
8. **Export:** MP4, 1080p, 60fps, web preset.
9. **Verify file size.** Target < 4MB, hard ceiling 8MB. If over, drop to 30fps or reduce dimensions to 1440p capture / 1080p export with stronger compression.

## Repo changes

**Delete (the VHS infra):**
- `docs/brand/stub-openai.mjs`
- `docs/brand/capture-fixture.mjs`
- `docs/brand/quickstart-fixture.json`
- `docs/brand/quickstart.tape`
- `docs/brand/build-gif.sh`
- `docs/brand/quickstart.gif`

**Add:**
- `docs/brand/hero.mp4` — the new asset.

**Update:**
- [README.md](../../../README.md) — replace `<p align="center"><img src="docs/brand/quickstart.gif" ... /></p>` with:
  ```html
  <p align="center">
    <video src="docs/brand/hero.mp4" autoplay muted loop playsinline width="900">
      Your browser does not support embedded video.
    </video>
  </p>
  ```
- [CONTRIBUTORS.md](../../../CONTRIBUTORS.md) — replace the VHS rebuild note with: "The README hero video is hand-recorded in Screen Studio. To re-record, see [docs/brand/README.md](../../../docs/brand/README.md). The recording is not reproducible from a script — re-shoot manually if Dawn's CLI output materially changes."
- [docs/brand/README.md](../../../docs/brand/README.md) — rewrite to document the new manual recording workflow (storyboard summary, pre-shoot checklist, tool, file).

## Risks and mitigations

- **Risk:** File size > 4MB causes slow README first-paint.
  **Mitigation:** Re-encode at lower bitrate or 30fps. If still too large, accept the size — at < 8MB GitHub caches it and most visitors hit it once.
- **Risk:** `<video>` doesn't autoplay in some viewers/clients (RSS readers, npm package pages).
  **Mitigation:** GitHub itself plays it correctly with `autoplay muted loop playsinline`. For non-GitHub viewers, the surrounding README context is still complete without the video.
- **Risk:** Re-recording effort is high if Dawn's CLI output changes.
  **Mitigation:** Accepted tradeoff. Spec calls this out explicitly. The cadence of meaningful CLI-output changes is low; re-recording is an hour at most.
- **Risk:** Real LLM call in scene 3 produces an unflattering response (too long, refuses, tool-loop).
  **Mitigation:** Take 2–3 attempts during the recording session; pick the best response. Worst case, refine the systemPrompt in the scaffolded template to produce a tighter response and re-take. The cost is pennies.
- **Risk:** Tool's `.screenstudio` project file is a large bundle (often hundreds of MB) — committing it bloats the repo.
  **Mitigation:** Do NOT commit the project file. Only commit `hero.mp4`. The recording is regenerable from the storyboard in this spec.

## Open question (decide during execution, not now)

Should the closing overlay say "**8 lines of code → a real LangGraph agent**" (current draft) or something punchier? Alternatives: "From zero to LLM in 24 seconds", "No graph wiring. No deploy config. Just `agent({...})`." Decide at the timeline-assembly step in Screen Studio.

## Out of scope (follow-ups)

- A `dawn dev` "interactive runtime" video for the docs site (not the README).
- A concept graphic / architecture diagram (separate asset).
- Localized variants.
