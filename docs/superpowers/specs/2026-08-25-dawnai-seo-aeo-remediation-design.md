# Dawnai.org SEO and Answer-Engine Remediation Design

**Status:** Approved on 2026-08-25

## Objective

Make dawnai.org legible to search crawlers and AI answer engines, repair the
failures demonstrated by production and Search Console data, and leave a
repeatable measurement baseline for evaluating the result.

The implementation must preserve this order:

1. verify production and record the repository baseline;
2. measure Search Console state;
3. verify each metadata mechanism with one rendered page;
4. repair broken and missing surfaces;
5. improve only the content supported by sufficient performance data;
6. verify the deployed site with direct `curl` requests.

## Measurement baseline

The Search Console account authorized through OAuth has Owner access to the
`sc-domain:dawnai.org` property.

The latest final 90-day Search Analytics window available on 2026-08-25 was
2026-05-26 through 2026-08-23:

- 3 clicks;
- 382 impressions;
- 0.79% CTR;
- average position 12.27.

No query had 100 impressions. The largest query had 20 impressions, so
query-level CTR differences are not actionable. At page level, only the
homepage exceeded the 100-impression threshold: 227 impressions, 2 clicks,
0.88% CTR, and average position 10.87. The homepage is therefore the only
intentional title or description experiment in this change.

Search Console lists `https://dawnai.org/sitemap_index.xml`, submitted on
2023-08-30 and last downloaded on 2024-04-18, with three warnings and one
error. A production `curl` returned `404 text/html` for that URL. The current
`https://dawnai.org/sitemap.xml` returned `200 application/xml` and contained
66 URLs. `robots.txt` returned `200 text/plain` and advertised the current
sitemap.

URL Inspection returned HTTP 200 for all 66 sitemap URLs:

- 53: `Submitted and indexed`;
- 10: `URL is unknown to Google`;
- 3: `Crawled - currently not indexed`;
- 60: no user-declared canonical;
- 0: chosen-versus-declared canonical disagreements.

All 66 current sitemap URLs returned `200 text/html` in direct production
requests. The sitemap exposed only four distinct `lastmod` values; 63 URLs
shared `2026-08-12T06:48:52.253Z`, demonstrating a build-time timestamp
collapse.

The repository baseline used Node 24.19.0. Lint, build, and typecheck passed.
The full test lane stopped with one unrelated CLI dev-server restart failure:
the test process reported that its selected port was unavailable. An immediate
targeted rerun passed one test with sixteen skipped. This failure must remain
separate from the SEO changes.

## Owner decisions

The owner selected an allow-all AI crawler policy. The explicit policy will
allow the named OpenAI, Anthropic, Perplexity, Google-Extended, and Common Crawl
agents while retaining the existing `/api/` exclusion.

The owner must perform Search Console form submissions. The implementation
will not request indexing or submit or remove sitemaps.

## Architecture

### SEO registry

A central server-only registry owns the page title, description, canonical
path, content type, breadcrumb inputs, and committed modification date for
each indexable route. The registry is the only source for authored page
descriptions.

Documentation page modules call one metadata resolver with their route path.
The existing `DocsPage` component uses the same route path to resolve
structured data. Blog posts continue to use their existing frontmatter, but a
shared resolver feeds both metadata and JSON-LD from the same description.

The resolver must guarantee that the meta, Open Graph, Twitter, and page-level
JSON-LD descriptions are identical strings. The canonical is an absolute,
self-referencing dawnai.org URL.

### Structured data

The root layout emits `Organization` and `WebSite` entities limited to facts
already visible on the site. Page-level entities are:

- `TechArticle` plus `BreadcrumbList` for documentation;
- `BlogPosting`, author `Person`, and `BreadcrumbList` for blog posts;
- a homepage page entity when needed to connect the site graph.

Sitewide entities omit a description if using one would conflict with the
current page's meta description. Page entities include a description only when
it is the exact resolved meta description. Author data comes only from
existing post frontmatter; no biography, credentials, employers, awards, or
other unpublished claims are introduced.

Breadcrumb JSON-LD is produced from the same `breadcrumbsFor` function used by
the visible documentation trail.

### Durable sitemap dates

Production sitemap generation reads modification dates from a checked-in
manifest rather than querying Git during the build. A maintenance script may
refresh the manifest from full local Git history, but shallow production
clones do not affect the emitted values.

The manifest covers every indexable static and documentation route. Blog posts
use their published or explicitly updated content dates. Tests require exact
route coverage, valid ISO dates, and a non-collapsed date distribution.

### Social images

Blog OG images must not fetch a variable font at request time. The image route
will use build-local, parser-compatible assets or the existing system-font
fallback. Known image parameters must be generated during the production
build so layout or font errors fail before deployment.

### Crawler policy

`robots.txt` will state the approved allow-all policy explicitly for the named
AI crawlers, preserve the general allow rule, keep `/api/` disallowed, and
advertise only `https://dawnai.org/sitemap.xml`.

Existing `llms.txt` and `llms-full.txt` routes remain in scope for production
verification. They do not need a new parallel format.

### AI traffic measurement

The web application currently has no analytics ingest destination. Detection
and delivery are therefore a separate blocked change, not a silent no-op in
this implementation.

When a destination is selected, an edge-compatible server adapter will detect
AI crawler user agents and human visits with AI-engine referrers. Events will
contain only the source category, pathname, and event type; they will omit full
query strings and raw user identifiers. Completion requires observing events
at the real provider after its ingest delay.

## Mechanism verification gate

Before authoring the documentation descriptions, implementation will add the
resolver and one Getting Started entry. A production build must demonstrate in
rendered HTML that:

- the authored description appears in the meta tag;
- the self-referencing canonical appears;
- JSON-LD appears;
- the JSON-LD description equals the meta description exactly.

Only after this gate passes may the remaining factual descriptions be added.

## Validation and failure behavior

Tests fail when:

- a docs route lacks a registry entry;
- the registry contains an orphaned route;
- a description is missing, duplicated, malformed, or longer than 155
  characters;
- a canonical is missing, external, or not self-referencing;
- metadata and JSON-LD descriptions differ;
- JSON-LD breadcrumbs differ from the visible trail;
- a sitemap date is missing or invalid;
- the sitemap route and manifest inventories differ;
- the sitemap dates collapse to one timestamp;
- a known OG image cannot be generated.

The relevant web lint, build, typecheck, and test lanes run after each focused
change. The final repository delta is compared with the recorded baseline; the
unrelated CLI port-race failure is neither fixed nor attributed to this work.

## Change boundaries

The implementation is divided into reviewable units:

1. credential ignore rule and measurement record;
2. sitemap date manifest and validation;
3. metadata resolver plus the one-page mechanism proof;
4. factual documentation descriptions, canonicals, and structured data;
5. the measured homepage snippet change;
6. static OG image repair;
7. explicit crawler policy;
8. production verification and owner handoff.

The analytics adapter is excluded until an ingest provider is selected.

## Production verification and human handoff

After the owner deploys, direct `curl` requests must confirm:

- correct meta descriptions under roughly 155 characters;
- self-referencing canonicals;
- route-appropriate JSON-LD;
- exact JSON-LD/meta description equality;
- sitemap URL count and date distribution;
- `200 image/png` for every OG image route;
- explicit robots policy and current sitemap declaration;
- intact visible HTML on representative affected pages.

The Rich Results Test runs against one homepage, documentation, and blog URL.

The owner must then remove or replace the obsolete sitemap submission with
`https://dawnai.org/sitemap.xml` in Search Console. Crawl conclusions must wait
until `lastDownloaded` is newer than the deployment. The earliest honest CTR
read is roughly one week after deployment, once the reporting window includes
the change and Search Console lag has caught up.
