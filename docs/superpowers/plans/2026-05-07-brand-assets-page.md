# Brand Assets Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public `/brand` page with a curated downloadable Dawn brand kit, individual asset links, and an agent-readable manifest.

**Architecture:** Static assets live under `apps/web/public/brand`, which maps to `/brand/*`. The Next app route `apps/web/app/brand/page.tsx` serves the human-facing page at `/brand`, while `/brand/assets.json` and `/brand/dawn-ai-brand-assets.zip` are static public files for agents and downloads. The footer and `llms*.txt` routes link to the new brand endpoints.

**Tech Stack:** Next.js App Router, React Server Components, static public assets, JSON manifest, ZIP archive, Biome, TypeScript.

---

## File Structure

- Create `apps/web/app/brand/page.tsx`
  - Owns the human-facing Brand Assets page.
  - Defines static data for common download cards and usage guidance.
- Create `apps/web/public/brand/assets.json`
  - Machine-readable public index for coding agents.
- Create `apps/web/public/brand/dawn-ai-brand-assets.zip`
  - Curated public ZIP bundle.
- Modify `apps/web/app/components/Footer.tsx`
  - Adds `Brand Assets` link to the Source column or renamed Resources column.
- Modify `apps/web/app/llms.txt/route.ts`
  - Adds compact brand asset URLs for agents.
- Modify `apps/web/app/llms-full.txt/route.ts`
  - Adds brand asset URLs to the generated full reference.
- Optionally create temporary build directory outside git under `/tmp/dawn-public-brand-kit`
  - Used only to assemble the curated ZIP.

## Task 1: Create the Machine-Readable Asset Manifest

**Files:**
- Create: `apps/web/public/brand/assets.json`

- [ ] **Step 1: Inspect available public brand assets**

Run:

```bash
find apps/web/public/brand apps/web/public/social apps/web/public -maxdepth 2 \
  \( -path 'apps/web/public/backgrounds' -prune -o -type f -print \) | sort
```

Expected: shows current logo SVGs/PNGs, favicon files, app icons, social images, and no `assets.json` yet.

- [ ] **Step 2: Create manifest**

Create `apps/web/public/brand/assets.json` with this shape:

```json
{
  "name": "Dawn AI Brand Assets",
  "version": "2026-05-07",
  "description": "Official Dawn AI logos, icons, favicons, and social assets for developers and coding agents.",
  "homepage": "/brand",
  "downloadUrl": "/brand/dawn-ai-brand-assets.zip",
  "manifestUrl": "/brand/assets.json",
  "usage": {
    "summary": "Use the official files as provided. Use white assets on dark backgrounds and black assets on light backgrounds. Do not stretch, recolor, redraw, or imply endorsement.",
    "preferredLogo": "logo-horizontal-white-svg",
    "preferredIcon": "icon-white-svg"
  },
  "assets": [
    {
      "id": "logo-horizontal-white-svg",
      "label": "Horizontal logo, white",
      "type": "logo",
      "format": "svg",
      "url": "/brand/dawn-logo-horizontal-white.svg",
      "background": "dark",
      "recommendedFor": ["website headers", "dark backgrounds", "README images on dark canvases"]
    },
    {
      "id": "logo-horizontal-black-svg",
      "label": "Horizontal logo, black",
      "type": "logo",
      "format": "svg",
      "url": "/brand/dawn-logo-horizontal-black.svg",
      "background": "light",
      "recommendedFor": ["light backgrounds", "documents", "press mentions"]
    },
    {
      "id": "logo-horizontal-white-on-black-png",
      "label": "Horizontal logo, white on black",
      "type": "logo",
      "format": "png",
      "url": "/brand/dawn-logo-horizontal-white-on-black.png",
      "background": "included",
      "dimensions": { "width": 1440, "height": 440 },
      "recommendedFor": ["README previews", "presentations", "social cards"]
    },
    {
      "id": "icon-white-svg",
      "label": "Icon, white",
      "type": "icon",
      "format": "svg",
      "url": "/brand/dawn-icon-white.svg",
      "background": "dark",
      "recommendedFor": ["compact UI", "dark backgrounds", "logo grids"]
    },
    {
      "id": "icon-black-svg",
      "label": "Icon, black",
      "type": "icon",
      "format": "svg",
      "url": "/brand/dawn-icon-black.svg",
      "background": "light",
      "recommendedFor": ["compact UI", "light backgrounds", "logo grids"]
    },
    {
      "id": "social-avatar-white-on-black-png",
      "label": "Social avatar, white on black",
      "type": "social",
      "format": "png",
      "url": "/social/dawn-social-avatar-white-on-black-1024.png",
      "background": "included",
      "dimensions": { "width": 1024, "height": 1024 },
      "recommendedFor": ["social profiles", "square avatars", "marketplace icons"]
    },
    {
      "id": "favicon-ico",
      "label": "Favicon ICO",
      "type": "favicon",
      "format": "ico",
      "url": "/favicon.ico",
      "background": "transparent",
      "recommendedFor": ["browser favicon"]
    },
    {
      "id": "webmanifest",
      "label": "Web app manifest",
      "type": "manifest",
      "format": "json",
      "url": "/site.webmanifest",
      "background": "not-applicable",
      "recommendedFor": ["web apps", "installable app metadata"]
    }
  ]
}
```

- [ ] **Step 3: Validate JSON**

Run:

```bash
node -e "JSON.parse(require('node:fs').readFileSync('apps/web/public/brand/assets.json', 'utf8')); console.log('assets.json ok')"
```

Expected: `assets.json ok`.

- [ ] **Step 4: Commit manifest**

Run:

```bash
git add apps/web/public/brand/assets.json
git commit -m "Add brand asset manifest"
```

Expected: commit succeeds.

## Task 2: Build the Curated Public ZIP

**Files:**
- Create: `apps/web/public/brand/dawn-ai-brand-assets.zip`

- [ ] **Step 1: Assemble temporary bundle directory**

Run:

```bash
rm -rf /tmp/dawn-public-brand-kit
mkdir -p /tmp/dawn-public-brand-kit/dawn-ai-brand-assets/{svg,png,favicon,social,app-icons}
cp apps/web/public/brand/*.svg /tmp/dawn-public-brand-kit/dawn-ai-brand-assets/svg/
cp apps/web/public/brand/*.png /tmp/dawn-public-brand-kit/dawn-ai-brand-assets/png/
cp apps/web/public/favicon*.png apps/web/public/favicon.ico apps/web/public/site.webmanifest /tmp/dawn-public-brand-kit/dawn-ai-brand-assets/favicon/
cp apps/web/public/android-chrome-192x192.png apps/web/public/android-chrome-512x512.png apps/web/public/apple-touch-icon.png /tmp/dawn-public-brand-kit/dawn-ai-brand-assets/app-icons/
cp apps/web/public/social/*.png /tmp/dawn-public-brand-kit/dawn-ai-brand-assets/social/
cp apps/web/public/brand/assets.json /tmp/dawn-public-brand-kit/dawn-ai-brand-assets/assets.json
```

Expected: files are copied into categorized folders.

- [ ] **Step 2: Add bundle README and tokens**

Create `/tmp/dawn-public-brand-kit/dawn-ai-brand-assets/README.md` with:

```markdown
# Dawn AI Brand Assets

Official public brand assets for Dawn AI.

## Recommended usage

- Use `svg/dawn-logo-horizontal-white.svg` on dark backgrounds.
- Use `svg/dawn-logo-horizontal-black.svg` on light backgrounds.
- Use `svg/dawn-icon-white.svg` or `svg/dawn-icon-black.svg` for compact UI and logo grids.
- Use `social/dawn-social-avatar-white-on-black-1024.png` for square social avatars.

Use the files as provided. Do not stretch, recolor, redraw, or use the Dawn marks in a way that implies endorsement.

For machine-readable metadata, see `assets.json`.
```

Create `/tmp/dawn-public-brand-kit/dawn-ai-brand-assets/dawn-brand-tokens.css` with:

```css
:root {
  --dawn-black: #000000;
  --dawn-white: #ffffff;
  --dawn-neutral-gray: #6b6b6b;
  --dawn-font-sans: "Inter", "Satoshi", "Helvetica Neue", Arial, sans-serif;
}
```

- [ ] **Step 3: Verify no internal folders are included**

Run:

```bash
find /tmp/dawn-public-brand-kit/dawn-ai-brand-assets -maxdepth 2 -type f | sort
```

Expected: no `reference_boards`, `source`, trace notes, or exploration files.

- [ ] **Step 4: Create ZIP**

Run:

```bash
cd /tmp/dawn-public-brand-kit && zip -qr /Users/blove/.codex/worktrees/ac9c/dawn/apps/web/public/brand/dawn-ai-brand-assets.zip dawn-ai-brand-assets
```

Expected: ZIP file is created at `apps/web/public/brand/dawn-ai-brand-assets.zip`.

- [ ] **Step 5: Inspect ZIP contents**

Run:

```bash
unzip -l apps/web/public/brand/dawn-ai-brand-assets.zip | sed -n '1,220p'
```

Expected: ZIP includes curated folders and no excluded internal artifacts.

- [ ] **Step 6: Commit ZIP**

Run:

```bash
git add apps/web/public/brand/dawn-ai-brand-assets.zip
git commit -m "Add downloadable brand asset kit"
```

Expected: commit succeeds.

## Task 3: Build the `/brand` Page

**Files:**
- Create: `apps/web/app/brand/page.tsx`

- [ ] **Step 1: Create page component**

Create `apps/web/app/brand/page.tsx` with:

```tsx
import Image from "next/image"
import Link from "next/link"
import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Brand Assets",
  description:
    "Download official Dawn AI logos, icons, favicons, social images, and machine-readable asset metadata.",
}

const DOWNLOADS = [
  {
    label: "Horizontal logo",
    format: "SVG",
    href: "/brand/dawn-logo-horizontal-white.svg",
    note: "White logo for dark backgrounds and website headers.",
  },
  {
    label: "Icon",
    format: "SVG",
    href: "/brand/dawn-icon-white.svg",
    note: "Compact mark for logo grids and small UI surfaces.",
  },
  {
    label: "Social avatar",
    format: "PNG",
    href: "/social/dawn-social-avatar-white-on-black-1024.png",
    note: "Square 1024px avatar for profiles and marketplaces.",
  },
  {
    label: "Favicon",
    format: "ICO",
    href: "/favicon.ico",
    note: "Browser favicon file.",
  },
  {
    label: "Asset manifest",
    format: "JSON",
    href: "/brand/assets.json",
    note: "Machine-readable index for coding agents and automation.",
  },
] as const

const GUIDANCE = [
  "Use the official files as provided.",
  "Use white assets on dark backgrounds and black assets on light backgrounds.",
  "Keep clear space around the logo and icon.",
  "Do not stretch, recolor, redraw, or imply Dawn endorsement.",
] as const

export default function BrandPage() {
  return (
    <div className="px-8 py-16">
      <section className="max-w-6xl mx-auto">
        <div className="grid gap-10 lg:grid-cols-[1fr_420px] lg:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-accent-amber mb-4">
              Brand Assets
            </p>
            <h1
              className="font-display text-5xl md:text-6xl font-semibold text-text-primary tracking-tight"
              style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
            >
              Dawn Brand Assets
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-text-secondary max-w-2xl">
              Official Dawn AI logos, icons, favicons, and social assets for developers,
              documentation, and coding agents.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href="/brand/dawn-ai-brand-assets.zip"
                className="px-5 py-2.5 bg-accent-amber text-bg-primary rounded-md text-sm font-semibold hover:bg-accent-amber-deep transition-colors"
              >
                Download full brand kit
              </a>
              <a
                href="/brand/assets.json"
                className="px-5 py-2.5 border border-border text-text-secondary rounded-md text-sm hover:border-text-muted hover:text-text-primary transition-colors"
              >
                View asset manifest
              </a>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-bg-card/60 p-8">
            <div className="rounded-md bg-black p-8">
              <Image
                src="/brand/dawn-logo-horizontal-white.svg"
                alt="Dawn AI"
                width={720}
                height={220}
                className="w-full h-auto"
                priority
              />
            </div>
            <p className="mt-4 text-sm text-text-muted">
              Use the horizontal logo when space allows. Use the icon for compact placements.
            </p>
          </div>
        </div>
      </section>

      <section className="max-w-6xl mx-auto mt-16">
        <div className="flex items-end justify-between gap-6 mb-6">
          <div>
            <h2 className="text-2xl font-semibold text-text-primary">Common downloads</h2>
            <p className="text-sm text-text-muted mt-2">
              Direct links for the files developers and agents most often need.
            </p>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          {DOWNLOADS.map((asset) => (
            <a
              key={asset.href}
              href={asset.href}
              className="rounded-lg border border-border bg-bg-card/50 p-4 hover:border-accent-amber/50 transition-colors"
            >
              <span className="text-[11px] font-semibold uppercase tracking-widest text-accent-amber">
                {asset.format}
              </span>
              <h3 className="mt-3 text-base font-semibold text-text-primary">{asset.label}</h3>
              <p className="mt-2 text-sm leading-relaxed text-text-muted">{asset.note}</p>
            </a>
          ))}
        </div>
      </section>

      <section className="max-w-6xl mx-auto mt-16 grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-bg-card/40 p-6">
          <h2 className="text-xl font-semibold text-text-primary">Usage guidance</h2>
          <ul className="mt-4 space-y-3">
            {GUIDANCE.map((item) => (
              <li key={item} className="text-sm leading-relaxed text-text-secondary">
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-border bg-bg-card/40 p-6">
          <h2 className="text-xl font-semibold text-text-primary">For coding agents</h2>
          <p className="mt-4 text-sm leading-relaxed text-text-secondary">
            Use <code className="text-text-primary">/brand/assets.json</code> as the canonical
            machine-readable index. It lists the full ZIP, common direct URLs, formats, dimensions,
            background guidance, and recommended use cases.
          </p>
          <div className="mt-5 flex flex-wrap gap-3 text-sm">
            <a href="/brand/assets.json" className="text-accent-amber hover:text-accent-amber-deep">
              Open assets.json
            </a>
            <Link href="/llms.txt" className="text-accent-amber hover:text-accent-amber-deep">
              llms.txt
            </Link>
            <Link href="/llms-full.txt" className="text-accent-amber hover:text-accent-amber-deep">
              llms-full.txt
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm --filter @dawn-ai/web typecheck
```

Expected: TypeScript passes.

- [ ] **Step 3: Commit page**

Run:

```bash
git add apps/web/app/brand/page.tsx
git commit -m "Add brand assets page"
```

Expected: commit succeeds.

## Task 4: Add Footer and Agent Discovery Links

**Files:**
- Modify: `apps/web/app/components/Footer.tsx`
- Modify: `apps/web/app/llms.txt/route.ts`
- Modify: `apps/web/app/llms-full.txt/route.ts`

- [ ] **Step 1: Add footer link**

In `apps/web/app/components/Footer.tsx`, add this item to the `Source` column:

```ts
{ label: "Brand Assets", href: "/brand" },
```

Keep it internal, with no `external: true`.

- [ ] **Step 2: Add compact agent references**

In `apps/web/app/llms.txt/route.ts`, after "Agent Config Templates" and before "Full Reference", add:

```ts
"## Brand Assets",
"Official Dawn AI logos, icons, favicons, and social assets:",
"- Brand page: https://dawnai.org/brand",
"- Asset manifest: https://dawnai.org/brand/assets.json",
"- Full brand kit ZIP: https://dawnai.org/brand/dawn-ai-brand-assets.zip",
"",
```

- [ ] **Step 3: Add full-reference agent section**

In `apps/web/app/llms-full.txt/route.ts`, after the initial source links and before the first `---`, add:

```ts
"## Brand Assets",
"",
"Official Dawn AI logos, icons, favicons, and social assets are available at https://dawnai.org/brand.",
"",
"Machine-readable asset manifest: https://dawnai.org/brand/assets.json",
"Curated brand kit ZIP: https://dawnai.org/brand/dawn-ai-brand-assets.zip",
"",
```

- [ ] **Step 4: Run focused checks**

Run:

```bash
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
```

Expected: both pass.

- [ ] **Step 5: Commit integration links**

Run:

```bash
git add apps/web/app/components/Footer.tsx apps/web/app/llms.txt/route.ts apps/web/app/llms-full.txt/route.ts
git commit -m "Link brand assets from website"
```

Expected: commit succeeds.

## Task 5: Final Verification and Visual QA

**Files:**
- No new files expected.

- [ ] **Step 1: Run production build**

Run:

```bash
pnpm --filter @dawn-ai/web build
```

Expected: Next build succeeds and includes `/brand` in the route list.

- [ ] **Step 2: Start local web server**

Run:

```bash
pnpm --filter @dawn-ai/web dev --port 3000
```

Expected: server starts at `http://localhost:3000`.

- [ ] **Step 3: Inspect public endpoints**

Run:

```bash
curl -I http://localhost:3000/brand
curl -I http://localhost:3000/brand/assets.json
curl -I http://localhost:3000/brand/dawn-ai-brand-assets.zip
curl http://localhost:3000/brand/assets.json | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{JSON.parse(s);console.log('manifest endpoint ok')})"
```

Expected: `/brand` returns 200, JSON and ZIP endpoints return 200, manifest parses.

- [ ] **Step 4: Browser visual check**

Use Playwright or the in-app browser to inspect:

- `http://localhost:3000/brand`
- `http://localhost:3000/brand/dawn-logo-horizontal-white.svg`
- `http://localhost:3000/llms.txt`

Expected:

- `/brand` renders with global header/footer.
- Main logo preview is visible and not distorted.
- Download cards are readable at desktop width.
- Footer includes `Brand Assets`.
- `llms.txt` includes the brand asset URLs.

- [ ] **Step 5: Stop local server**

Stop any dev server started for visual QA.

- [ ] **Step 6: Final status**

Run:

```bash
git status -sb
```

Expected: clean working tree after committed implementation, or only intentional uncommitted changes if a PR workflow will squash them.
