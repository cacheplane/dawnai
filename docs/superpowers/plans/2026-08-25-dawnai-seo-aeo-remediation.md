# Dawnai.org SEO and Answer-Engine Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair dawnai.org's measured sitemap, canonical, metadata, structured-data, OG-image, and crawler-policy failures, then produce an evidence-backed production handoff.

**Architecture:** A server-only SEO resolver normalizes route-registry entries and blog frontmatter into one `SeoPage` consumed by Next metadata, JSON-LD, and sitemap generation. Static last-modified dates come from a checked-in manifest so shallow production clones cannot collapse dates; blog dates remain deterministic frontmatter inputs. Implementation stops at the human deployment boundary and resumes with direct production `curl` verification.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 7, Vitest 4, pnpm 10, Node 24, JSON-LD, Google Search Console API, `curl`.

**Approved spec:** `docs/superpowers/specs/2026-08-25-dawnai-seo-aeo-remediation-design.md`

**Working directory:** `/Users/blove/repos/dawn/.worktrees/seo-aeo-audit`

**Required execution skills:** `@superpowers:test-driven-development` for Tasks 2-8 and `@superpowers:verification-before-completion` for Tasks 9-10.

---

## File map

- `docs/superpowers/audits/2026-08-25-dawnai-seo-aeo-audit.md` — durable baseline, findings, commands/output, delta, blockers, and human handoff.
- `apps/web/app/seo/types.ts` — `SeoPage` and page-kind contracts.
- `apps/web/app/seo/registry.ts` — static/docs authored metadata and route lookup.
- `apps/web/app/seo/resolve.ts` — normalization into one `SeoPage` and Next `Metadata` conversion.
- `apps/web/app/seo/structured-data.ts` — pure Organization, WebSite, WebPage/CollectionPage, TechArticle, BlogPosting, Person, and breadcrumb builders.
- `apps/web/app/seo/JsonLd.tsx` — safe JSON-LD script rendering.
- `apps/web/app/seo/seo.test.ts` — registry coverage, description, canonical, and schema invariants.
- `apps/web/app/seo/lastmod.generated.ts` — checked-in static/docs/tag date manifest.
- `apps/web/scripts/generate-seo-lastmod.mjs` — full-history maintenance generator; never runs in production builds.
- `apps/web/scripts/audit-built-seo.mjs` — enumerates the built sitemap and asserts crawler-visible metadata for every built URL.
- `apps/web/app/sitemap.ts` and `apps/web/app/sitemap.test.ts` — deterministic sitemap union and distribution validation.
- `apps/web/app/layout.tsx` — homepage metadata and sitewide Organization/WebSite graph.
- `apps/web/app/components/docs/DocsPage.tsx` — route-level TechArticle and breadcrumb graph.
- `apps/web/app/blog/page.tsx` and `apps/web/app/blog/tags/[tag]/page.tsx` — normalized blog-index/tag metadata and page graphs.
- `apps/web/app/blog/[slug]/page.tsx` — normalized blog metadata and BlogPosting graph.
- `apps/web/app/blog/[slug]/opengraph-image.tsx` — network-independent static image generation.
- `apps/web/app/blog/[slug]/opengraph-image.test.ts` — image response contract.
- `apps/web/app/robots.ts` and `apps/web/app/robots.test.ts` — explicit allow-all crawler policy.
- `apps/web/app/docs/**/page.tsx` — call the shared docs metadata resolver instead of local title-only metadata.

## Task 1: Preserve the baseline and findings gate

**Files:**
- Create: `docs/superpowers/audits/2026-08-25-dawnai-seo-aeo-audit.md`
- Reference: `/Users/blove/repos/dawn/keys/gsc-baseline-2026-08-25.json`
- Reference: `/Users/blove/repos/dawn/keys/url-inspection-2026-08-25.json`
- Reference: `/Users/blove/repos/dawn/keys/live-url-status.tsv`

- [ ] **Step 1: Write the durable baseline report**

Include the approved spec's 90-day window, aggregate/query/page results, sitemap API state, `lastDownloaded`, warnings/errors, lastmod distribution, all 66 URL rows, the 13 non-indexed exceptions, canonical fields, and exact live commands/output. Do not include credentials, OAuth codes, tokens, or client-secret contents.

- [ ] **Step 2: Classify every finding**

Use exactly four headings: `Broken`, `Missing`, `Improvable`, and `Blocked`. Put the obsolete submitted sitemap and live OG 500s under Broken; missing canonicals/schema/descriptions under Missing; the homepage snippet under Improvable; analytics ingest and production-only checks under Blocked.

- [ ] **Step 3: Record the repository baseline**

Record:

```text
Node 24.19.0
lint: PASS
build: PASS
typecheck: PASS
tests: 4655 passed, 215 skipped, 1 unrelated CLI port-race failure
targeted rerun: 1 passed, 16 skipped
```

- [ ] **Step 4: Validate and commit**

Run: `git diff --check`

Expected: exit 0.

Commit:

```bash
git add docs/superpowers/audits/2026-08-25-dawnai-seo-aeo-audit.md
git commit -m "docs: record search visibility baseline"
```

## Task 2: Make sitemap dates deterministic

**Files:**
- Create: `apps/web/app/seo/lastmod.generated.ts`
- Create: `apps/web/scripts/generate-seo-lastmod.mjs`
- Modify: `apps/web/app/sitemap.test.ts`
- Modify: `apps/web/app/sitemap.ts`
- Modify: `apps/web/package.json`

- [ ] **Step 1: Write failing sitemap invariants**

Add tests that require every sitemap URL to have a valid ISO `lastModified`, require the resolved static/docs/tag inventory to match the sitemap inventory after individual blog-post URLs are excluded, and require more than ten distinct dates across the full sitemap. The indexable source inventory is `/`, `/blog`, all 75 `ALL_DOCS_PAGES` routes, every non-draft post, and every generated tag route. `/docs` is redirect-only and must not appear.

```ts
expect(entries.every((entry) => !Number.isNaN(Date.parse(String(entry.lastModified))))).toBe(true)
expect(new Set(entries.map((entry) => String(entry.lastModified))).size).toBeGreaterThan(10)
```

- [ ] **Step 2: Verify the tests fail for the current build-time timestamps**

Run: `pnpm --filter @dawn-ai/web test -- app/sitemap.test.ts`

Expected: FAIL because most routes share one generated timestamp and no manifest exists.

- [ ] **Step 3: Add the full-history generator**

Implement a Node script that maps `/`, `/blog`, every `ALL_DOCS_PAGES` href, and every generated tag route to its substantive visible-content source set; runs `git log -1 --format=%cI -- <source>` for each source; chooses the newest real commit date within each set; sorts keys; and writes a TypeScript `STATIC_LASTMOD` record. `/` owns `app/page.tsx` plus its `components/landing/**/*.tsx` content components; each docs route owns its MDX content file; `/blog` owns its published post MDX files; and each tag owns the published post MDX files bearing that tag. Exclude mechanical route wrappers, layouts, SEO registry/build code, and redirect-only `/docs`, because changing those does not change the page's substantive visible content. Fail instead of substituting the current date when any route has no usable history.

Add `"seo:lastmod": "node scripts/generate-seo-lastmod.mjs"` to `apps/web/package.json`.

- [ ] **Step 4: Generate and consume the checked-in manifest**

Run from the repository root: `pnpm --dir apps/web seo:lastmod`.

Update `sitemap.ts` to use `STATIC_LASTMOD` for static/docs/tag routes and existing frontmatter dates for blog posts. Production sitemap code must not invoke Git or read filesystem mtimes.

- [ ] **Step 5: Verify focused tests and the built distribution**

Run:

```bash
pnpm --filter @dawn-ai/web test -- app/sitemap.test.ts
pnpm --filter @dawn-ai/web build
```

Expected: tests PASS; `/sitemap.xml` remains static; its URL count equals `2 + ALL_DOCS_PAGES.length + getAllPosts().length + getAllTags().length` (88 for the current checked-out inventory), and it has more than ten distinct dates. Keep the deployed 66-URL count only as the production baseline; do not force the newer source inventory to match it.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/sitemap.ts apps/web/app/sitemap.test.ts apps/web/app/seo/lastmod.generated.ts apps/web/scripts/generate-seo-lastmod.mjs apps/web/package.json
git commit -m "fix: preserve sitemap modification dates"
```

## Task 3: Prove the metadata mechanism on one page

**Files:**
- Create: `apps/web/app/seo/types.ts`
- Create: `apps/web/app/seo/registry.ts`
- Create: `apps/web/app/seo/resolve.ts`
- Create: `apps/web/app/seo/structured-data.ts`
- Create: `apps/web/app/seo/JsonLd.tsx`
- Create: `apps/web/app/seo/seo.test.ts`
- Modify: `apps/web/app/docs/getting-started/page.tsx`
- Modify: `apps/web/app/components/docs/DocsPage.tsx`

- [ ] **Step 1: Write failing resolver and equality tests**

Define tests for `/docs/getting-started` requiring:

```ts
const page = resolveStaticSeoPage("/docs/getting-started")
expect(page.description).toBe(
  "Build a typed Dawn research agent with file-system routes, generated types, local tools, offline tests, and production build targets.",
)
expect(toMetadata(page).description).toBe(page.description)
expect(techArticleJsonLd(page).description).toBe(page.description)
expect(page.canonical).toBe("https://dawnai.org/docs/getting-started")
expect(page.breadcrumbs).toEqual(breadcrumbsFor("/docs/getting-started"))
expect(breadcrumbJsonLd(page).itemListElement.map(({ name }) => name)).toEqual(
  breadcrumbsFor("/docs/getting-started").map(({ label }) => label),
)
```

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm --filter @dawn-ai/web test -- app/seo/seo.test.ts`

Expected: FAIL because the SEO modules do not exist.

- [ ] **Step 3: Implement the minimal normalized contract**

Implement `SeoPage` with `path`, `canonical`, `title`, `description`, `kind`, `breadcrumbs`, and `lastModified`. Implement one registry entry, `resolveStaticSeoPage`, `toMetadata`, `techArticleJsonLd`, `breadcrumbJsonLd`, and a `JsonLd` component that escapes `<` as `\u003c` before rendering `application/ld+json`. For docs routes, the resolver must call the existing `breadcrumbsFor(path)` function; do not create a second breadcrumb registry.

- [ ] **Step 4: Wire only Getting Started**

Replace its title-only export with:

```ts
export const metadata = toMetadata(resolveStaticSeoPage("/docs/getting-started"))
```

Have `DocsPage` emit the TechArticle and breadcrumb graph for this registered route while leaving unregistered routes unchanged during the proof. Both `DocsBreadcrumb` and the JSON-LD builder must receive the output of the same `breadcrumbsFor(href)` function, with tests comparing labels, order, and resolved URLs.

- [ ] **Step 5: Run the proof build and inspect rendered HTML**

Run:

```bash
pnpm --filter @dawn-ai/web test -- app/seo/seo.test.ts
pnpm --filter @dawn-ai/web build
rg -n "Build a typed Dawn research agent|rel=.?canonical|application/ld\\+json" apps/web/.next/server/app/docs/getting-started.html
```

Expected: the exact description appears in metadata and JSON-LD, the self-canonical appears, and tests PASS. Stop the plan if any value is absent or differs; do not author Task 5 descriptions.

- [ ] **Step 6: Commit the proven mechanism**

```bash
git add apps/web/app/seo apps/web/app/docs/getting-started/page.tsx apps/web/app/components/docs/DocsPage.tsx
git commit -m "feat: add shared page metadata resolver"
```

## Task 4: Add site and blog structured data

**Files:**
- Modify: `apps/web/app/seo/resolve.ts`
- Modify: `apps/web/app/seo/structured-data.ts`
- Modify: `apps/web/app/seo/seo.test.ts`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/blog/page.tsx`
- Modify: `apps/web/app/blog/tags/[tag]/page.tsx`
- Modify: `apps/web/app/blog/[slug]/page.tsx`
- Modify: `apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx`
- Modify: `apps/web/content/blog/2026-06-18-eve-validates-the-shape.mdx`

- [ ] **Step 1: Write failing graph tests**

Require Organization and WebSite entities to contain only name, URL, and published logo references; require `/blog`, every generated tag route, and every blog post to normalize to `SeoPage`; require every resolved description to be 50-155 characters and meta/Open Graph/Twitter/page-JSON-LD descriptions to match; require `Person.name` to equal the published display name at `AUTHORS[post.author].name`, not the internal author ID; and require blog breadcrumbs to resolve Home → Blog → post or tag.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm --filter @dawn-ai/web test -- app/seo/seo.test.ts`

- [ ] **Step 3: Implement normalized blog resolution and graphs**

Add `resolveBlogIndexSeoPage()`, `resolveBlogTagSeoPage(tag, posts)`, and `resolveBlogSeoPage(post)` so metadata, JSON-LD, and later sitemap inventory code consume normalized `SeoPage` objects. Keep the existing published blog-index description; derive each tag description only from its route label and actual post set. The failing length test identifies two published frontmatter descriptions at 170 and 201 characters; read each full post and shorten those fields to factual, query-answering descriptions no longer than 155 characters before rendering them. Do not add biography, credentials, employers, awards, education, clients, certifications, or unsupported `sameAs` values.

- [ ] **Step 4: Render sitewide and blog JSON-LD**

Render Organization/WebSite in the root layout without conflicting descriptions. Render CollectionPage and BreadcrumbList on `/blog` and tag pages. Render BlogPosting, Person, and BreadcrumbList on post pages. Preserve the existing canonical and article dates.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm --filter @dawn-ai/web test -- app/seo/seo.test.ts
pnpm --filter @dawn-ai/web build
```

Expected: PASS and blog pages remain SSG.

Commit:

```bash
git add apps/web/app/seo apps/web/app/layout.tsx apps/web/app/blog/page.tsx 'apps/web/app/blog/tags/[tag]/page.tsx' 'apps/web/app/blog/[slug]/page.tsx' apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx apps/web/content/blog/2026-06-18-eve-validates-the-shape.mdx
git commit -m "feat: add factual structured data"
```

## Task 5: Roll out factual documentation metadata

**Files:**
- Modify: `apps/web/app/seo/registry.ts`
- Modify: `apps/web/app/seo/seo.test.ts`
- Modify: every `apps/web/app/docs/**/page.tsx` represented by `ALL_DOCS_PAGES`

- [ ] **Step 1: Tighten tests before adding content**

Require exact equality between `ALL_DOCS_PAGES` hrefs and docs registry keys. Require every description to be unique, end with punctuation, and be at most 155 characters. Require every docs page module to call the resolver for its own href. Add a checked-in source path beside each registry entry so implementation review can trace every authored description to the MDX page that supports it; factual support is a required manual review, not something a length test can prove.

- [ ] **Step 2: Verify coverage tests fail**

Run: `pnpm --filter @dawn-ai/web test -- app/seo/seo.test.ts`

Expected: FAIL with missing registry entries for all docs routes except Getting Started.

- [ ] **Step 3: Author descriptions from published content**

For each route, read its owning `apps/web/content/docs/**/*.mdx` in full, then add one 75-155 character query-answering description and its exact source path. Record the supporting page heading or passage in the audit's content-evidence table without long quotations. Do not infer biography, adoption, customer, performance, compatibility, or support claims beyond the page. Treat the existing inherited homepage description as broken, not as usable fallback content.

- [ ] **Step 4: Mechanically wire every docs page**

Replace each title-only metadata export with `toMetadata(resolveStaticSeoPage("<exact href>"))`. Use `apply_patch`; do not run an unconstrained formatter or rewrite unrelated page code.

- [ ] **Step 5: Verify all generated docs HTML**

Run the SEO tests and web build, then scan every generated docs HTML file. Expected: one meta description, one self-canonical, TechArticle plus matching BreadcrumbList JSON-LD, and exact meta/JSON-LD description equality for every docs route.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/seo apps/web/app/docs
git commit -m "fix: add route-specific search metadata"
```

## Task 6: Apply the measured homepage experiment

**Files:**
- Modify: `apps/web/app/seo/registry.ts`
- Modify: `apps/web/app/seo/structured-data.ts`
- Modify: `apps/web/app/seo/seo.test.ts`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/sitemap.ts`
- Modify: `apps/web/app/sitemap.test.ts`

- [ ] **Step 1: Write the failing homepage tests**

Require a normalized homepage `SeoPage`, a title that front-loads `Dawn AI` and the distinctive TypeScript/LangGraph term, and exact meta/Open Graph/Twitter/WebPage-JSON-LD description equality. Against the complete normalized source inventory (`/`, `/blog`, all docs, all posts, and all tags), require every trimmed description to be 50-155 characters, contain no line break or repeated whitespace, end with punctuation, and be globally unique. Report the route pair for any duplicate.

- [ ] **Step 2: Author and render the measured experiment**

Read the current homepage content in full. Add the homepage to the registry using only capabilities visible there, then feed the resolved title and description to meta, Open Graph, Twitter, and a WebPage JSON-LD entity.

- [ ] **Step 3: Complete the resolver-to-sitemap contract**

Refactor `sitemap.ts` to enumerate the normalized `SeoPage` union for `/`, `/blog`, all docs, all posts, and all tags, then map that union to `MetadataRoute.Sitemap`. Assert exact route equality with the independent source inventory so neither metadata nor sitemap can silently omit a route.

- [ ] **Step 4: Verify and commit separately**

Run the SEO and sitemap tests plus a production build. Inspect the generated homepage HTML for the exact title, description, canonical, and WebPage graph.

```bash
git add apps/web/app/seo apps/web/app/layout.tsx apps/web/app/sitemap.ts apps/web/app/sitemap.test.ts
git commit -m "fix: improve homepage search snippet"
```

## Task 7: Make blog OG images build-local

**Files:**
- Modify: `apps/web/app/blog/[slug]/opengraph-image.tsx`
- Create: `apps/web/app/blog/[slug]/opengraph-image.test.ts`

- [ ] **Step 1: Write the failing image contract**

Call the image function for every `generateImageParams()` slug and require status 200 plus `content-type: image/png`. Add a source invariant that forbids network `fetch` in the image module.

- [ ] **Step 2: Verify the current variable-font path fails**

Run the focused test and a production request against the current built route. Expected: the test or request exposes the network/font dependency corresponding to the live 500.

- [ ] **Step 3: Remove the request-time font dependency**

Use the existing system serif fallback or a checked-in static, non-variable font. Keep `generateImageParams()` exhaustive and preserve the 1200×630 response contract.

- [ ] **Step 4: Verify and commit**

Run focused tests and the web build. Start the production build in a dedicated terminal with:

```bash
pnpm --filter @dawn-ai/web exec next start --hostname 127.0.0.1 --port 3018
```

From a second terminal, use `curl -o /dev/null -w "%{http_code} %{content_type}"` against every blog OG route at `http://127.0.0.1:3018`, then stop the server. Expected: all `200 image/png`.

Commit:

```bash
git add 'apps/web/app/blog/[slug]/opengraph-image.tsx' 'apps/web/app/blog/[slug]/opengraph-image.test.ts'
git commit -m "fix: generate blog social images locally"
```

## Task 8: Make the allow-all crawler policy explicit

**Files:**
- Modify: `apps/web/app/robots.ts`
- Create: `apps/web/app/robots.test.ts`

- [ ] **Step 1: Write the failing policy test**

Require explicit allow rules for GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, Google-Extended, and CCBot. Require `/api/` to remain disallowed and require only `https://dawnai.org/sitemap.xml` as sitemap.

- [ ] **Step 2: Verify it fails, implement, and rerun**

Run: `pnpm --filter @dawn-ai/web test -- app/robots.test.ts`

Expected before implementation: FAIL because only the wildcard rule exists. Expected after implementation: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/robots.ts apps/web/app/robots.test.ts
git commit -m "feat: declare AI crawler access policy"
```

## Task 9: Run pre-deployment verification and update the audit

**Files:**
- Create: `apps/web/scripts/audit-built-seo.mjs`
- Modify: `apps/web/package.json`
- Modify: `docs/superpowers/audits/2026-08-25-dawnai-seo-aeo-audit.md`

- [ ] **Step 1: Refresh and prove the date manifest is reproducible**

Run `pnpm --dir apps/web seo:lastmod` after all substantive content commits. If the two repaired blog descriptions changed `/blog` or tag ownership dates, commit the refreshed `apps/web/app/seo/lastmod.generated.ts` alone with `chore: refresh search modification dates`; do not create an empty commit when it is unchanged. Run the generator again and require `git diff --exit-code -- apps/web/app/seo/lastmod.generated.ts` to pass, proving the checked-in output is reproducible from the final content state.

- [ ] **Step 2: Run focused web gates with Node 24**

```bash
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web build
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web test
```

Record exact output and compare it to baseline.

- [ ] **Step 3: Run the repository validation lane**

Run: `pnpm ci:validate`

Record the full outcome. If the unrelated CLI port-race repeats, report it with output and rerun only that exact test once; do not fix or hide it.

- [ ] **Step 4: Add and run exact built-route enumeration**

Add `seo:audit-built` to `apps/web/package.json`. The script requests the locally started production build's `/sitemap.xml`, substitutes only the origin with the local server, and visits every enumerated URL. For each HTML route it asserts status/type, exactly one non-empty meta description of at most 155 characters, one self-canonical, the expected page JSON-LD type, and exact page-JSON-LD/meta description equality. It also checks sitemap count/date distribution, `robots.txt`, `llms.txt`, `llms-full.txt`, and every generated blog OG URL. Fail on any missing or extra source-inventory URL.

Start the production build with `pnpm --filter @dawn-ai/web exec next start --hostname 127.0.0.1 --port 3018`, run the audit against `http://127.0.0.1:3018`, then stop the server. Save its exact summary in the audit. These are mechanism/build claims only, not production claims.

- [ ] **Step 5: Update the durable audit and commit**

Include changes, commands/output, degradations, unknowns, analytics blocker, and human actions.

```bash
git add apps/web/scripts/audit-built-seo.mjs apps/web/package.json docs/superpowers/audits/2026-08-25-dawnai-seo-aeo-audit.md
git commit -m "docs: record pre-deployment search verification"
```

## Task 10: Human deployment and production verification

**Files:**
- Modify after deployment: `docs/superpowers/audits/2026-08-25-dawnai-seo-aeo-audit.md`

- [ ] **Step 1: Stop for owner deployment**

Provide the branch/commit and ask the owner to deploy. Do not publish or deploy on the owner's behalf.

- [ ] **Step 2: Verify every live claim with `curl`**

After the owner supplies the deployment timestamp, run direct requests against `https://dawnai.org` for every sitemap URL. Record meta description, length, canonical, JSON-LD types and equality, HTML status/type, sitemap count/distribution, robots/llms surfaces, and every OG response.

- [ ] **Step 3: Run Rich Results Test**

Test one homepage, docs, and blog URL. Record results or state exactly why the check could not be completed.

- [ ] **Step 4: Verify analytics honestly**

Report AI crawler/referrer delivery as blocked because no ingest provider is configured. Do not imply that local detector tests constitute production analytics.

- [ ] **Step 5: Hand off Search Console actions**

Ask the owner to replace the obsolete `/sitemap_index.xml` submission with `/sitemap.xml`. Do not submit the form or request indexing. In the report, require a future check that `lastDownloaded` is newer than deployment before interpreting crawl changes.

- [ ] **Step 6: Finish the report**

State that the earliest honest CTR read is roughly one week after deployment, once the final Search Console window includes the change. Commit only after all observed production evidence is recorded.
