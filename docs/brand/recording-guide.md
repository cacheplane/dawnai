# README hero video — recording guide

Step-by-step shot list and post-production guide for re-shooting [hero.mp4](./hero.mp4). Keep this open on a second monitor while recording.

**Tool:** Screen Studio
**Output:** `docs/brand/hero.mp4`, ~24 seconds, MP4 1080p 60fps, target ≤ 4MB

Full design rationale: [docs/superpowers/specs/2026-05-11-readme-hero-video-design.md](../superpowers/specs/2026-05-11-readme-hero-video-design.md)

---

## Pre-shoot setup (20 min, do once)

### Mac

- [ ] Hide Dock: `Cmd-Opt-D`
- [ ] Enable macOS Focus mode (no notifications)
- [ ] Close every app you don't need
- [ ] Plug in (recording is CPU-heavy)
- [ ] Make sure you have ~5 minutes of uninterrupted time per take

### VS Code

- [ ] Theme: **Tokyo Night** or **GitHub Dark Default** (Settings → Color Theme)
- [ ] Font: **JetBrains Mono** or **Fira Code**, size **16**
- [ ] Disable minimap: `Cmd-Shift-P` → "Toggle Minimap"
- [ ] Disable breadcrumbs: View → Appearance → Breadcrumbs
- [ ] Keep file Explorer visible (left sidebar)
- [ ] Zoom level reset: `Cmd-0`
- [ ] Activity Bar: keep visible only if uncluttered; otherwise hide

### iTerm (or your terminal)

- [ ] Theme: dark, matched to VS Code palette. Suggested: **Tokyo Night** or **Dracula Pro**
- [ ] Font: same as VS Code, size **18–20** (larger than editor — terminal text reads at fullscreen)
- [ ] Set a clean prompt. Open `~/.zshrc` or `~/.bashrc` and temporarily set:
  ```bash
  export PS1='my-app $ '
  ```
  (revert after recording)
- [ ] Disable any verbose prompt plugins (starship, powerlevel10k status, etc.)
- [ ] Window: full screen (not maximized — true fullscreen, `Cmd-Ctrl-F`)

### Two project directories

You'll record from two states. Set up both before recording.

**Directory 1 — Empty (for scene 1):**
```bash
mkdir -p /tmp/dawn-hero-scene1
cd /tmp/dawn-hero-scene1
```
This is where you'll run `pnpm create dawn-ai-app my-app` during the take.

**Directory 2 — Scaffolded (for scenes 2 and 3):**
```bash
mkdir -p /tmp/dawn-hero-scene23
cd /tmp/dawn-hero-scene23
pnpm create dawn-ai-app my-app
cd my-app
pnpm install
```
Open this directory in VS Code: `code /tmp/dawn-hero-scene23/my-app`. Pre-open the file `src/app/(public)/hello/[tenant]/index.ts` in the editor so it's ready for scene 2.

### Pre-warm pnpm

- [ ] Run `pnpm create dawn-ai-app /tmp/dawn-hero-warmup` once to warm the registry cache, then `rm -rf /tmp/dawn-hero-warmup`. The real take will be fast.

### Environment

- [ ] Verify `OPENAI_API_KEY` is set in your shell. Source `/Users/blove/repos/dawn/.env` if needed.
- [ ] Dry-run scene 3 once to confirm the LLM call works end-to-end and produces an acceptable response.

---

## Scene 1 — Scaffold (fullscreen terminal)

**Goal:** Show `pnpm create dawn-ai-app my-app` running from scratch.

**Real recording time:** ~30s. Will be speed-ramped to ~8s in post.

### Steps

1. Open iTerm, fullscreen.
2. `cd /tmp/dawn-hero-scene1`
3. Clear: `clear`
4. **Start Screen Studio recording.**
5. Wait 1 beat. Type at human pace:
   ```
   pnpm create dawn-ai-app my-app
   ```
6. Press Enter. Don't touch the keyboard while scaffold streams.
7. When "Next steps:" block appears, wait 2 seconds. Don't touch the keyboard.
8. **Stop Screen Studio recording.**

### What good looks like

- Clean prompt visible at top (`my-app $ ` or your equivalent)
- Scaffold output is the entire visible content
- No notifications, no other windows, no Dock peek
- "Next steps:" block visible at the end

### Reshoot if

- A notification flashes
- You typo'd and used backspace (jarring in the gif)
- Scaffold takes > 45s real time (network issue — wait and retry)

---

## Scene 2 — Editor reveal (fullscreen VS Code)

**Goal:** Show the scaffolded `index.ts` with the 8-line `agent({...})` block. Eye lands on the code; cursor highlights the agent block.

**Real recording time:** ~7s.

### Steps

1. Open VS Code on `/tmp/dawn-hero-scene23/my-app`. File `src/app/(public)/hello/[tenant]/index.ts` should already be open.
2. Hide any panels except the editor and left file tree (`Cmd-J` to close terminal, `Cmd-B` only if file tree is closed).
3. **Start Screen Studio recording.**
4. Wait 1 second (let the viewer see the scene).
5. Click anywhere in the editor to ensure focus.
6. Triple-click the `agent(` line, then drag down to select through the closing `})`. Or `Cmd-A` to select all then `Cmd-D` then `Cmd-Shift-K` — whatever produces a clean selection of just the `agent({...})` block.
7. Hold the selection visible for 2 seconds.
8. **Stop Screen Studio recording.**

### What good looks like

- File tree (left) shows `src/app/(public)/hello/[tenant]/` expanded with `index.ts`, `tools/`, `state.ts`, `middleware.ts` visible
- File content (right) shows the full `agent({...})` block in the upper portion
- Selection highlight is clean (no partial-line selections, no extra whitespace selected)

### Reshoot if

- File tree shows your home directory or any path leak
- Selection is jittery or includes random whitespace lines
- Any VS Code popups (extensions update, etc.) appear

---

## Scene 3 — Run (fullscreen terminal)

**Goal:** Show `dawn run` invoking the route, real LLM response streams.

**Real recording time:** ~7s.

### Steps

1. Open iTerm, fullscreen.
2. `cd /tmp/dawn-hero-scene23/my-app`
3. Clear: `clear`
4. **Start Screen Studio recording.**
5. Wait 1 beat. Type at human pace:
   ```
   echo '{"tenant":"acme"}' | pnpm exec dawn run "src/app/(public)/hello/[tenant]"
   ```
6. Press Enter. Don't touch the keyboard while response streams.
7. When response is fully streamed, wait 2 seconds. Don't touch the keyboard.
8. **Stop Screen Studio recording.**

### What good looks like

- Streaming response, not a single chunk — the eye sees tokens arriving
- Response is well-formed (greets the tenant, sounds natural)
- Final response is no longer than ~3 lines (long responses don't fit)

### Reshoot if

- LLM responds with > 3 lines or refuses
- Response is bland ("Hello, Acme!" alone is too thin)
- Any error output appears

### Tip

If the response is bland, edit `src/app/(public)/hello/[tenant]/index.ts` in your scaffolded copy and tighten the `systemPrompt` (e.g. add "Be warm and specific. Mention one thing the {tenant} organization might care about. Under 30 words."). Re-record.

---

## Post-production — Screen Studio timeline

Once all three clips are recorded:

1. **New Screen Studio project.** Drop all three clips on the timeline in order: scaffold, editor, run.
2. **Background preset.** Select all three clips → apply **Dark Gradient** background, **40px padding**, **soft shadow**. Same preset on all three for visual continuity.
3. **Scene 1 speed ramp.** Select scene 1 → split at the moment scaffold output starts → set the middle section to **2× speed** → re-split before "Next steps:" appears → leave that final 1.5s at 1× speed.
4. **Zoom keyframes:**
   - Scene 1: subtle zoom (1.1×) into the line where `pnpm create dawn-ai-app my-app` is typed, hold ~1s, then zoom out.
   - Scene 2: smooth zoom (1.3×) into the `agent({...})` block when the selection appears. Hold until cut.
   - Scene 3: subtle zoom (1.15×) on the first streamed tokens of the response. Hold until cut.
5. **Transitions.** Cross-dissolve **0.3s** between scenes 1→2 and 2→3.
6. **Closing text overlay.** On the last 2 seconds of scene 3:
   - Text: **"8 lines of code → a real LangGraph agent"**
   - Position: lower third of the frame, centered
   - Font: system default sans (Inter / SF Pro), bold, white with subtle drop shadow
   - Animation: fade in **0.3s**, hold **1.5s**, fade out **0.3s**

### Alternative closing lines (pick whichever feels right at this step)

- "8 lines of code → a real LangGraph agent"
- "From zero to LLM in 24 seconds"
- "No graph wiring. No deploy config. Just `agent({...})`."

---

## Export

Screen Studio → Export:

- Format: **MP4**
- Resolution: **1080p**
- Frame rate: **60 fps**
- Quality: **Web (recommended)** preset

Save to: `~/Desktop/dawn-hero.mp4` (you'll move it into the repo with help from Claude after).

### Check before saving

- [ ] File size < 4MB (ideal) or < 8MB (hard ceiling). If over, drop to 30fps or use Web Compressed.
- [ ] Total duration is **22–26 seconds**.
- [ ] No artifacts at scene transitions.
- [ ] Closing text overlay reads cleanly at 1080p.
- [ ] Plays clean in QuickTime preview.

---

## Hand-off to Claude

When the MP4 is ready, paste this in chat:

> `dawn-hero.mp4 is at /Users/blove/Desktop/dawn-hero.mp4`

Claude will:
1. Move the file into `docs/brand/hero.mp4`
2. Delete the obsolete VHS infra (stub, capture script, .tape, fixture, gif, build-gif.sh)
3. Update [README.md](../../README.md) to embed via `<video>` tag
4. Update [CONTRIBUTORS.md](../../CONTRIBUTORS.md) and [docs/brand/README.md](./README.md)
5. Commit, push, open the PR, watch CI, merge on green

---

## Troubleshooting

**LLM response is too long / weird.**
Edit the scaffolded `index.ts`'s `systemPrompt` to constrain the output (e.g. "Reply in one warm sentence under 25 words."). Re-record scene 3.

**Screen Studio export file is huge.**
Drop to 30fps or use the Web Compressed preset. If still > 8MB, reduce scene 1's real time by trimming more of the install output before speed-ramping.

**iTerm prompt shows your full path on first line.**
Reset `PS1` temporarily as noted in setup. After recording revert your shell config.

**File tree in scene 2 leaks your home path.**
Open the project as its own workspace (`File → Open Workspace`, pick `/tmp/dawn-hero-scene23/my-app`) so the tree root is `my-app/`.

**Scaffold step takes 60+ seconds.**
Pre-warm pnpm cache. If still slow, you can record once, then in Screen Studio split out the slow chunk and apply 4× speed to just that segment.
