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

## Documentation metadata content evidence

The route-specific descriptions added during remediation are grounded in the
owning page sections below. Source paths are repository-relative; section
references are concise review pointers rather than quotations.

| href | Source path | Supporting page section or content |
| --- | --- | --- |
| `/docs/getting-started` | `apps/web/content/docs/getting-started.mdx` | What you got; Verify and test; Run it live; deployment guidance. |
| `/docs/mental-model` | `apps/web/content/docs/mental-model.mdx` | The pieces; The runtime; Build vs runtime; Dawn and LangGraph boundaries. |
| `/docs/migrating-from-langgraph` | `apps/web/content/docs/migrating-from-langgraph.mdx` | StateGraph to route; preserved graph code; boundary validation; migration order. |
| `/docs/routes` | `apps/web/content/docs/routes.mdx` | Route entry kinds; pathname rules; typed workflows; route dispatch. |
| `/docs/agents` | `apps/web/content/docs/agents.mdx` | Minimal agent; model providers; retry; built-in agent features. |
| `/docs/tools` | `apps/web/content/docs/tools.mdx` | Discovery and generated types; shared tools; scoping; approvals; constraints; runtime signature. |
| `/docs/state` | `apps/web/content/docs/state.mdx` | State schema and defaults; dynamic segments; custom reducers; state flow. |
| `/docs/workspace` | `apps/web/content/docs/workspace.mdx` | Pluggable backend; middleware; four agent tools; `ctx.fs`; permissions. |
| `/docs/memory` | `apps/web/content/docs/memory.mdx` | Comparison of workspace prompt, route prompt, and typed long-term memory. |
| `/docs/memory/long-term` | `apps/web/content/docs/memory/long-term.mdx` | Collection schema; generated tools; identity reconciliation; governance; stores. |
| `/docs/memory/retrieval` | `apps/web/content/docs/memory/retrieval.mdx` | Generated recall tool; ranking; semantic recall; Postgres backend; evaluation. |
| `/docs/memory/episodes` | `apps/web/content/docs/memory/episodes.mdx` | Run recorder; recorded data; retention; time-windowed recall; authored episodes. |
| `/docs/memory/distillation` | `apps/web/content/docs/memory/distillation.mdx` | Consolidation; reflection; provenance; cost controls; scheduling. |
| `/docs/planning` | `apps/web/content/docs/planning.mdx` | Quick start; `writeTodos`; state and prompts; streaming; generated types. |
| `/docs/skills` | `apps/web/content/docs/skills.mdx` | Route skill discovery; frontmatter; model-visible list; `readSkill`; generated types. |
| `/docs/subagents` | `apps/web/content/docs/subagents.mdx` | Convention and keyed registration; tool inheritance; delegation policy; approvals; streaming. |
| `/docs/context-management` | `apps/web/content/docs/context-management.mdx` | Tool-output offloading; cleanup; conversation summarization; composition. |
| `/docs/reasoning-effort` | `apps/web/content/docs/reasoning-effort.mdx` | Quick start; supported values; scope; provider pass-through; subagent configuration. |
| `/docs/dev-server` | `apps/web/content/docs/dev-server.mdx` | Starting and invoking the server; restart cycle; logging; protocol links. |
| `/docs/dev-server/agent-protocol` | `apps/web/content/docs/dev-server/agent-protocol.mdx` | Endpoint table; SSE; interrupts and resume; run coordination; memory candidates. |
| `/docs/middleware` | `apps/web/content/docs/middleware.mdx` | Global middleware; context flow; endpoint coverage; load failures. |
| `/docs/ag-ui` | `apps/web/content/docs/ag-ui.mdx` | Endpoint and web client; adapter API; activities; threading; disconnect behavior. |
| `/docs/embedding` | `apps/web/content/docs/embedding.mdx` | Standalone versus embedded; fetch composition; rooted paths; resource ownership and shutdown. |
| `/docs/blueprints` | `apps/web/content/docs/blueprints.mdx` | Listing, applying, self-hosting, and authoring blueprint guides. |
| `/docs/testing` | `apps/web/content/docs/testing.mdx` | Scenario builder; typed tool mocks; server execution; tool and filesystem harnesses. |
| `/docs/testing-agents` | `apps/web/content/docs/testing-agents.mdx` | Deterministic fixtures; harness execution; assertions; execution-boundary factories. |
| `/docs/testing-agents/fixtures` | `apps/web/content/docs/testing-agents/fixtures.mdx` | Fixture choice and matching; file replay; recording; live mode; CI and cleanup. |
| `/docs/evals` | `apps/web/content/docs/evals.mdx` | Datasets; scorers; gates; replay versus live execution; reports. |
| `/docs/persistence` | `apps/web/content/docs/persistence.mdx` | Persistence matrix; local and shared stores; tenant ownership; deletion; migration. |
| `/docs/production-topology` | `apps/web/content/docs/production-topology.mdx` | Single process; shared persistence; replicas; streaming; readiness; shutdown. |
| `/docs/security-architecture` | `apps/web/content/docs/security-architecture.mdx` | Service edge; endpoint coverage; tenant authorization; inner agent controls. |
| `/docs/access-control` | `apps/web/content/docs/access-control.mdx` | Tool scoping; permission gates; execution sandbox; guarded delegation. |
| `/docs/thread-access` | `apps/web/content/docs/thread-access.mdx` | Policy shape; ownership stamp; resume handling; denials; failure modes; endpoint composition. |
| `/docs/permissions` | `apps/web/content/docs/permissions.mdx` | Modes; command and path gates; tool and subagent approval; memory writes; resume. |
| `/docs/retry` | `apps/web/content/docs/retry.mdx` | Retry configuration; retryable errors; backoff; streaming; abort signals. |
| `/docs/observability` | `apps/web/content/docs/observability.mdx` | LangSmith tracing; trace inspection; nested activity; live SSE. |
| `/docs/inspector` | `apps/web/content/docs/inspector.mdx` | Memory store selection; search and filters; timeline; candidate decisions; security posture. |
| `/docs/memory/browse` | `apps/web/content/docs/memory/browse.mdx` | Server-owned boundary; filters; sorting; cursor pagination; mutations. |
| `/docs/upgrading` | `apps/web/content/docs/upgrading.mdx` | Fixed-group versions; release notes; upgrade workflow; Node and import migrations. |
| `/docs/deployment` | `apps/web/content/docs/deployment.mdx` | Target comparison; validation and build; target guides; explicit non-goals. |
| `/docs/deployment/node` | `apps/web/content/docs/deployment/node.mdx` | Node requirements; Docker image; secrets; durable storage; health and shutdown. |
| `/docs/deployment/kubernetes` | `apps/web/content/docs/deployment/kubernetes.mdx` | Helm install; probes; ServiceAccounts; persistence; rollouts; replica coordination. |
| `/docs/deployment/langsmith` | `apps/web/content/docs/deployment/langsmith.mdx` | Build output; assistant IDs; platform boundary and missing HTTP surfaces; Node mismatch. |
| `/docs/deployment/edge` | `apps/web/content/docs/deployment/edge.mdx` | Fit and evidence boundary; emitted artifacts; rejected filesystem capabilities. |
| `/docs/sandbox` | `apps/web/content/docs/sandbox.mdx` | Isolation layers; configuration; lifecycle; provider policies; conformance and testing. |
| `/docs/sandbox/kubernetes` | `apps/web/content/docs/sandbox/kubernetes.mdx` | Infrastructure chart; provider setup; RBAC; PVC lifecycle; network and resource controls. |
| `/docs/recipes` | `apps/web/content/docs/recipes/index.mdx` | Build, integrate, test, and deploy recipe catalog. |
| `/docs/recipes/add-a-tool` | `apps/web/content/docs/recipes/add-a-tool.mdx` | Route and shared tool placement; typegen; typed workflow invocation. |
| `/docs/recipes/typed-state` | `apps/web/content/docs/recipes/typed-state.mdx` | Zod state; workflow parsing; defaults; parameterized route input. |
| `/docs/recipes/auth-middleware` | `apps/web/content/docs/recipes/auth-middleware.mdx` | Authentication middleware; verified context; endpoint coverage warning. |
| `/docs/recipes/stream-output` | `apps/web/content/docs/recipes/stream-output.mdx` | Streaming endpoint; SSE parser; event types; heartbeats; retry caveat. |
| `/docs/recipes/retry-flaky-tools` | `apps/web/content/docs/recipes/retry-flaky-tools.mdx` | Per-route retry example; transient failures; backoff; stream and tool-retry boundaries. |
| `/docs/recipes/dispatch-from-route` | `apps/web/content/docs/recipes/dispatch-from-route.mdx` | Generated subagent task dispatch; cross-service Agent Protocol HTTP path. |
| `/docs/recipes/research-web-ui` | `apps/web/content/docs/recipes/research-web-ui.mdx` | CopilotKit connection; workbench shell; activities; permissions; memory review. |
| `/docs/configuration` | `apps/web/content/docs/configuration.mdx` | Annotated config and references for discovery, backends, stores, targets, sandbox, and memory. |
| `/docs/cli` | `apps/web/content/docs/cli.mdx` | Command inventory and individual command reference sections. |
| `/docs/api` | `apps/web/content/docs/api.mdx` | Package and surface index; reference conventions for exports and lifecycle behavior. |
| `/docs/api/sdk` | `apps/web/content/docs/api/sdk.mdx` | Root, pure, and testing exports; route-authoring contracts. |
| `/docs/api/cli` | `apps/web/content/docs/api/cli.mdx` | Root, fetch, and runtime exports; `serveRuntime` contract. |
| `/docs/api/core` | `apps/web/content/docs/api/core.mdx` | Root and Node exports; config loading; route discovery; state and type generation. |
| `/docs/api/ag-ui` | `apps/web/content/docs/api/ag-ui.mdx` | Root, SSE, and React exports; translation calls; activity payloads. |
| `/docs/api/memory` | `apps/web/content/docs/api/memory.mdx` | Store and query APIs; namespace and ranking utilities; persistence and recall. |
| `/docs/api/memory-pgvector` | `apps/web/content/docs/api/memory-pgvector.mdx` | Store configuration; dimensions; initialization; pool ownership; retrieval. |
| `/docs/api/postgres-storage` | `apps/web/content/docs/api/postgres-storage.mdx` | Checkpoint, thread, and permission stores; entry points; migrations; pool ownership. |
| `/docs/api/testing` | `apps/web/content/docs/api/testing.mdx` | Harness, fixture, matcher, recorder, and conformance exports. |
| `/docs/api/evals` | `apps/web/content/docs/api/evals.mdx` | Evaluation definition; runner; scorers; aggregation and gates. |
| `/docs/api/generated-routes` | `apps/web/content/docs/api/generated-routes.mdx` | Route paths and parameters; generated tool and state types; regeneration rules. |
| `/docs/api/permissions` | `apps/web/content/docs/api/permissions.mdx` | Matching rules; request types; modes; pattern boundaries; store lifecycle. |
| `/docs/api/workspace` | `apps/web/content/docs/api/workspace.mdx` | Filesystem, command, middleware, sandbox, and Node backend contracts. |
| `/docs/api/sandbox` | `apps/web/content/docs/api/sandbox.mdx` | Docker and Kubernetes providers; lifecycle; network caveats; conformance suite. |
| `/docs/api/langgraph` | `apps/web/content/docs/api/langgraph.mdx` | Graph and workflow contracts; normalization; adapter lifecycle and failures. |
| `/docs/api/langchain` | `apps/web/content/docs/api/langchain.mdx` | Agent materialization; providers; retry; tool loops; offload; summarization; subagents. |
| `/docs/api/sqlite-storage` | `apps/web/content/docs/api/sqlite-storage.mdx` | Checkpoint and thread stores; ordering; database modes; lifecycle. |
| `/docs/errors` | `apps/web/content/docs/errors.mdx` | Error-code ranges and generated category table. |
| `/docs/faq` | `apps/web/content/docs/faq.mdx` | Adopting, working in, and operating Dawn question groups. |

## Pre-deployment verification — 2026-08-26

This section records verification of the branch's local production build. It
does not revise the immutable 2026-08-25 Search Console baseline above, and it
does not claim that the branch has been deployed. The deployed site remains
described by the direct 2026-08-26 requests in [Read-only live evidence
rerun](#read-only-live-evidence-rerun): the live sitemap had 83 URLs, while the
representative post image still returned 500, the preserved production sample
had no JSON-LD markers, 58 routes shared the homepage description, and one post
description was 201 characters. Only an owner deployment can change those
production observations.

### Reviewable units and commits

The remediation was kept in focused commits. The groups below are review
boundaries, not a claim that commits inside a group all change the same runtime
mechanism.

| Unit | Commits or pending commit | Scope |
| --- | --- | --- |
| Design and baseline evidence | `6a8f15fc`, `beb8747c`, `baaed743`, `cfd25360`, `0a9fe355`, `7fc36bef`, `23dc5703`, `4efc7d5b`, `2992a37b` | Design review, immutable Search Console and deployed-response evidence, and reproducible read-only checks. |
| Sitemap dates and freshness | `25835ebe`, `45059d1d`, `db83891a`, `5fac332d`, `cd034845` | Durable last-modified dates, visibility alignment, final-state generation checks, full-history CI checkout, and the separately reviewed workflow-contract fixture update. |
| Shared metadata and structured data | `c9858de8`, `abd53101`, `ae3981f2`, `86591e61`, `52188843`, `26c77625`, `594272ce`, `37186c66`, `477a6da2` | Shared page resolution, canonical and social metadata, factual page JSON-LD, route descriptions, and registry coverage. |
| Route and sitemap visibility contracts | `150de558`, `c53c615e`, `ad4c74da`, `2cccf838`, `7e5003dd` | Docs wrapper rejection, homepage snippet normalization, explicit UTC scheduled visibility, and exact sitemap inventory tests. |
| Blog social images | `100dda7c`, `a91e5cab` | Co-located production post images and fail-closed draft/unknown image routes. |
| Crawler policy | `00241407` | Wildcard and ten owner-approved named crawler groups, `/api/` exclusion, canonical host, and one sitemap. |
| Pre-deployment evidence | `69ee520b` | Independent built-site audit, focused parser tests, package command, and this report section. |
| Sitemap date-distribution regression | `test: enforce sitemap date distribution` (review follow-up commit) | Executable 2026-08-26 minimum of 25 distinct sitemap dates, 24/25 boundary tests, and repeated built-site evidence. |

The Task 9 commit contains only:

- `apps/web/scripts/audit-built-seo.mjs`
- `apps/web/app/seo/audit-built-seo.test.ts`
- `apps/web/package.json`
- this report

The review follow-up contains only the audit script, its focused test, and this
report. It does not change product, CI, or deployment behavior.

### Manifest final-state gate

All commands in this section ran from the repository root with Node 24.19.0
selected explicitly. After the preceding content commits, generation made no
working-tree change and the check mode exited zero:

```console
$ PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm --dir apps/web seo:lastmod

> @dawn-ai/web@0.0.0 seo:lastmod
> node scripts/generate-seo-lastmod.mjs

$ git status --short

$ PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm --dir apps/web seo:lastmod:check

> @dawn-ai/web@0.0.0 seo:lastmod:check
> node scripts/generate-seo-lastmod.mjs --check

# exit 0
```

`git diff --exit-code -- apps/web/app/seo/lastmod.generated.ts` also exited
zero. No separate manifest commit was required.

### Audit-tool RED/GREEN evidence

The initial focused tests were written before the implementation. The first
RED run failed because `../../scripts/audit-built-seo.mjs` did not exist.
Subsequent RED/GREEN cycles covered the package-manager argument separator,
Next's root canonical serialization, legitimate `ENOENT` text inside the full
reference, and a docs-heading collision. The final focused result was:

```console
$ PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/seo/audit-built-seo.test.ts

Test Files  1 passed (1)
Tests       8 passed (8)
```

Those initial tests fail closed on malformed JSON-LD, duplicate description or
canonical metadata, JSON-LD graph flattening errors, an inexact robots group,
invalid PNG signature or IHDR dimensions, and missing, extra, duplicate, or
reordered inventory URLs.

Development exposed three audit-only issues before the final evidence run:

- the first web build found two implicit-`any` callback parameters in the new
  test (`TS7006`); they were typed and the full build was rerun;
- the first package invocation forwarded `--` as a literal argument; a RED test
  was added before accepting the separator;
- initial black-box rules treated the root canonical's omitted slash,
  documented `ENOENT` text, and a repeated authored heading as failures; each
  was traced to the built response or source contract and received a focused
  regression test before the audit was rerun.

None of those was a product behavior change or a deployed-site claim.

Review then identified that the audit reported 25 distinct sitemap dates but
would accept as few as 11. A focused RED run added the current-snapshot boundary
before the implementation and failed two new cases while the original eight
passed. The implementation defines 25 as the minimum for the 2026-08-26
production inventory snapshot: 24 fails and 25 passes. A non-current explicit
date retains the general requirement of more than ten distinct dates.

```console
$ PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/seo/audit-built-seo.test.ts

# RED
Test Files  1 failed (1)
Tests       2 failed | 8 passed (10)

# GREEN
Test Files  1 passed (1)
Tests       10 passed (10)
Duration    315ms
```

### Focused web gates

Fresh focused gates ran under explicit Node 24 after the initial audit code was
final:

```console
$ PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm --dir apps/web lint
Checked 197 files in 68ms. No fixes applied.

$ PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm --dir apps/web build
✓ Compiled successfully in 1912ms
✓ Generating static pages using 9 workers (105/105) in 1679ms

$ PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm --dir apps/web typecheck
# exit 0

$ PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm --dir apps/web test
Test Files  27 passed (27)
Tests       582 passed (582)
Duration    54.19s
```

A final fresh production build immediately before the black-box audit also
exited zero, compiled in 3.4 seconds, and generated 105 of 105 static pages in
3.1 seconds.

After the date-distribution review change, the full web test lane exercised the
ten audit tests successfully but one unrelated last-modified manifest test hit
its five-second timeout under the parallel load. The exact failing test passed
on its one permitted focused rerun:

```console
$ PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm --dir apps/web test
Test Files  1 failed | 26 passed (27)
Tests       1 failed | 583 passed (584)
Duration    64.61s

FAIL app/seo/generate-lastmod.test.ts > generate-seo-lastmod > fails check mode when a target manifest is stale without changing the checked-in manifest
Error: Test timed out in 5000ms.

$ PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/seo/generate-lastmod.test.ts -t "fails check mode when a target manifest is stale without changing the checked-in manifest"
Test Files  1 passed (1)
Tests       1 passed | 5 skipped (6)
Duration    4.08s
```

The review follow-up changes only the audit tool, its test, and this report, so
the complete repository validation below was not rerun. No product or CI code
changed after that successful validation.

The original Node 24 repository baseline remains the earlier table: lint,
build, and typecheck passed; source tests had 4,655 passed, 215 skipped, and one
unrelated CLI port-race failure; the exact targeted rerun passed one and skipped
16. The final repository source suite had 4,741 passed, 215 skipped, and zero
failures: a delta of +86 passed, unchanged skipped, and one fewer failure. The
baseline did not preserve a web-only test count, so 582 is the final focused
count but no historical web-only delta is inferred.

### Local production black-box audit

The audit constructs its expected ordered inventory independently from the
repository sources: `/`, `/blog`, the 75 `ALL_DOCS_PAGES` entries reconstructed
from the docs navigation sources, and production-visible post and tag sources
for the explicit UTC date. It does not use the sitemap response as its expected
URL oracle.

The exact server command was:

```console
$ PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm --filter @dawn-ai/web exec next start --hostname 127.0.0.1 --port 3018
▲ Next.js 16.3.0
- Local: http://127.0.0.1:3018
✓ Ready in 129ms
```

Readiness used repeated successful requests to `/sitemap.xml`, not a fixed long
sleep. The first readiness request succeeded. The audit command and complete
deterministic summary were:

```console
$ PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm --dir apps/web seo:audit-built -- --base-url http://127.0.0.1:3018 --as-of 2026-08-26

SEO built audit: PASS
base=http://127.0.0.1:3018 asOf=2026-08-26
inventory=83 docs=75 posts=3 tags=3
sitemap=83 lastmodDates=25 html=83 jsonLdEntities=331
robotsGroups=11 llms=2 llmsDocs=75 ogImages=3 og404s=2
failures=0
```

The server was interrupted after the audit, and a one-second bounded request
confirmed `server-stopped`.

The review follow-up reused the unchanged fresh production build because it
does not modify any product or build input. The same exact server and audit
commands were run again; the server was ready in 200ms, the first readiness
request succeeded, and the complete deterministic audit summary was unchanged:

```console
SEO built audit: PASS
base=http://127.0.0.1:3018 asOf=2026-08-26
inventory=83 docs=75 posts=3 tags=3
sitemap=83 lastmodDates=25 html=83 jsonLdEntities=331
robotsGroups=11 llms=2 llmsDocs=75 ogImages=3 og404s=2
failures=0
```

The server was again interrupted and a bounded request confirmed
`server-stopped`.

The summary represents all of these local-build assertions:

| Surface | Result |
| --- | --- |
| Independent source inventory | Exactly 83 ordered URLs: 2 top-level, 75 docs, 3 visible posts, and 3 visible tags as of 2026-08-26 UTC. |
| Sitemap | Exact source URL set and order; 83 valid ISO `lastmod` values with 25 distinct dates; the executable 2026-08-26 regression floor is at least 25 (24 fails and 25 passes); no `/docs` redirect, draft, future, missing, extra, or duplicate URL. |
| HTML and metadata | All 83 sitemap URLs returned 200 `text/html`, nonempty visible text, one nonempty description of at most 155 characters, one production self-canonical, and equal standard, Open Graph, Twitter, and page-JSON-LD descriptions. |
| Structured data | 331 flattened entities: exact constrained sitewide Organization and WebSite data on every page, one expected page type per route, 82 applicable BreadcrumbLists, one homepage WebPage, and no homepage WebPage on another route. Malformed JSON-LD is fatal. |
| Robots | One wildcard plus exactly ten approved named agents in order; every group has only `Allow: /` and `Disallow: /api/`; one correct Host and one `sitemap.xml`; no `sitemap_index`. |
| LLM files | Both returned 200 `text/plain`, were nonempty and free of obvious error-document regressions; `llms-full.txt` contained the exact authored section for all 75 docs pages. |
| Post images | Exactly three unique post OG URLs discovered from rendered metadata; all returned 200 `image/png`, valid PNG signatures, and 1200×630 IHDR dimensions. One draft and one unknown post image route each returned 404. |

URL origin substitution changed only the origin from `https://dawnai.org` to
the task-specific localhost origin; paths and queries were preserved. Fetch,
parse, count, type, description, canonical, robots, and image errors all produce
a deterministic failure summary and a nonzero exit.

### Full repository validation

The first Task 9 validation attempt is retained because it found a real
branch-owned gate failure distinct from the original CLI port race. Source
tests passed 4,741 with 215 skipped, but release-controller finished 556 of 557
tests and rejected the CI workflow as not explicitly audited. Root cause was
commit `5fac332d`: it added `fetch-depth: 0` to the validation checkout without
updating the workflow descriptor fixture. Task 9 stopped without changing the
release fixture. The owning change was fixed and reviewed separately in
`cd034845` (`test: audit full-history validation checkout`).

After that fix, the complete validation was rerun from the beginning:

```console
$ PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm ci:validate

Test Files  432 passed | 17 skipped (449)
Tests       4741 passed | 215 skipped (4956)

release-controller: 557 passed, 0 failed
release-publish: 8 passed, 0 failed
upload-release-assets: 5 passed, 0 failed
backfill-release-tags: 8 passed, 0 failed
sync-chart-appversion: 6 passed, 0 failed
Docs completeness check passed.
pack-check unit tests: 58 passed; Pack check passed.
TypeScript tooling pack unit tests: 27 passed; runtime and tsc probes passed.
harness-report self-test passed

run: harness-2026-08-26T223430-418Z-90955
status: passed
requested lanes: framework, runtime, smoke
executed lanes: framework, runtime, smoke
passed=3 failed=0 skipped=0 errored=0
[framework] Framework verification: passed (268824ms)
[runtime] Runtime contract (real dev parity): passed (181585ms)
[smoke] Runtime smoke: passed (76545ms)

# final exit 0
```

The original transient CLI port-race did not recur, so no targeted rerun was
performed in the final lane.

### Warnings, limitations, and unknowns

- The standalone and repository builds warned that Next's Edge Runtime is
  deprecated and that using it on a page disables static generation for that
  page. The builds nevertheless exited zero and generated the documented route
  set. No runtime migration is bundled here.
- Vitest warned that it could not statically analyze the existing dynamic blog
  MDX import because the static import portion has no extension.
- Root lint exited zero with nine `noUndeclaredEnvVars` warnings for existing
  release and changeset scripts. Cached Biome output also included a schema
  version information notice and the deprecated `recommended` field notice.
- Turbo uses a shared worktree cache. Some cache-hit logs replayed paths from
  other worktrees and Node 22 engine warnings even though the top-level command
  and fresh focused web gates ran under Node 24.19.0. These are replayed log
  provenance, not evidence that the recorded top-level validation used Node 22.
- Expected negative bundling fixtures printed unresolved-package diagnostics
  for `pg-native` and deliberately missing packages. Their owning tests passed.
- Runtime fixtures printed that no thread access policy was configured on
  disposable local test apps. That output is not a production access-policy
  assessment.
- No warning or timeout was silently classified as pre-existing. No
  loaded-parallel timeout occurred in the complete Task 9 `ci:validate` run.
  The later review-only full web lane timed out in one last-modified manifest
  test; its exact one-test rerun passed one and skipped five. The cause remains
  an unresolved load-sensitive recurrence, not a failure in an audit test.
- This verifies repository and local production-build mechanisms only. It is
  not a deployed Rich Results result, a live crawler result, an indexing
  request, or a production analytics event claim.

Analytics remains **Blocked**. There is no selected ingest provider or event
destination, so this branch makes no production analytics or measurement-event
claim and deliberately does not choose an adapter on the owner's behalf.

### Owner actions and post-deployment measurement

1. The owner must deploy the reviewed branch and identify the deployed commit.
2. After deployment, the owner must replace the obsolete Search Console
   `sitemap_index.xml` submission with `https://dawnai.org/sitemap.xml`. The
   agent did not submit a sitemap, request indexing, or complete any form.
3. If analytics is desired, the owner must select the ingest provider and
   destination before any production event claim can be verified.
4. Recheck direct production responses after deployment before making Rich
   Results, crawler, OG-rendering, or structured-data production claims.

The Search Console final-data baseline window remains 2026-05-26 through
2026-08-23. The earliest honest CTR read is roughly one week after deployment,
after the reporting window and lag can catch up. For crawl conclusions, wait
until the submitted sitemap's `lastDownloaded` is newer than the deployment;
an older timestamp cannot establish that Google fetched the remediated build.
