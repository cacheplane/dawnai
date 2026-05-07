# Brand Assets Page Design

## Summary

Add a public, download-first `/brand` page for Dawn brand assets. The page serves two audiences:

- Humans who need the official logo kit quickly.
- Coding agents and automation that need stable, machine-readable asset URLs without scraping HTML.

The footer link label is **Brand Assets** and points to `/brand`.

## Research Notes

Peer patterns point toward a simple public asset hub:

- Vercel exposes brand assets inside its design-system site with downloadable assets, usage guidance, and developer-oriented code snippets.
- Linear uses a concise `/brand` page with a direct brand assets download and short logo usage guidance.
- Stripe's newsroom uses a "Media assets" section with a direct logo kit download and brief color guidance.
- OpenAI and GitHub emphasize trademark ownership and do/don't rules to prevent implied endorsement or altered marks.
- thirdweb exposes individual downloadable assets with previews.
- Strata uses a traditional media-kit model with a direct ZIP download for logo assets.

Dawn should follow the developer-facing pattern rather than a press-heavy media kit. The page should be direct like Linear/Vercel, with enough usage guidance to prevent common mistakes.

## Goals

- Make the official Dawn brand kit easy to discover from the website footer.
- Provide a single curated ZIP download for humans.
- Provide individual direct asset URLs for common use cases.
- Provide a stable JSON manifest for coding agents.
- Keep the public bundle focused on production-ready assets, not exploration artifacts.
- Add the brand asset endpoints to agent-facing discovery surfaces.

## Non-Goals

- No full brand guideline microsite.
- No interactive design system.
- No asset upload, generation, or customization tooling.
- No press newsroom, founder photos, or company boilerplate.
- No public exposure of reference boards, source trace files, or internal exploration artifacts.

## URL Structure

- `/brand` — public Brand Assets page.
- `/brand/dawn-ai-brand-assets.zip` — curated public ZIP.
- `/brand/assets.json` — machine-readable asset inventory.
- Existing individual files under `/brand/*` remain directly addressable.

Because `apps/web/public/brand/*` maps to `/brand/*`, the page route and static files share the `/brand` URL namespace. Next's app route at `/brand` serves the page, while deeper static file paths serve downloads.

## Page Design

Use a download-first layout:

1. Hero
   - Official Dawn horizontal logo preview.
   - Heading: "Dawn Brand Assets".
   - One-sentence purpose statement for developers and coding agents.
   - Primary CTA: "Download full brand kit".
   - Secondary CTA: "View asset manifest".

2. Common downloads
   - Compact cards for the most common direct downloads:
     - Horizontal logo SVG.
     - Icon SVG.
     - Social avatar PNG.
     - Favicon ICO.
     - Web manifest.
   - Each card includes format, recommended use, and a direct download/open link.

3. Usage guidance
   - Short do/don't guidance:
     - Use official files as provided.
     - Use white assets on dark backgrounds and black assets on light backgrounds.
     - Keep clear space around the mark.
     - Do not stretch, recolor, redraw, or imply endorsement.

4. Agent access
   - Explain `/brand/assets.json` as the canonical machine-readable index.
   - Link to `llms.txt` and `llms-full.txt` if helpful.

The page should be a public utility page, not a docs-sidebar page. It should reuse the global header/footer and existing Dawn visual language, but stay sparse and scan-friendly.

## Curated Public Bundle

Commit a curated ZIP at:

```text
apps/web/public/brand/dawn-ai-brand-assets.zip
```

The ZIP should include:

- `README.md`
- `assets.json`
- `svg/`
- `png/`
- `favicon/`
- `social/`
- `app-icons/`
- `dawn-brand-tokens.css`

The ZIP should exclude:

- `reference_boards/`
- `source/`
- process or trace files
- exploration mockups
- non-public working artifacts

## Manifest Contract

Commit a manifest at:

```text
apps/web/public/brand/assets.json
```

The manifest is a small stable public API for agents. It should include:

- Brand kit name and version/date.
- Full ZIP download URL.
- Recommended primary assets.
- Array of individual assets with:
  - `id`
  - `label`
  - `type`
  - `format`
  - `url`
  - `background`
  - `recommendedFor`
  - `dimensions` where known

Example shape:

```json
{
  "name": "Dawn AI Brand Assets",
  "version": "2026-05-07",
  "downloadUrl": "/brand/dawn-ai-brand-assets.zip",
  "assets": [
    {
      "id": "logo-horizontal-white-svg",
      "label": "Horizontal logo, white",
      "type": "logo",
      "format": "svg",
      "url": "/brand/dawn-logo-horizontal-white.svg",
      "background": "dark",
      "recommendedFor": ["website headers", "dark backgrounds"]
    }
  ]
}
```

## Footer Integration

Add a "Brand Assets" footer link. The most natural location is the Source column because it already contains GitHub, npm, and license links. If the column feels too source-code-specific during implementation, rename that column to "Resources" and include GitHub, npm, MIT License, and Brand Assets.

## Agent-Facing Discovery

Update:

- `apps/web/app/llms.txt/route.ts`
- `apps/web/app/llms-full.txt/route.ts`

Add `/brand`, `/brand/assets.json`, and `/brand/dawn-ai-brand-assets.zip` so agents can discover the brand kit from the existing agent entry points.

## Implementation Notes

- Implement page at `apps/web/app/brand/page.tsx`.
- Prefer static arrays for asset cards in the page component.
- Keep the asset manifest hand-authored for now.
- If assets change frequently later, add a generator script to create both ZIP and manifest from a source directory.
- The downloaded ZIP should include `assets.json` so agents can work offline after downloading it.

## Validation

Run:

```bash
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web build
```

Before finalizing implementation, visually inspect `/brand` and at least one direct asset URL.
