# Dawn Application-Developer Journey Design

**Status:** Proposed
**Primary audience:** Application developers building, integrating, testing,
operating, and deploying Dawn apps

## Goal

Rebuild the Dawn documentation around the work an application developer is
trying to complete. The result should make the shortest path obvious, give
production decisions a clear home, and replace the largest mixed-purpose pages
with focused guides that are easier to scan and maintain.

The preceding website accuracy sweep corrected the current claims and examples.
This pull request changes how that accurate material is organized and fills the
highest-value gaps it exposed. It is an information-architecture and content
clarity change, not a runtime feature change.

## Desired reader outcome

An application developer should be able to answer these questions without
already knowing Dawn's package layout or internal terminology:

1. How do I create and run my first Dawn app?
2. How do routes, agents, tools, state, memory, and workspace capabilities fit
   together?
3. How do I integrate Dawn with my application or embed its runtime?
4. How do I test behavior before using a live model or deploying?
5. What data does Dawn persist, who owns tenant isolation, and which security
   boundaries does Dawn actually enforce?
6. Which deployment target fits my app, and what changes when I add replicas?
7. Where is the exact configuration, command, or TypeScript API contract?

The navigation and page openings will use those reader jobs. Package names and
implementation details remain available in reference pages, but they will not
be the organizing principle for the learning path.

## Design decisions

### 1. Use a journey-first, additive reorganization

The redesign will preserve every existing documentation URL while regrouping
pages into these top-level sections:

1. Get Started
2. Build
3. Integrate
4. Test
5. Operate
6. Deploy
7. Recipes
8. Reference

This is preferable to either a cosmetic reorder of the current Concepts and
Tooling buckets or a wholesale URL migration. A cosmetic reorder would leave
the missing production guidance and oversized pages unresolved. A URL rewrite
would add redirect and search-index risk without helping the reader complete a
task.

Existing pages stay at their current paths. New detail pages may use nested
paths such as `/docs/deployment/kubernetes` and `/docs/api/sdk`. The top-level
overview at the existing path remains the stable entrypoint.

There will not be a separate `/docs` hub that adds another choice before the
quickstart. A bare `/docs` request will redirect to `/docs/getting-started`, while
the header, footer, breadcrumbs, and landing-page calls to action continue to
use that shortest path directly.

### 2. Keep the navigation data flat

`DOCS_NAV` will retain its current section-and-item shape. Nested URLs do not
require a nested navigation model. This keeps the desktop sidebar, mobile menu,
breadcrumbs, previous/next links, search index, sitemap, generated LLM content,
and CLI documentation bundle on one shared ordered list.

The source literals will retain `label` before `href` on the same line because
the CLI documentation bundler currently parses that shape. Tests will make this
constraint, unique labels and paths, section order, and authored-page coverage
explicit. A future navigation component may introduce collapsible child groups,
but this redesign will not couple the content migration to that UI change.

### 3. Give each page one job

Pages will use one of four shapes:

- **Quickstart:** one shortest successful path, followed by explicit next
  choices.
- **Overview or chooser:** a verdict first, a small decision matrix, the
  minimal common setup, and links to focused guides.
- **Focused guide:** one application task or operational concern, including its
  constraints and a copyable path.
- **Reference:** exhaustive signatures, fields, or commands with short examples
  and links back to conceptual guidance.

Overview pages will stop repeating the implementation detail owned by their
focused guides. Focused guides will not restate full configuration or API
tables. Reference pages will define exact contracts without trying to be a
second tutorial.

There is no hard word-count target: a complete reference may be long. The
editing test is whether every section contributes to the page's single job.

## Navigation and page map

The final order below is also the intended previous/next reading order.
Existing paths are retained unless marked **new**.

### Get Started

- **Getting Started** — `/docs/getting-started`: install, scaffold, offline
  verification, first live run, and the next three choices.
- **Mental Model** — `/docs/mental-model`: the route-to-runtime model and the
  distinction between agent, workflow, graph, and chain routes.
- **Migrating from LangGraph** — `/docs/migrating-from-langgraph`: what can be
  reused, what Dawn owns, and target-specific differences.

### Build

- **Routes** — `/docs/routes`
- **Agents** — `/docs/agents`
- **Tools** — `/docs/tools`
- **State** — `/docs/state`
- **Workspace Filesystem** — `/docs/workspace`
- **Memory** — `/docs/memory`: a short chooser for workspace memory, runtime
  state, and typed long-term memory.
- **Long-term Memory** — `/docs/memory/long-term` **new**: define, write,
  inspect, delete, and choose a store.
- **Recall and Retrieval** — `/docs/memory/retrieval` **new**: deterministic
  browse/filter behavior, semantic recall, ranking, and backend differences.
- **Episodes** — `/docs/memory/episodes` **new**: episodic extraction and review.
- **Distillation** — `/docs/memory/distillation` **new**: candidate generation,
  approval, and lifecycle.
- **Planning** — `/docs/planning`
- **Skills** — `/docs/skills`
- **Subagents** — `/docs/subagents`
- **Context Management** — `/docs/context-management`
- **Reasoning Effort** — `/docs/reasoning-effort`

### Integrate

- **Dev Server** — `/docs/dev-server`: start, invoke, reload, logging, and local
  development behavior.
- **Agent Protocol** — `/docs/dev-server/agent-protocol` **new**: the HTTP route
  table, request/stream/cancel semantics, heartbeat behavior, and curl examples.
- **Middleware** — `/docs/middleware`
- **AG-UI and Web Clients** — `/docs/ag-ui`
- **Embed the Runtime** — `/docs/embedding` **new**: standalone versus embedded
  operation, stable entrypoints, ownership, composition, and shutdown.
- **Blueprints** — `/docs/blueprints`

### Test

- **Scenario Testing** — `/docs/testing`: route scenarios, tool mocks, and the
  offline-first testing loop.
- **Agent Test Harness** — `/docs/testing-agents`: first harness test,
  assertions, and test boundaries.
- **Fixtures and Recording** — `/docs/testing-agents/fixtures` **new**: author,
  record, replay, and deliberately opt into live model calls.
- **Evals** — `/docs/evals`

### Operate

- **Production Topology** — `/docs/production-topology` **new**: single process,
  shared stores, replica routing, cancellation, health, and shutdown.
- **Persistence and Tenancy** — `/docs/persistence` **new**: stored data,
  ownership, deletion, backup, retention, and tenant boundaries.
- **Security Architecture** — `/docs/security-architecture` **new**: service
  authentication, middleware coverage, tool and sandbox boundaries, and a
  deployment-target threat matrix.
- **Access Control** — `/docs/access-control`: verified identity and
  application policy at the execution boundary.
- **Permissions** — `/docs/permissions`: human-in-the-loop tool and resource
  grants, matching, and persistence.
- **Retry** — `/docs/retry`
- **Observability** — `/docs/observability`
- **Inspector** — `/docs/inspector`
- **Upgrading** — `/docs/upgrading`

### Deploy

- **Deployment Options** — `/docs/deployment`: a target chooser and common
  build/verify flow.
- **Node and Docker** — `/docs/deployment/node` **new**: generated server and
  image, configuration, process behavior, and a production checklist.
- **Kubernetes** — `/docs/deployment/kubernetes` **new**: application chart,
  probes, service account prerequisites, storage, scaling caveats, and rollout.
- **LangSmith** — `/docs/deployment/langsmith` **new**: emitted graph entries,
  environment-file contract, supported capabilities, and known Node-version
  mismatch.
- **Edge and Hono** — `/docs/deployment/edge` **new**: per-request composition,
  feature gates, rooted app namespace, and the boundary between local workerd
  proof and a live platform deployment.
- **Execution Sandbox** — `/docs/sandbox`: policy, Docker quickstart, isolation,
  lifecycle, and portable provider behavior.
- **Kubernetes Sandbox** — `/docs/sandbox/kubernetes` **new**: orchestrator
  installation, RBAC, NetworkPolicy, quotas, cleanup, and provider configuration.

Application-chart installation belongs to **Kubernetes**. Sandbox workload
isolation belongs to **Kubernetes Sandbox**. The chart READMEs remain the
operator-level values reference; the website does not duplicate every Helm
value.

### Recipes

The current recipe paths remain. Navigation labels and page H1s will be made
consistent, especially the current retry and research-web-UI mismatches. The
recipe index will group tasks by build, integrate, test, and deploy without
turning each recipe into a second conceptual guide.

### Reference

- **Configuration Reference** — `/docs/configuration`
- **CLI Reference** — `/docs/cli`
- **API Reference** — `/docs/api`: app-facing package inventory, package
  chooser, and API conventions.
- **SDK API** — `/docs/api/sdk` **new**
- **Core API** — `/docs/api/core` **new**
- **CLI Runtime API** — `/docs/api/cli` **new**
- **LangGraph Adapter API** — `/docs/api/langgraph` **new**
- **LangChain Adapter API** — `/docs/api/langchain` **new**
- **AG-UI API** — `/docs/api/ag-ui` **new**
- **Permissions API** — `/docs/api/permissions` **new**
- **Workspace API** — `/docs/api/workspace` **new**
- **Sandbox API** — `/docs/api/sandbox` **new**
- **Memory API** — `/docs/api/memory` **new**
- **pgvector Memory API** — `/docs/api/memory-pgvector` **new**
- **SQLite Storage API** — `/docs/api/sqlite-storage` **new**
- **Postgres Storage API** — `/docs/api/postgres-storage` **new**
- **Testing API** — `/docs/api/testing` **new**
- **Evals API** — `/docs/api/evals` **new**
- **Vite Plugin API** — `/docs/api/vite-plugin` **new**
- **Generated Route Types** — `/docs/api/routes` **new**
- **Error Codes** — `/docs/errors`
- **FAQ** — `/docs/faq`

The API split follows app-facing import surfaces rather than concepts.
Conceptual behavior stays in Build, Integrate, Test, Operate, and Deploy; these
pages own signatures, return values, and minimal examples. The API overview
will also inventory published command, application, scaffold, and internal
toolchain packages that do not need an import-reference page and point readers
to CLI Reference, Inspector, Getting Started, or contributor documentation as
appropriate. That makes exclusions visible instead of silently implying that
the current partial package list is exhaustive.

## Missing-guide content contracts

The new guides must close gaps without promising behavior the runtime does not
provide.

### Deployment Options

The overview will lead with a target matrix:

- `node` provides Dawn's standalone HTTP runtime and configured sandbox support
  and uses the repository's Node 24+ baseline.
- `langsmith` emits route-specific graph entries; it does not include Dawn HTTP
  middleware, AG-UI endpoints, or sandbox orchestration. The generated target's
  current Node 22 setting remains an explicit compatibility limitation.
- `hono` is opt-in and web-standard, but its per-request runtime requires
  Postgres and gates filesystem-backed workspace, sandbox, skills, offloading,
  long-term memory, and custom live-store features.

Specifying build targets replaces the defaults rather than adding to them. The
page will give a recommendation first, then link to one focused target guide.

### Production Topology

This guide will start with the safe default: one Dawn process and local SQLite.
It will then explain that Postgres can share checkpoints, thread metadata, and
permission decisions, while long-term memory uses its own configured store.

The run gate and cancellation registry are process-local. Multiple replicas
therefore need shared durable stores plus thread-aware routing or distributed
serialization and cancellation routing; Dawn does not supply a distributed run
coordinator. Ordinary path-based load balancing is insufficient for every
AG-UI request because the thread identifier may be in the request body.

`/healthz` proves only that the process is serving, not that databases, models,
or sandboxes are ready. The generated Node server does not currently opt into
the signal handlers used by `dawn start`, so the guide must not claim graceful
container termination. Agent Protocol disconnects and AG-UI disconnects retain
their separately documented behavior.

### Persistence and Tenancy

This guide will inventory checkpoints, thread metadata, permissions, typed
long-term memory, workspace files, and sandbox volumes. For each it will show:

- default and production-capable backend;
- tenant and namespace keys;
- whether replicas can share it;
- what thread deletion removes and what it leaves behind;
- who owns retention, backup, encryption, and migration.

Thread deletion is not presented as an account-level erasure primitive. It can
remove thread metadata, best-effort checkpoints, and the thread sandbox, but it
does not automatically remove global permission decisions or long-term memory.
Route and thread identifiers are caller input, not proof of identity or tenant
ownership.

### Security Architecture

This guide will state the outer service boundary before the inner controls.
Dawn middleware covers execution paths—Agent Protocol wait, stream, and resume,
plus AG-UI—not every management endpoint. Thread create/read/delete/state and
cancel routes, memory-candidate review routes, and health checks require
reverse-proxy or platform authentication and network restriction when exposed.

Verified identity must be compared with caller-supplied route, thread, tenant,
and namespace values. Tool scope, human-in-the-loop permissions, sandboxing,
and subagent delegation are defense layers, not substitutes for service
authentication. The sandbox redirects the four workspace-backed tools; authored
tools continue to execute in the application process unless they implement
their own isolation. The guide will also call out target differences: generated
LangSmith entries skip Dawn middleware, Hono build artifacts do not carry
secrets, and current Postgres-backed records are not application-level
encrypted by Dawn.

### Embed the Runtime

The guide will distinguish running the generated standalone server from
mounting Dawn inside an existing server. It will recommend the stable root
`serveRuntime` export for standalone control and the public
`@dawn-ai/cli/fetch` handler for request composition. It will not present the
lower-level `/runtime` listener APIs as an application-developer contract.

The page will document static modules and configuration, supplied versus
request-scoped stores, cleanup after responses and active runs, and caller
ownership of partially allocated resources. A supplied database pool remains
application-owned and must outlive the Dawn runtime. Runtime endpoints remain
rooted at `/healthz`, `/threads`, `/agui`, and `/memory`; there is no base-path
option. Hono composition uses `app.route`, and edge examples use a rooted opaque
application namespace such as `"/my-app"`, not a relative filesystem path.

## Splitting existing long pages

### Deployment

`/docs/deployment` becomes the chooser and shared build/verify workflow. Node,
Kubernetes, LangSmith, and Edge/Hono details move to their target pages.
Production scaling and data ownership move to Production Topology and
Persistence and Tenancy.

### Dev Server

The endpoint catalogue and wire examples move to Agent Protocol. The overview
keeps local startup, route discovery, invoking a route, child-runtime restart,
logging, and concise links to AG-UI, middleware, and observability.

### Execution Sandbox

The overview keeps the sandbox contract, Docker quickstart, lifecycle, provider
interface, and portable policy. Kubernetes orchestrator, RBAC, network, quota,
and reaper material moves to Kubernetes Sandbox. Application Helm installation
moves to the Kubernetes deployment page.

### Memory

The overview becomes a chooser among runtime state, workspace prompt memory,
and typed long-term memory, with the shortest L1-to-L3 setup. Storage,
retrieval, episodes, and distillation move to their focused pages. The current
public memory browse/query contract must be included
when the focused reference and retrieval material is extracted.

### Agent testing

The first test, core assertions, and test boundary stay in Agent Test Harness.
Fixture authoring, recording, replay, and live-model opt-in move to Fixtures and
Recording.

### Configuration

The complete configuration schema remains one reference page. Operational
Postgres topology and lifecycle material moves to Persistence and Tenancy, with
a concise `#postgres-backend` summary retained. Memory, sandbox, permissions,
context, and deployment entries link to their canonical guides instead of
duplicating those guides.

### API

The monolith becomes an app-facing package index and shared conventions page.
Each existing top-level package section moves to its corresponding package
page. Missing app-facing packages receive focused pages based on their public
exports and package tests rather than inferred behavior. Generated
`dawn:routes` types move to Generated Route Types.

## Canonical ownership and cross-links

Each recurring topic has one canonical owner:

| Topic | Canonical page | Other pages do |
|---|---|---|
| Deployment target choice | Deployment Options | State target-specific limits and link back |
| Replica behavior and shutdown | Production Topology | Include only the local implication |
| Stored data and deletion | Persistence and Tenancy | Name the store and link to the lifecycle matrix |
| Service authentication boundary | Security Architecture | Show task-specific policy examples |
| Execution middleware | Middleware and Access Control | Link to the outer security boundary |
| Human approval decisions | Permissions | Mention the gate, not re-explain matching/persistence |
| Sandbox isolation | Execution Sandbox | Deployment pages cover installation only |
| Kubernetes sandbox operations | Kubernetes Sandbox | Chart README owns exhaustive values |
| Memory mechanism choice | Memory | Focused pages own detailed lifecycle and retrieval |
| Agent Protocol wire contract | Agent Protocol | Dev Server shows only a first invocation |
| Exact exported types/functions | Package API pages | Concept guides use the smallest relevant signature |

Every moved section will be edited at both ends: the old page gets a concise
summary and link, and the new canonical page gets the full explanation. Related
links will be checked for loops and renamed labels.

## URL, anchor, and generated-content compatibility

### Existing page paths

All existing paths remain valid. There are no page renames or path redirects in
this pull request. New nested paths receive explicit Next.js page wrappers,
metadata, and copy/edit source mappings just like current pages.

### Moved non-API headings

All repository inbound fragment links will be updated to the canonical page.
For externally useful headings moved out of Deployment, Dev Server, Sandbox,
Memory, Testing Agents, and Configuration, the original page will retain the
old heading as a short compatibility section linking to the new location. This
keeps the old fragment resolvable without preserving duplicate prose.

The required compatibility set includes the currently linked Deployment edge
headings, Dev Server `#ag-ui-endpoint`, Memory's Postgres/retrieval/episodes/
distillation/testing headings, Configuration's memory/sandbox/Postgres
headings, and Sandbox's quickstart, boundary, Kubernetes, network, Helm, and
service-account headings.

### API fragments

Keeping dozens of empty API headings would defeat the split. `/docs/api` will
therefore include a small legacy-fragment redirect map. On initial load and
hash changes it will replace old package and member fragments with their new
package-page destination. The API overview remains usable without JavaScript
through visible package links; JavaScript supplies backward compatibility for
historical deep links.

Tests will enumerate every heading removed from the old API page and require a
destination whose page and fragment exist. Existing inbound anchors such as
`#definememorydef`, `#modelproviderid`, and `#dawn-aipostgres-storage` are part
of that contract.

### Search, sitemap, LLM output, and CLI bundle

Every authored docs MDX page will appear exactly once in navigation. The
file-to-route checks will continue to understand that `/docs/recipes` maps to
`recipes/index.mdx`. That single list continues to drive search, sitemap
entries, previous/next links, `llms-full.txt`, and the CLI docs bundle. Nested
paths are supported by the current file mapping, but tests will cover them
explicitly.

The compact `llms.txt` remains a curated orientation rather than a dump of the
sidebar. It will link the new chooser and production guides. Generated content
must use the same titles and canonical ownership as the visible website.

## Editorial rules

1. Start with the application decision or action, not the package name.
2. Give a recommendation or verdict before a matrix of alternatives.
3. Put prerequisites immediately before the command that needs them.
4. Keep copy-and-run examples complete, including imports, required environment
   variables, target directories, and safe bind addresses.
5. State observable behavior and limitations; do not infer guarantees from an
   implementation detail.
6. Use one canonical explanation and concise cross-links instead of repeating
   long warnings.
7. Keep exact TypeScript signatures and exhaustive option lists in Reference.
8. Use the current gpt-5-family model convention in examples.
9. Match navigation label, page H1, metadata title, search title, and related
   link wording unless a short metadata suffix materially helps search.
10. Prefer a compact table only when it makes a real choice or contract easier
    to compare.

## Responsive and visual behavior

The longer journey labels and inline commands must remain usable on small
screens. The implementation will fix inline-code wrapping in the shared MDX
style at narrow widths instead of inserting content-specific line breaks.
Block code and wide tables keep intentional horizontal scrolling.

Visual review will cover at least 1440-by-1000 desktop and 390-by-844 mobile
layouts, including the sidebar or mobile menu, long navigation labels, code,
tables, inline commands, breadcrumbs, search results, and previous/next links.
The redesign should not create horizontal page overflow or clipped copy
controls.

## Testing and drift prevention

Implementation will begin with failing, file-specific checks for the new
structure and highest-risk claims. The completed change must verify:

- exact journey section order and page order;
- unique navigation labels and paths;
- two-way coverage between navigation, MDX content, and route wrappers;
- breadcrumbs and previous/next behavior for new nested paths;
- every internal page and fragment link;
- every removed API fragment's redirect destination;
- nested-page inclusion in search, sitemap, `llms-full.txt`, and the CLI docs
  bundle;
- current target, health, shutdown, persistence, authentication, sandbox, and
  embedding limitations described above;
- absence of duplicate canonical sections left behind by the splits;
- repository docs checks, web lint, web typecheck, web build, docs bundle tests,
  build-cache checks, and the full `pnpm ci:validate` lane under Node 24;
- the pull-request changeset check, with no changeset expected unless the work
  unexpectedly changes a publishable package.

Manual browser verification will exercise desktop and mobile navigation,
search, deep-link compatibility, copy Markdown, edit links, sitemap and LLM
outputs, and representative overview, focused-guide, recipe, and reference
pages.

## Implementation sequence

The later implementation plan will divide the pull request into reviewable
stages:

1. Add reusable structural coverage for the current tree and the shared
   responsive fix.
2. Add the missing production, persistence, security, embedding, and deployment
   target guides together with their route wrappers and navigation entries.
3. Split Dev Server, Sandbox, Memory, Agent Testing, and Configuration while
   preserving compatibility headings.
4. Split API reference pages and add the complete legacy-fragment redirect map.
5. Reconcile cross-links, generated discovery surfaces, and final editorial
   duplication.
6. Run independent content review, browser review, and the full validation
   suite.

Each stage must leave links and generated docs coherent; the implementation
will not land placeholder pages or navigation entries that point to unfinished
content.

## Out of scope

- Runtime, storage, deployment-target, sandbox, or authentication behavior
  changes. Product limitations found while writing are documented and tracked
  separately.
- Renaming or removing existing documentation URLs.
- A new hierarchical or collapsible navigation data model.
- A separate landing page for every journey section.
- A generated TypeScript API-doc system or a generated configuration-schema
  reference.
- Splitting every `dawn.config.ts` option into its own page.
- Rewriting historical blog posts or the marketing landing page beyond links
  needed to reach the new canonical docs.
- Duplicating exhaustive Helm values from chart READMEs.
- Broad visual redesign of the documentation shell.

## Definition of done

The redesign is complete when an application developer can follow the sidebar
from first app through production deployment, each production concern has one
discoverable canonical guide, the largest mixed-purpose pages have focused
successors, and all existing page URLs and important deep links continue to
work.

No guide may overstate Dawn's current production guarantees. Navigation,
search, sitemap, machine-readable docs, and the CLI bundle must agree on the
same page set. The website must pass the repository validation lanes and the
desktop/mobile visual review from a clean Node 24 worktree.
