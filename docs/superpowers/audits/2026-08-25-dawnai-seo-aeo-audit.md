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

| URL | Coverage state | Last crawl time | User-declared canonical | Google-selected canonical |
| --- | --- | --- | --- | --- |
| https://dawnai.org/blog/why-we-built-dawn | Crawled - currently not indexed | 2026-05-12T18:30:39Z | https://dawnai.org/blog/why-we-built-dawn | https://dawnai.org/blog/why-we-built-dawn |
| https://dawnai.org/docs/api | URL is unknown to Google | — | — | — |
| https://dawnai.org/docs/cli | Crawled - currently not indexed | 2026-05-28T02:57:17Z | — | https://dawnai.org/docs/cli |
| https://dawnai.org/docs/deployment | URL is unknown to Google | — | — | — |
| https://dawnai.org/docs/deployment/edge | URL is unknown to Google | — | — | — |
| https://dawnai.org/docs/deployment/kubernetes | URL is unknown to Google | — | — | — |
| https://dawnai.org/docs/dev-server/agent-protocol | URL is unknown to Google | — | — | — |
| https://dawnai.org/docs/evals | URL is unknown to Google | — | — | — |
| https://dawnai.org/docs/middleware | URL is unknown to Google | — | — | — |
| https://dawnai.org/docs/recipes/auth-middleware | URL is unknown to Google | — | — | — |
| https://dawnai.org/docs/recipes/dispatch-from-route | URL is unknown to Google | — | — | — |
| https://dawnai.org/docs/recipes/stream-output | URL is unknown to Google | — | — | — |
| https://dawnai.org/docs/testing | Crawled - currently not indexed | 2026-05-22T12:43:48Z | — | https://dawnai.org/docs/testing |

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

The following is the URL Inspection continuation of that same 66-row capture,
in the same order. `Path` is relative to `https://dawnai.org`; `self` means
the exact inspected URL. `—` means the API did not report the field. Together
with the HTTP table above, every captured URL has its coverage, crawl, and
canonical fields preserved.

| Path | Coverage state | Last crawl time | User canonical | Google canonical |
| --- | --- | --- | --- | --- |
| /blog | Submitted and indexed | 2026-07-17T02:00:44Z | — | self |
| / | Submitted and indexed | 2026-08-13T15:33:58Z | — | self |
| /docs/agents | Submitted and indexed | 2026-05-17T10:01:16Z | — | self |
| /docs/routes | Submitted and indexed | 2026-07-24T01:38:52Z | — | self |
| /docs/mental-model | Submitted and indexed | 2026-05-26T06:50:42Z | — | self |
| /docs/tools | Submitted and indexed | 2026-08-03T20:28:37Z | — | self |
| /docs/migrating-from-langgraph | Submitted and indexed | 2026-06-22T08:36:40Z | — | self |
| /docs/getting-started | Submitted and indexed | 2026-07-12T13:19:16Z | — | self |
| /docs/workspace | Submitted and indexed | 2026-07-03T14:02:06Z | — | self |
| /docs/memory | Submitted and indexed | 2026-07-03T08:42:12Z | — | self |
| /docs/memory/long-term | Submitted and indexed | 2026-08-23T23:37:53Z | — | self |
| /docs/state | Submitted and indexed | 2026-07-16T16:54:33Z | — | self |
| /docs/memory/episodes | Submitted and indexed | 2026-08-23T23:41:21Z | — | self |
| /docs/memory/retrieval | Submitted and indexed | 2026-08-24T03:06:20Z | — | self |
| /docs/planning | Submitted and indexed | 2026-07-03T13:30:42Z | — | self |
| /docs/memory/distillation | Submitted and indexed | 2026-08-23T22:39:23Z | — | self |
| /docs/skills | Submitted and indexed | 2026-07-03T00:59:11Z | — | self |
| /docs/dev-server | Submitted and indexed | 2026-07-23T19:24:32Z | — | self |
| /docs/subagents | Submitted and indexed | 2026-07-03T01:30:15Z | — | self |
| /docs/dev-server/agent-protocol | URL is unknown to Google | — | — | — |
| /docs/context-management | Submitted and indexed | 2026-07-03T08:21:12Z | — | self |
| /docs/embedding | Submitted and indexed | 2026-08-24T16:03:09Z | — | self |
| /docs/middleware | URL is unknown to Google | — | — | — |
| /docs/reasoning-effort | Submitted and indexed | 2026-07-03T04:42:01Z | — | self |
| /docs/ag-ui | Submitted and indexed | 2026-08-23T19:05:45Z | — | self |
| /docs/blueprints | Submitted and indexed | 2026-07-03T00:15:44Z | — | self |
| /docs/testing-agents/fixtures | Submitted and indexed | 2026-08-24T22:15:10Z | — | self |
| /docs/persistence | Submitted and indexed | 2026-08-23T18:33:03Z | — | self |
| /docs/security-architecture | Submitted and indexed | 2026-08-23T12:20:13Z | — | self |
| /docs/evals | URL is unknown to Google | — | — | — |
| /docs/production-topology | Submitted and indexed | 2026-08-23T21:39:14Z | — | self |
| /docs/testing | Crawled - currently not indexed | 2026-05-22T12:43:48Z | — | self |
| /docs/testing-agents | Submitted and indexed | 2026-07-03T01:02:33Z | — | self |
| /docs/access-control | Submitted and indexed | 2026-08-23T15:11:45Z | — | self |
| /docs/permissions | Submitted and indexed | 2026-07-03T01:15:56Z | — | self |
| /docs/retry | Submitted and indexed | 2026-06-12T08:54:09Z | — | self |
| /docs/observability | Submitted and indexed | 2026-07-03T01:08:38Z | — | self |
| /docs/deployment | URL is unknown to Google | — | — | — |
| /docs/memory/browse | Submitted and indexed | 2026-08-24T00:07:39Z | — | self |
| /docs/inspector | Submitted and indexed | 2026-08-24T12:43:12Z | — | self |
| /docs/upgrading | Submitted and indexed | 2026-08-24T00:15:27Z | — | self |
| /docs/deployment/node | Submitted and indexed | 2026-08-23T19:15:44Z | — | self |
| /docs/deployment/kubernetes | URL is unknown to Google | — | — | — |
| /docs/deployment/langsmith | Submitted and indexed | 2026-08-23T13:08:02Z | — | self |
| /docs/sandbox | Submitted and indexed | 2026-08-23T15:57:19Z | — | self |
| /docs/recipes/add-a-tool | Submitted and indexed | 2026-06-12T12:51:17Z | — | self |
| /docs/recipes | Submitted and indexed | 2026-07-19T16:44:04Z | — | self |
| /docs/deployment/edge | URL is unknown to Google | — | — | — |
| /docs/sandbox/kubernetes | Submitted and indexed | 2026-08-24T00:15:10Z | — | self |
| /docs/recipes/typed-state | Submitted and indexed | 2026-05-27T01:14:41Z | — | self |
| /docs/recipes/auth-middleware | URL is unknown to Google | — | — | — |
| /docs/recipes/stream-output | URL is unknown to Google | — | — | — |
| /docs/recipes/retry-flaky-tools | Submitted and indexed | 2026-05-27T19:23:15Z | — | self |
| /docs/recipes/dispatch-from-route | URL is unknown to Google | — | — | — |
| /docs/recipes/research-web-ui | Submitted and indexed | 2026-08-22T21:56:20Z | — | self |
| /docs/configuration | Submitted and indexed | 2026-08-23T23:19:38Z | — | self |
| /docs/cli | Crawled - currently not indexed | 2026-05-28T02:57:17Z | — | self |
| /docs/errors | Submitted and indexed | 2026-08-23T13:02:51Z | — | self |
| /blog/eve-validates-the-shape | Submitted and indexed | 2026-08-24T08:34:58Z | self | self |
| /docs/faq | Submitted and indexed | 2026-05-25T19:13:34Z | — | self |
| /docs/api | URL is unknown to Google | — | — | — |
| /blog/app-router-for-ai-agents | Submitted and indexed | 2026-05-25T11:23:54Z | self | self |
| /blog/tags/philosophy | Submitted and indexed | 2026-05-25T13:28:53Z | self | self |
| /blog/tags/agents | Submitted and indexed | 2026-05-25T13:03:53Z | self | self |
| /blog/tags/typescript | Submitted and indexed | 2026-05-25T12:38:54Z | self | self |
| /blog/why-we-built-dawn | Crawled - currently not indexed | 2026-05-12T18:30:39Z | self | self |

## Findings classification

## Broken

- The Search Console submitted sitemap is the obsolete
  `https://dawnai.org/sitemap_index.xml`, which was verified as a 404 while
  the live sitemap is `/sitemap.xml`. Its API record is stale, with a last
  download in 2024 and three warnings plus one error.
- Blog-route Open Graph image generation returned HTTP 500 in the earlier live
  audit while the route depended on a request-time remote variable font. The
  root OG route returned 200; without production logs, the status is not
  attributed to that dependency.

## Missing

- 60 of 66 inspected URLs lacked a user-declared canonical. This includes
  the two canonical-less crawled-not-indexed docs pages and all 10 URLs
  unknown to Google.
- The earlier live audit found no JSON-LD on any of the 66 routes.
- 58 total routes matched the homepage description: the homepage itself plus
  57 documentation routes. `/docs/testing-agents` had a distinct description;
  one rendered meta description was 201 characters.
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
exactly below. The header commands show only their first eight response lines
via `sed -n '1,8p'`; those shown lines are unnormalized and include the
returned `age` and `date` headers.

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

# Historical output from the previously recorded 2026-08-26 URL-status run:
urls=83; unexpected=0

# Safe reproduction rerun: each sitemap URL is data read by the loop and is
# passed to curl only as a quoted argument (no URL interpolation into a shell).
$ bash <<'BASH'
set -euo pipefail
processed=0
curl_failures=0
unexpected=0
while IFS= read -r url; do
  processed=$((processed + 1))
  if response=$(curl -sS -o /dev/null -w '%{http_code}\t%{content_type}' "$url"); then
    http=${response%%$'\t'*}
    content=${response#*$'\t'}
    if [ "$http" != 200 ] || [[ "$content" != text/html* ]]; then
      unexpected=$((unexpected + 1))
    fi
  else
    curl_failures=$((curl_failures + 1))
  fi
done < <(curl -fsS https://dawnai.org/sitemap.xml | awk 'BEGIN { RS="<url>" } NR > 1 && match($0, /<loc>[^<]+/) { print substr($0,RSTART+5,RLENGTH-5) }')
printf 'urls=%s; unexpected=%s; curl-failures=%s\n' "$processed" "$unexpected" "$curl_failures"
test "$curl_failures" -eq 0
BASH
urls=83; unexpected=0; curl-failures=0
```

### Current verification of OG, structured data, and descriptions

These safe, direct `curl` checks were also rerun on 2026-08-26 against the
real production URLs. Unlike the sitemap inventory, these current results
reproduced the 2026-08-25 captured findings: the representative blog OG route
still returned 500, no JSON-LD markers were found across the captured 66 URL
list, 58 total routes matched the homepage description (the homepage plus 57
documentation routes), and the same blog post had a 201-character description.
`/docs/testing-agents` was distinct. This is confirmation of the current response,
not a claim that a current request can recreate an earlier crawl or Search
Console state.

The two 66-route checks below are portable from the repository root. Their
`baseline_urls` function extracts the preserved URL inventory from this
report's embedded HTTP table, rather than relying on ignored capture files.

```console
$ curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://dawnai.org/opengraph-image
200 image/png
$ curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://dawnai.org/blog/why-we-built-dawn/opengraph-image
500 text/html; charset=utf-8

$ bash <<'BASH'
set -euo pipefail
report=docs/superpowers/audits/2026-08-25-dawnai-seo-aeo-audit.md
baseline_urls() {
  awk -F '|' '/^\| 200 \| text\/html; charset=utf-8 \| https:\/\/dawnai\.org/ { gsub(/^ +| +$/, "", $4); print $4 }' "$report"
}
processed=0
curl_failures=0
json_ld=0
while IFS= read -r url; do
  processed=$((processed + 1))
  if page=$(curl -fsS "$url"); then
    count=$(printf '%s' "$page" | { rg -o 'application/ld\+json' || true; } | wc -l | tr -d ' ')
    json_ld=$((json_ld + count))
  else
    curl_failures=$((curl_failures + 1))
  fi
done < <(baseline_urls)
printf 'routes=%s; curl-failures=%s; json-ld-script-markers=%s\n' "$processed" "$curl_failures" "$json_ld"
test "$processed" -gt 0
test "$curl_failures" -eq 0
BASH
routes=66; curl-failures=0; json-ld-script-markers=0

$ bash <<'BASH'
set -euo pipefail
report=docs/superpowers/audits/2026-08-25-dawnai-seo-aeo-audit.md
baseline_urls() {
  awk -F '|' '/^\| 200 \| text\/html; charset=utf-8 \| https:\/\/dawnai\.org/ { gsub(/^ +| +$/, "", $4); print $4 }' "$report"
}
processed=0
curl_failures=0
matching=0
overlong=0
root_desc=''
while IFS= read -r url; do
  processed=$((processed + 1))
  if ! page=$(curl -fsS "$url"); then
    curl_failures=$((curl_failures + 1))
    continue
  fi
  meta=$(printf '%s' "$page" | rg -o '<meta[^>]+name="description"[^>]*>' | head -n 1)
  desc=$(printf '%s' "$meta" | sed -n 's/.*content="\([^"]*\)".*/\1/p')
  if [ "$url" = 'https://dawnai.org/' ]; then root_desc=$desc; fi
  if [ "$desc" = "$root_desc" ]; then matching=$((matching + 1)); fi
  if [ "${#desc}" -gt 200 ]; then overlong=$((overlong + 1)); printf 'overlength=%s\t%s\n' "$url" "${#desc}"; fi
  case "$url" in
    https://dawnai.org/|https://dawnai.org/docs/agents|https://dawnai.org/docs/testing-agents)
      printf '%s\tlength=%s\t%s\n' "$url" "${#desc}" "$desc" ;;
  esac
done < <(baseline_urls)
printf 'routes=%s; curl-failures=%s; matching-homepage-description=%s; descriptions-over-200-chars=%s\n' "$processed" "$curl_failures" "$matching" "$overlong"
test "$processed" -gt 0
test "$curl_failures" -eq 0
BASH
https://dawnai.org/	length=151	Dawn adds file-system routing, route-local tools, generated types, and HMR to your existing LangGraph.js stack. Keep the runtime. Drop the boilerplate.
https://dawnai.org/docs/agents	length=151	Dawn adds file-system routing, route-local tools, generated types, and HMR to your existing LangGraph.js stack. Keep the runtime. Drop the boilerplate.
https://dawnai.org/docs/testing-agents	length=63	Test Dawn agents deterministically with the in-process harness.
overlength=https://dawnai.org/blog/eve-validates-the-shape	201
routes=66; curl-failures=0; matching-homepage-description=58; descriptions-over-200-chars=1
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
