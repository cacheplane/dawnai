# dawnai.org search visibility baseline — 2026-08-25

This is the immutable measurement baseline captured before SEO/AEO remediation.
It records the deployed 66-URL sitemap inventory and the corresponding Search
Console inspection results available on 2026-08-25. It is deliberately not a
current source inventory and must not be revised to reflect later deployments.

The inputs were the ignored, non-secret local captures
`keys/gsc-baseline-2026-08-25.json`,
`keys/url-inspection-2026-08-25.json`, `keys/live-url-status.tsv`, and
`keys/live-sitemap.xml`. No credentials, OAuth codes, tokens, client IDs, or
client-secret material are reproduced here.

## Measurement scope

- Search Console property: `sc-domain:dawnai.org`
- Search Console final-data window: 2026-05-26 through 2026-08-23 (90 days).
  The window ends before the capture date because of Search Console data lag.
- Deployed sitemap baseline: 66 URLs at `https://dawnai.org/sitemap.xml`.
- URL Inspection sample: those same 66 URLs; all returned HTTP 200 in the
  captured live status run.

## Search Console performance

### Aggregate

| Clicks | Impressions | CTR | Average position |
| ---: | ---: | ---: | ---: |
| 3 | 382 | 0.79% | 12.27 |

### Queries (14 rows)

| Query | Clicks | Impressions | CTR | Position |
| --- | ---: | ---: | ---: | ---: |
| dawnai | 1 | 12 | 8.33% | 5.42 |
| curl -i http://127.0.0.1:3001 | 0 | 1 | 0.00% | 5.00 |
| dawn | 0 | 1 | 0.00% | 8.00 |
| dawn agent | 0 | 1 | 0.00% | 5.00 |
| dawn ai | 0 | 20 | 0.00% | 14.05 |
| dawn ai official website | 0 | 4 | 0.00% | 9.50 |
| dawn developers | 0 | 1 | 0.00% | 15.00 |
| dawn labs | 0 | 2 | 0.00% | 29.00 |
| dawn ts | 0 | 2 | 0.00% | 5.50 |
| dawn ui | 0 | 1 | 0.00% | 9.00 |
| dawnfire ai | 0 | 4 | 0.00% | 8.50 |
| dawnline ai | 0 | 3 | 0.00% | 8.67 |
| down ai | 0 | 1 | 0.00% | 15.00 |
| server dawn | 0 | 6 | 0.00% | 7.83 |

No query has 100 impressions; the largest has 20. Query-level CTR is therefore
noise and is not actionable in this baseline.

### Pages (17 rows)

| Page | Clicks | Impressions | CTR | Position |
| --- | ---: | ---: | ---: | ---: |
| https://dawnai.org/ | 2 | 227 | 0.88% | 10.87 |
| https://dawnai.org/docs/tools | 1 | 22 | 4.55% | 13.23 |
| https://dawnai.org/blog | 0 | 9 | 0.00% | 27.56 |
| https://dawnai.org/docs/blueprints | 0 | 1 | 0.00% | 7.00 |
| https://dawnai.org/docs/context-management | 0 | 2 | 0.00% | 29.50 |
| https://dawnai.org/docs/dev-server | 0 | 42 | 0.00% | 11.02 |
| https://dawnai.org/docs/getting-started | 0 | 43 | 0.00% | 13.23 |
| https://dawnai.org/docs/memory | 0 | 1 | 0.00% | 3.00 |
| https://dawnai.org/docs/migrating-from-langgraph | 0 | 38 | 0.00% | 14.84 |
| https://dawnai.org/docs/permissions | 0 | 1 | 0.00% | 52.00 |
| https://dawnai.org/docs/planning | 0 | 1 | 0.00% | 8.00 |
| https://dawnai.org/docs/reasoning-effort | 0 | 9 | 0.00% | 6.78 |
| https://dawnai.org/docs/recipes | 0 | 1 | 0.00% | 10.00 |
| https://dawnai.org/docs/routes | 0 | 2 | 0.00% | 1.50 |
| https://dawnai.org/docs/state | 0 | 1 | 0.00% | 3.00 |
| https://dawnai.org/docs/testing-agents | 0 | 1 | 0.00% | 10.00 |
| https://dawnai.org/docs/workspace | 0 | 1 | 0.00% | 6.00 |

The homepage is the only page above 100 impressions: 227 impressions, 2
clicks, 0.88% CTR, and average position 10.87.

## Sitemap and crawl baseline

### Submitted Sitemap API record

| Field | Value |
| --- | --- |
| Submitted sitemap | `https://dawnai.org/sitemap_index.xml` |
| Submitted | 2023-08-30T22:00:32.314Z |
| Last downloaded | 2024-04-18T02:38:54.152Z |
| Pending | false |
| Is sitemap index | true |
| Warnings | 3 |
| Errors | 1 |

### Captured sitemap state (66 URLs)

- `/sitemap_index.xml`: HTTP 404, `text/html`.
- `/sitemap.xml`: HTTP 200, `application/xml`, with 66 URLs.
- `/robots.txt`: HTTP 200, `text/plain`; wildcard allow, `/api/` disallow, and
  `https://dawnai.org/sitemap.xml` declared.
- All 66 captured sitemap URLs: HTTP 200, `text/html`.
- Last-modified distribution: 63 URLs at `2026-08-12T06:48:52.253Z`; one each
  at `2026-06-18T00:00:00.000Z`, `2026-05-19T00:00:00.000Z`, and
  `2026-05-12T00:00:00.000Z`.

## URL Inspection baseline

All 66 URL Inspection requests received HTTP 200.

| Coverage state | URLs |
| --- | ---: |
| Submitted and indexed | 53 |
| URL is unknown to Google | 10 |
| Crawled - currently not indexed | 3 |

User-declared canonical was absent for 60 of 66 inspected URLs. The six pages
with one were the four indexed blog posts/tag routes, the indexed blog article
`/blog/app-router-for-ai-agents`, and the non-indexed
`/blog/why-we-built-dawn`. Google-selected canonical was absent only where the
URL was unknown; where Google supplied one, it matched the inspected URL. Thus
there were zero declared-versus-Google disagreements; most declarations were
absent rather than conflicting.

### Non-indexed exceptions (13)

`—` means the inspection response did not provide that canonical field.

| URL | Coverage state | User-declared canonical | Google-selected canonical |
| --- | --- | --- | --- |
| https://dawnai.org/blog/why-we-built-dawn | Crawled - currently not indexed | https://dawnai.org/blog/why-we-built-dawn | https://dawnai.org/blog/why-we-built-dawn |
| https://dawnai.org/docs/api | URL is unknown to Google | — | — |
| https://dawnai.org/docs/cli | Crawled - currently not indexed | — | https://dawnai.org/docs/cli |
| https://dawnai.org/docs/deployment | URL is unknown to Google | — | — |
| https://dawnai.org/docs/deployment/edge | URL is unknown to Google | — | — |
| https://dawnai.org/docs/deployment/kubernetes | URL is unknown to Google | — | — |
| https://dawnai.org/docs/dev-server/agent-protocol | URL is unknown to Google | — | — |
| https://dawnai.org/docs/evals | URL is unknown to Google | — | — |
| https://dawnai.org/docs/middleware | URL is unknown to Google | — | — |
| https://dawnai.org/docs/recipes/auth-middleware | URL is unknown to Google | — | — |
| https://dawnai.org/docs/recipes/dispatch-from-route | URL is unknown to Google | — | — |
| https://dawnai.org/docs/recipes/stream-output | URL is unknown to Google | — | — |
| https://dawnai.org/docs/testing | Crawled - currently not indexed | — | https://dawnai.org/docs/testing |

### Captured 66 URL rows

These are the original deployed-baseline HTTP rows from `live-url-status.tsv`,
not a newer source or live sitemap inventory.

| HTTP | Content type | URL |
| ---: | --- | --- |
| 200 | text/html; charset=utf-8 | https://dawnai.org/blog |
| 200 | text/html; charset=utf-8 | https://dawnai.org/ |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/agents |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/routes |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/mental-model |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/tools |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/migrating-from-langgraph |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/getting-started |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/workspace |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/memory |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/memory/long-term |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/state |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/memory/episodes |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/memory/retrieval |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/planning |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/memory/distillation |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/skills |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/dev-server |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/subagents |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/dev-server/agent-protocol |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/context-management |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/embedding |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/middleware |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/reasoning-effort |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/ag-ui |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/blueprints |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/testing-agents/fixtures |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/persistence |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/security-architecture |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/evals |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/production-topology |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/testing |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/testing-agents |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/access-control |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/permissions |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/retry |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/observability |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/deployment |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/memory/browse |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/inspector |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/upgrading |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/deployment/node |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/deployment/kubernetes |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/deployment/langsmith |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/sandbox |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/recipes/add-a-tool |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/recipes |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/deployment/edge |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/sandbox/kubernetes |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/recipes/typed-state |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/recipes/auth-middleware |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/recipes/stream-output |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/recipes/retry-flaky-tools |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/recipes/dispatch-from-route |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/recipes/research-web-ui |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/configuration |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/cli |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/errors |
| 200 | text/html; charset=utf-8 | https://dawnai.org/blog/eve-validates-the-shape |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/faq |
| 200 | text/html; charset=utf-8 | https://dawnai.org/docs/api |
| 200 | text/html; charset=utf-8 | https://dawnai.org/blog/app-router-for-ai-agents |
| 200 | text/html; charset=utf-8 | https://dawnai.org/blog/tags/philosophy |
| 200 | text/html; charset=utf-8 | https://dawnai.org/blog/tags/agents |
| 200 | text/html; charset=utf-8 | https://dawnai.org/blog/tags/typescript |
| 200 | text/html; charset=utf-8 | https://dawnai.org/blog/why-we-built-dawn |

## Findings classification

## Broken

- The Search Console submitted sitemap is the obsolete
  `https://dawnai.org/sitemap_index.xml`, which was verified as a 404 while
  the live sitemap is `/sitemap.xml`. Its API record is stale, with a last
  download in 2024 and three warnings plus one error.
- Blog-route Open Graph image generation returned HTTP 500 in the earlier live
  audit because a remote Fraunces variable-font fetch failed. The root OG
  route returned 200.

## Missing

- 60 of 66 inspected URLs lacked a user-declared canonical. This includes
  the two canonical-less crawled-not-indexed docs pages and all 10 URLs
  unknown to Google.
- The earlier live audit found no JSON-LD on any of the 66 routes.
- 58 documentation routes inherited the homepage description, and one
  rendered meta description was 201 characters.
- The 13 non-indexed exceptions documented above are a crawl/index coverage
  gap at this baseline: 10 unknown to Google and 3 crawled but not indexed.

## Improvable

- The homepage snippet is the only page-level CTR candidate with enough
  volume to observe: 227 impressions, 2 clicks, and 0.88% CTR. It needs
  improved copy/intent alignment, but this is not a query-level conclusion;
  query samples are too small.

## Blocked

- No analytics provider or destination was configured in `apps/web`, so
  post-remediation ingest and conversion measurement cannot yet be evaluated.
- Production-only checks—including Search Console recrawl/index effects and
  production OG rendering after a change—require a deployment and elapsed
  crawl time. They are outside this repository-only baseline.

## Read-only live evidence rerun

The following safe direct requests were rerun on 2026-08-26. They are kept
separate from the 2026-08-25 baseline because the live sitemap has since
changed from 66 to 83 URLs. Commands and concise output are reproduced
exactly below (header dates/ages are intentionally omitted by the commands).

```console
$ curl -sS -D - -o /dev/null https://dawnai.org/sitemap_index.xml | sed -n '1,8p'
HTTP/2 404
accept-ranges: bytes
access-control-allow-origin: *
age: 19798
cache-control: public, max-age=0, must-revalidate
content-disposition: inline; filename="404"
content-type: text/html; charset=utf-8
date: Wed, 26 Aug 2026 15:07:30 GMT

$ curl -sS -D - -o /dev/null https://dawnai.org/sitemap.xml | sed -n '1,8p'
HTTP/2 200
accept-ranges: bytes
access-control-allow-origin: *
age: 0
cache-control: public, max-age=0, must-revalidate
content-disposition: inline; filename="sitemap.xml"
content-type: application/xml
date: Wed, 26 Aug 2026 15:07:31 GMT

$ curl -sS https://dawnai.org/robots.txt
User-Agent: *
Allow: /
Disallow: /api/

Host: https://dawnai.org
Sitemap: https://dawnai.org/sitemap.xml

$ curl -sS https://dawnai.org/sitemap.xml | awk 'BEGIN { RS="<url>"; FS="</url>" } NR > 1 { loc=""; mod=""; if (match($1, /<loc>[^<]+/)) loc=substr($1,RSTART+5,RLENGTH-5); if (match($1, /<lastmod>[^<]+/)) mod=substr($1,RSTART+9,RLENGTH-9); if (loc != "") { n++; dates[mod]++ } } END { print "urls=" n; for (d in dates) print dates[d], d }' | sort
1 2026-05-12T00:00:00.000Z
1 2026-05-19T00:00:00.000Z
1 2026-06-18T00:00:00.000Z
80 2026-08-26T01:59:52.970Z
urls=83

$ curl -sS https://dawnai.org/sitemap.xml | awk 'BEGIN { RS="<url>" } NR > 1 && match($0, /<loc>[^<]+/) { print substr($0,RSTART+5,RLENGTH-5) }' | xargs -n 1 -P 8 -I {} sh -c 'curl -sS -o /dev/null -w "%{http_code}\t%{content_type}\n" "{}"' | awk 'BEGIN { n=0; bad=0 } { n++; if ($1 != 200 || $2 !~ /^text\/html/) bad++ } END { print "urls=" n "; unexpected=" bad }'
urls=83; unexpected=0
```

## Repository verification baseline

The pre-remediation repository baseline was recorded with Node 24.19.0:

| Check | Result |
| --- | --- |
| lint | PASS |
| build | PASS |
| typecheck | PASS |
| tests | 4655 passed, 215 skipped, 1 unrelated CLI port-race failure |
| targeted rerun | 1 passed, 16 skipped |

The unrelated transient failure was
`@dawn-ai/cli test/dev-command.test.ts`:
`dawn dev lifecycle > coalesces bursty edits during restart into at most one follow-up restart`.
Its exact targeted rerun passed one test and skipped 16.
