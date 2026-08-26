import "server-only"

import { ALL_DOCS_PAGES, breadcrumbsFor, type DocsPageHref } from "../components/docs/nav"
import { STATIC_LASTMOD } from "./lastmod.generated"
import type { SeoPage, TechArticleSeoPage } from "./types"

export interface DocsSeoEntry {
  readonly path: DocsPageHref
  readonly title: string
  readonly description: string
  readonly sourcePath: string
}

export interface StaticDocsSeoPage extends TechArticleSeoPage {
  readonly sourcePath: string
}

export type DocsSeoRegistry = {
  readonly [Path in DocsPageHref]: StaticDocsSeoPage
}

export function requireValidLastModified(
  manifest: Readonly<Record<string, string>>,
  path: string,
): string {
  const value = manifest[path]
  const timestamp = value === undefined ? Number.NaN : Date.parse(value)

  if (
    value === undefined ||
    Number.isNaN(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new Error(`Missing or invalid last-modified date for ${path}`)
  }

  return value
}

export const DOCS_SEO_ENTRIES = [
  {
    path: "/docs/getting-started",
    title: "Getting Started",
    description:
      "Build a typed Dawn research agent with file-system routes, generated types, local tools, offline tests, and production build targets.",
    sourcePath: "apps/web/content/docs/getting-started.mdx",
  },
  {
    path: "/docs/mental-model",
    title: "Mental Model",
    description:
      "Understand Dawn's LangGraph meta-framework model: file-system routes, typed tools and state, runtime flow, persistence, and build boundaries.",
    sourcePath: "apps/web/content/docs/mental-model.mdx",
  },
  {
    path: "/docs/migrating-from-langgraph",
    title: "Migrating from LangGraph",
    description:
      "Migrate a LangGraph project incrementally by re-exporting compiled graphs as Dawn routes, preserving graph code, and validating runtime boundaries.",
    sourcePath: "apps/web/content/docs/migrating-from-langgraph.mdx",
  },
  {
    path: "/docs/routes",
    title: "Routes",
    description:
      "Define Dawn routes as file-system agent, workflow, graph, or chain entries; learn pathname rules, typed workflow tools, and local or protocol dispatch.",
    sourcePath: "apps/web/content/docs/routes.mdx",
  },
  {
    path: "/docs/agents",
    title: "Agents",
    description:
      "Build Dawn agent routes that choose tools at runtime, configure model providers and retries, and opt into memory, planning, skills, and subagents.",
    sourcePath: "apps/web/content/docs/agents.mdx",
  },
  {
    path: "/docs/tools",
    title: "Tools",
    description:
      "Author auto-discovered, type-inferred Dawn tools; share and scope them per route, add approvals or argument constraints, and use runtime context safely.",
    sourcePath: "apps/web/content/docs/tools.mdx",
  },
  {
    path: "/docs/state",
    title: "State",
    description:
      "Define JSON-serializable Dawn route state with a colocated schema, defaults, dynamic-segment inputs, custom reducers, and runtime boundary rules.",
    sourcePath: "apps/web/content/docs/state.mdx",
  },
  {
    path: "/docs/workspace",
    title: "Workspace Filesystem",
    description:
      "Use Dawn's workspace filesystem through built-in agent tools or ctx.fs, configure backends and middleware, and apply canonical-path permission gates.",
    sourcePath: "apps/web/content/docs/workspace.mdx",
  },
  {
    path: "/docs/memory",
    title: "Memory",
    description:
      "Choose among Dawn's workspace prompt, route prompt, and typed long-term memory mechanisms based on scope, ownership, governance, and retrieval.",
    sourcePath: "apps/web/content/docs/memory.mdx",
  },
  {
    path: "/docs/memory/long-term",
    title: "Long-term Memory",
    description:
      "Define typed route memory with schemas, namespace scopes, identity reconciliation, recall and remember tools, write governance, and stores.",
    sourcePath: "apps/web/content/docs/memory/long-term.mdx",
  },
  {
    path: "/docs/memory/retrieval",
    title: "Recall and Retrieval",
    description:
      "Search scoped active memory with keyword or hybrid vector ranking, time windows, fixed clocks, pgvector storage, and retrieval evaluation.",
    sourcePath: "apps/web/content/docs/memory/retrieval.mdx",
  },
  {
    path: "/docs/memory/episodes",
    title: "Episodes",
    description:
      "Record settled agent runs as episodic memory, configure retention, recall time windows, and distinguish runtime from agent-authored events.",
    sourcePath: "apps/web/content/docs/memory/episodes.mdx",
  },
  {
    path: "/docs/memory/distillation",
    title: "Distillation",
    description:
      "Maintain long-lived Dawn memory with explicit consolidation and reflection passes, provenance, retention, cost controls, and safe scheduling.",
    sourcePath: "apps/web/content/docs/memory/distillation.mdx",
  },
  {
    path: "/docs/planning",
    title: "Planning",
    description:
      "Add a visible, state-backed todo plan to a Dawn agent with plan.md, writeTodos updates, generated types, and plan_update stream events.",
    sourcePath: "apps/web/content/docs/planning.mdx",
  },
  {
    path: "/docs/skills",
    title: "Skills",
    description:
      "Create route-local Dawn skills with frontmatter descriptions so models can discover compact summaries and load full instructions on demand with readSkill.",
    sourcePath: "apps/web/content/docs/skills.mdx",
  },
  {
    path: "/docs/subagents",
    title: "Subagents",
    description:
      "Delegate bounded tasks to child Dawn agent routes with convention or keyed registration, tool scoping, per-edge policy, approvals, and streamed activity.",
    sourcePath: "apps/web/content/docs/subagents.mdx",
  },
  {
    path: "/docs/context-management",
    title: "Context Management",
    description:
      "Manage long agent histories with automatic tool-output offloading and optional conversation summarization, including limits and cleanup.",
    sourcePath: "apps/web/content/docs/context-management.mdx",
  },
  {
    path: "/docs/reasoning-effort",
    title: "Reasoning Effort",
    description:
      "Configure route-level reasoning effort for OpenAI-backed agent routes, supported values, pass-through behavior, exclusions, and subagent budgets.",
    sourcePath: "apps/web/content/docs/reasoning-effort.mdx",
  },
  {
    path: "/docs/dev-server",
    title: "Dev Server",
    description:
      "Run and operate Dawn's local dev server, including stable ports, route invocation, child-process restarts, logging, and protocol links.",
    sourcePath: "apps/web/content/docs/dev-server.mdx",
  },
  {
    path: "/docs/dev-server/agent-protocol",
    title: "Agent Protocol",
    description:
      "Use Dawn's Agent Protocol for durable threads, checkpointed runs, SSE streaming, interrupts, resume, cancellation, and memory review.",
    sourcePath: "apps/web/content/docs/dev-server/agent-protocol.mdx",
  },
  {
    path: "/docs/middleware",
    title: "Middleware",
    description:
      "Gate Dawn route execution with one global middleware, pass request context to tools, understand endpoint coverage, and handle load failures.",
    sourcePath: "apps/web/content/docs/middleware.mdx",
  },
  {
    path: "/docs/ag-ui",
    title: "AG-UI and Web Clients",
    description:
      "Connect web clients to Dawn over AG-UI SSE, including request translation, activity rendering, threading, permissions, and disconnect behavior.",
    sourcePath: "apps/web/content/docs/ag-ui.mdx",
  },
  {
    path: "/docs/embedding",
    title: "Embed the Runtime",
    description:
      "Embed Dawn with serveRuntime or a fetch handler while owning authentication, store lifetimes, rooted routes, streaming, and shutdown.",
    sourcePath: "apps/web/content/docs/embedding.mdx",
  },
  {
    path: "/docs/blueprints",
    title: "Blueprints",
    description:
      "Learn how to list, apply, self-host, and author Dawn blueprints as agent-facing Markdown guides for wiring external integrations.",
    sourcePath: "apps/web/content/docs/blueprints.mdx",
  },
  {
    path: "/docs/testing",
    title: "Scenario Testing",
    description:
      "Write colocated Dawn scenario suites with typed inputs, expectations, tool mocks, and in-process or server execution; test tools and filesystem middleware.",
    sourcePath: "apps/web/content/docs/testing.mdx",
  },
  {
    path: "/docs/testing-agents",
    title: "Agent Test Harness",
    description:
      "Test Dawn agents deterministically with replayed model fixtures while exercising tools, prompts, capabilities, and state across runtime boundaries.",
    sourcePath: "apps/web/content/docs/testing-agents.mdx",
  },
  {
    path: "/docs/testing-agents/fixtures",
    title: "Fixtures and Recording",
    description:
      "Author, record, commit, and replay deterministic Dawn model fixtures; understand matching, live-mode opt-in, CI drift checks, and harness cleanup.",
    sourcePath: "apps/web/content/docs/testing-agents/fixtures.mdx",
  },
  {
    path: "/docs/evals",
    title: "Evals",
    description:
      "Measure agent quality across datasets with Dawn evals, replayable fixtures, built-in or custom scorers, composable gates, and CI reports.",
    sourcePath: "apps/web/content/docs/evals.mdx",
  },
  {
    path: "/docs/persistence",
    title: "Persistence and Tenancy",
    description:
      "Plan Dawn persistence and tenant ownership across checkpoints, threads, permissions, long-term memory, workspaces, sandboxes, and replicas.",
    sourcePath: "apps/web/content/docs/persistence.mdx",
  },
  {
    path: "/docs/production-topology",
    title: "Production Topology",
    description:
      "Plan Dawn production topology from single-process storage through shared persistence, replica coordination, streaming, readiness, and shutdown.",
    sourcePath: "apps/web/content/docs/production-topology.mdx",
  },
  {
    path: "/docs/security-architecture",
    title: "Security Architecture",
    description:
      "Secure a Dawn runtime with outer authentication and tenant authorization, then layer thread access, tool scope, permissions, and sandbox controls.",
    sourcePath: "apps/web/content/docs/security-architecture.mdx",
  },
  {
    path: "/docs/access-control",
    title: "Access Control",
    description:
      "Learn how Dawn combines tool scoping, permission gates, execution sandboxes, and guarded subagent delegation for route access control.",
    sourcePath: "apps/web/content/docs/access-control.mdx",
  },
  {
    path: "/docs/thread-access",
    title: "Thread Access",
    description:
      "Authorize Dawn thread creation, reads, updates, deletion, runs, and resumes with a fail-closed policy, ownership stamps, and enumeration-safe denials.",
    sourcePath: "apps/web/content/docs/thread-access.mdx",
  },
  {
    path: "/docs/permissions",
    title: "Permissions",
    description:
      "Configure Dawn's human-in-the-loop gates for commands, paths, tools, subagents, and memory writes, including modes and resume decisions.",
    sourcePath: "apps/web/content/docs/permissions.mdx",
  },
  {
    path: "/docs/retry",
    title: "Retry",
    description:
      "Configure per-agent retries and exponential backoff for transient LLM failures, with non-retryable errors, streaming limits, and abort behavior.",
    sourcePath: "apps/web/content/docs/retry.mdx",
  },
  {
    path: "/docs/observability",
    title: "Observability",
    description:
      "Enable LangSmith tracing for Dawn runs, inspect nested model, tool, and subagent traces, and stream live runtime events over SSE.",
    sourcePath: "apps/web/content/docs/observability.mdx",
  },
  {
    path: "/docs/inspector",
    title: "Inspector",
    description:
      "Inspect Dawn memory in a local browser UI with ranked search, filters, live refresh, timelines, candidate approval, rejection, and deletion.",
    sourcePath: "apps/web/content/docs/inspector.mdx",
  },
  {
    path: "/docs/memory/browse",
    title: "Browse and Manage Memory",
    description:
      "Build a tenant-scoped memory admin surface with validated filters, safe sorting, stable cursor pagination, exact counts, and guarded mutations.",
    sourcePath: "apps/web/content/docs/memory/browse.mdx",
  },
  {
    path: "/docs/upgrading",
    title: "Upgrading",
    description:
      "Upgrade Dawn by pinning package versions, reading intervening release notes, updating Node and imports, regenerating types, and verifying behavior.",
    sourcePath: "apps/web/content/docs/upgrading.mdx",
  },
  {
    path: "/docs/deployment",
    title: "Deployment Options",
    description:
      "Compare Dawn's Node, LangSmith, and Hono deployment targets, their artifacts and capability boundaries, and the required validation workflow.",
    sourcePath: "apps/web/content/docs/deployment.mdx",
  },
  {
    path: "/docs/deployment/node",
    title: "Node and Docker",
    description:
      "Deploy Dawn's complete HTTP runtime with Node 24 or Docker, runtime secrets, durable stores, health checks, and coordinated shutdown.",
    sourcePath: "apps/web/content/docs/deployment/node.mdx",
  },
  {
    path: "/docs/deployment/kubernetes",
    title: "Kubernetes",
    description:
      "Deploy a Dawn Node image with Helm, configure probes, secrets, ServiceAccounts, persistence, rollouts, and replica coordination.",
    sourcePath: "apps/web/content/docs/deployment/kubernetes.mdx",
  },
  {
    path: "/docs/deployment/langsmith",
    title: "LangSmith",
    description:
      "Build Dawn graph entries for LangSmith, choose assistant IDs, review missing HTTP surfaces, and resolve the Node version mismatch.",
    sourcePath: "apps/web/content/docs/deployment/langsmith.mdx",
  },
  {
    path: "/docs/deployment/edge",
    title: "Edge and Hono",
    description:
      "Learn when Dawn's Hono edge target fits, what it emits, which capabilities it rejects, and how to validate request-scoped deployment.",
    sourcePath: "apps/web/content/docs/deployment/edge.mdx",
  },
  {
    path: "/docs/sandbox",
    title: "Execution Sandbox",
    description:
      "Configure per-thread execution sandboxes for workspace files, shell, network, environment, resources, lifecycle, providers, and testing.",
    sourcePath: "apps/web/content/docs/sandbox.mdx",
  },
  {
    path: "/docs/sandbox/kubernetes",
    title: "Kubernetes Sandbox",
    description:
      "Configure Pod-backed per-thread Dawn sandboxes with Helm infrastructure, RBAC, persistent workspaces, network policy, resource controls, and reaping.",
    sourcePath: "apps/web/content/docs/sandbox/kubernetes.mdx",
  },
  {
    path: "/docs/recipes",
    title: "Recipes Overview",
    description:
      "Find task-focused Dawn recipes for adding tools and typed state, authentication, streaming, retries, route dispatch, web UI, testing, and deployment.",
    sourcePath: "apps/web/content/docs/recipes/index.mdx",
  },
  {
    path: "/docs/recipes/add-a-tool",
    title: "Add a Tool",
    description:
      "Add a typed Dawn tool by placing a file in a route or shared tools directory, regenerating route types, and calling it from a workflow.",
    sourcePath: "apps/web/content/docs/recipes/add-a-tool.mdx",
  },
  {
    path: "/docs/recipes/typed-state",
    title: "Typed State",
    description:
      "Define JSON-serializable route state with Zod, validate workflow input, apply defaults, and pass dynamic-segment values through the run input.",
    sourcePath: "apps/web/content/docs/recipes/typed-state.mdx",
  },
  {
    path: "/docs/recipes/auth-middleware",
    title: "Auth Middleware",
    description:
      "Add Dawn execution authentication with middleware that rejects requests and passes verified identity to tools; protect bypassed endpoints separately.",
    sourcePath: "apps/web/content/docs/recipes/auth-middleware.mdx",
  },
  {
    path: "/docs/recipes/stream-output",
    title: "Stream Output",
    description:
      "Call Dawn's Agent Protocol streaming endpoint, parse SSE frames and heartbeats, and handle text, tool, plan, interrupt, subagent, and done events.",
    sourcePath: "apps/web/content/docs/recipes/stream-output.mdx",
  },
  {
    path: "/docs/recipes/retry-flaky-tools",
    title: "Retry Transient Model Calls",
    description:
      "Configure per-route retries for transient model or provider failures, understand backoff and streaming limits, and keep tool retry in application code.",
    sourcePath: "apps/web/content/docs/recipes/retry-flaky-tools.mdx",
  },
  {
    path: "/docs/recipes/dispatch-from-route",
    title: "Dispatch from a Route",
    description:
      "Dispatch work to a Dawn subagent with the generated task tool, or call a separate Agent Protocol service over HTTP when crossing deployments.",
    sourcePath: "apps/web/content/docs/recipes/dispatch-from-route.mdx",
  },
  {
    path: "/docs/recipes/research-web-ui",
    title: "Research Assistant Web UI",
    description:
      "Connect the research demo to CopilotKit over AG-UI with thread hydration, inline activity cards, permission prompts, and memory-candidate review.",
    sourcePath: "apps/web/content/docs/recipes/research-web-ui.mdx",
  },
  {
    path: "/docs/configuration",
    title: "Configuration Reference",
    description:
      "Configure Dawn app discovery, backends, permissions, stores, environment loading, context management, build targets, sandboxes, and memory.",
    sourcePath: "apps/web/content/docs/configuration.mdx",
  },
  {
    path: "/docs/cli",
    title: "CLI Reference",
    description:
      "Use Dawn's CLI to add integrations, validate, verify, build, serve, test, evaluate, inspect, and manage routes, types, and memory.",
    sourcePath: "apps/web/content/docs/cli.mdx",
  },
  {
    path: "/docs/api",
    title: "API Reference",
    description:
      "Choose the Dawn package, subpath, executable, or generated surface for exact exports, defaults, errors, compatibility, and lifecycle rules.",
    sourcePath: "apps/web/content/docs/api.mdx",
  },
  {
    path: "/docs/api/sdk",
    title: "@dawn-ai/sdk",
    description:
      "Reference @dawn-ai/sdk route-authoring APIs for agents, middleware, memory, thread access, model validation, tools, and scenario testing.",
    sourcePath: "apps/web/content/docs/api/sdk.mdx",
  },
  {
    path: "/docs/api/cli",
    title: "@dawn-ai/cli",
    description:
      "Reference @dawn-ai/cli commands and exports for embedding the Node runtime, composing edge fetch handlers, and accessing low-level runtime tools.",
    sourcePath: "apps/web/content/docs/api/cli.mdx",
  },
  {
    path: "/docs/api/core",
    title: "@dawn-ai/core",
    description:
      "Reference @dawn-ai/core exports for capabilities, configuration loading, route discovery, state resolution, and generated Dawn types.",
    sourcePath: "apps/web/content/docs/api/core.mdx",
  },
  {
    path: "/docs/api/ag-ui",
    title: "@dawn-ai/ag-ui",
    description:
      "Reference @dawn-ai/ag-ui exports for translating run input and stream events, encoding SSE, and rendering plan and subagent activities.",
    sourcePath: "apps/web/content/docs/api/ag-ui.mdx",
  },
  {
    path: "/docs/api/memory",
    title: "@dawn-ai/memory",
    description:
      "Reference @dawn-ai/memory stores and utilities for browsing, namespacing, ranking, reconciliation, SQLite persistence, and vector recall.",
    sourcePath: "apps/web/content/docs/api/memory.mdx",
  },
  {
    path: "/docs/api/memory-pgvector",
    title: "@dawn-ai/memory-pgvector",
    description:
      "Configure @dawn-ai/memory-pgvector for shared Postgres memory, including dimensions, schema initialization, pool ownership, and hybrid retrieval.",
    sourcePath: "apps/web/content/docs/api/memory-pgvector.mdx",
  },
  {
    path: "/docs/api/postgres-storage",
    title: "@dawn-ai/postgres-storage",
    description:
      "Reference shared Postgres checkpoints, threads, and permission stores, including edge and Node entry points, migrations, and pool ownership.",
    sourcePath: "apps/web/content/docs/api/postgres-storage.mdx",
  },
  {
    path: "/docs/api/testing",
    title: "@dawn-ai/testing",
    description:
      "Reference @dawn-ai/testing harnesses, fixtures, matchers, recorders, and conformance suites for programmatic Dawn tests.",
    sourcePath: "apps/web/content/docs/api/testing.mdx",
  },
  {
    path: "/docs/api/evals",
    title: "@dawn-ai/evals",
    description:
      "Reference @dawn-ai/evals for defining datasets and scorers, running repeatable evaluations, aggregating scores, and enforcing report gates.",
    sourcePath: "apps/web/content/docs/api/evals.mdx",
  },
  {
    path: "/docs/api/generated-routes",
    title: "dawn:routes",
    description:
      "Use generated dawn:routes types for route paths, dynamic parameters, tools, and state, including conditional exports and regeneration rules.",
    sourcePath: "apps/web/content/docs/api/generated-routes.mdx",
  },
  {
    path: "/docs/api/permissions",
    title: "@dawn-ai/permissions",
    description:
      "Reference @dawn-ai/permissions matching rules, request types, modes, pattern boundaries, and local persistent approval-store lifecycle.",
    sourcePath: "apps/web/content/docs/api/permissions.mdx",
  },
  {
    path: "/docs/api/workspace",
    title: "@dawn-ai/workspace",
    description:
      "Reference portable workspace filesystem, command, sandbox, middleware, and logging contracts plus Node backends and their trust boundaries.",
    sourcePath: "apps/web/content/docs/api/workspace.mdx",
  },
  {
    path: "/docs/api/sandbox",
    title: "@dawn-ai/sandbox",
    description:
      "Reference Docker and Kubernetes sandbox providers, lifecycle and network caveats, error behavior, and the provider conformance suite.",
    sourcePath: "apps/web/content/docs/api/sandbox.mdx",
  },
  {
    path: "/docs/api/langgraph",
    title: "@dawn-ai/langgraph",
    description:
      "Reference @dawn-ai/langgraph contracts for validating, normalizing, and executing graph or workflow route modules through Dawn adapters.",
    sourcePath: "apps/web/content/docs/api/langgraph.mdx",
  },
  {
    path: "/docs/api/langchain",
    title: "@dawn-ai/langchain",
    description:
      "Reference @dawn-ai/langchain adapters for agent materialization, provider loading, retries, tool loops, offloading, summarization, and subagents.",
    sourcePath: "apps/web/content/docs/api/langchain.mdx",
  },
  {
    path: "/docs/api/sqlite-storage",
    title: "@dawn-ai/sqlite-storage",
    description:
      "Reference local SQLite checkpoint and thread persistence, including store contracts, ordering, database modes, and lifecycle caveats.",
    sourcePath: "apps/web/content/docs/api/sqlite-storage.mdx",
  },
  {
    path: "/docs/errors",
    title: "Error Codes",
    description:
      "Look up Dawn error codes by category for configuration, sandbox, permissions, model providers, runtime stores, and imports.",
    sourcePath: "apps/web/content/docs/errors.mdx",
  },
  {
    path: "/docs/faq",
    title: "FAQ",
    description:
      "Get direct answers about Dawn's LangGraph foundation, TypeScript scope, model providers, build targets, production status, and migration.",
    sourcePath: "apps/web/content/docs/faq.mdx",
  },
] as const satisfies readonly DocsSeoEntry[]

function toStaticDocsSeoPage(entry: DocsSeoEntry): StaticDocsSeoPage {
  return {
    ...entry,
    canonical: `https://dawnai.org${entry.path}`,
    kind: "TechArticle",
    breadcrumbs: breadcrumbsFor(entry.path),
    lastModified: requireValidLastModified(STATIC_LASTMOD, entry.path),
  }
}

export function buildDocsSeoRegistry(entries: readonly DocsSeoEntry[]): DocsSeoRegistry {
  const expectedHrefs = new Set<DocsPageHref>(ALL_DOCS_PAGES.map(({ href }) => href))
  const pages: Partial<Record<DocsPageHref, StaticDocsSeoPage>> = {}

  for (const entry of entries) {
    if (Object.hasOwn(pages, entry.path)) {
      throw new Error(`Duplicate docs SEO entry: ${entry.path}`)
    }
    if (!expectedHrefs.has(entry.path)) {
      throw new Error(`Extra docs SEO entry: ${entry.path}`)
    }
    pages[entry.path] = toStaticDocsSeoPage(entry)
  }

  for (const href of expectedHrefs) {
    if (!Object.hasOwn(pages, href)) {
      throw new Error(`Missing docs SEO entry: ${href}`)
    }
  }

  return pages as DocsSeoRegistry
}

export const DOCS_SEO_PAGES: DocsSeoRegistry = buildDocsSeoRegistry(DOCS_SEO_ENTRIES)
export const STATIC_SEO_PAGES: Readonly<Record<string, SeoPage>> = {
  ...DOCS_SEO_PAGES,
}
