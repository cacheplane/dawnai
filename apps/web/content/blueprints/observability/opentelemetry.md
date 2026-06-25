---
description: Add OpenTelemetry tracing to a Dawn app.
website: https://opentelemetry.io
version: 1
tags: [observability, tracing, otel]
source: official
---

# Add OpenTelemetry to your Dawn app

You are an AI coding agent adding OpenTelemetry tracing to a Dawn app. It initializes the OTel Node SDK and exports spans to an OTLP endpoint so you can trace runs in your own observability backend. It does NOT replace LangSmith tracing (Dawn's deploy target has its own), stand up a collector, or auto-instrument your tools beyond what the Node SDK's auto-instrumentations provide.

## Prerequisites

Before proceeding, confirm the following is true:

**OTLP-compatible backend reachable from this environment** — you need a collector or observability backend that accepts OTLP/HTTP traces (e.g. an OTel Collector, Jaeger, Honeycomb, Grafana Tempo). You must know its OTLP endpoint URL.

> **Note:** OpenTelemetry instrumentation is most valuable for self-hosted Dawn runtimes where you control the server process. If you only deploy to LangSmith, LangSmith already provides first-class LangChain/LangGraph tracing — you may not need OTel. Confirm this is a self-hosted deployment before proceeding.

If no OTLP backend is available or configured, stop and tell the user what needs to be set up before continuing.

## Inspect the project

Run these checks before writing any code:

1. **Package manager** — detect from lockfile: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm.
2. **App directory** — read `dawn.config.ts` and find the `appDir` field (defaults to `src/app`). Note the overall project structure.
3. **AGENTS.md** — read it if present for project-specific conventions (naming, style, preferred imports).
4. **Existing install check** — look for `src/lib/otel.ts`. If the file exists and its first line is `// dawn-blueprint: opentelemetry@1`, skip to [Updating an existing install](#updating-an-existing-install).
5. **Server entry point** — identify where the self-hosted server bootstraps. Look for a `src/server.ts`, `src/index.ts`, or similar file that starts the HTTP server. This is where `startTelemetry()` must be called first. If no custom entry exists and the app only uses `dawn dev`, note that OTel must be loaded via Node's `--import` preload flag.
6. **Env conventions** — check for `.env` and `.env.example` to learn how the project names and documents secrets.

## Install dependencies

You need five packages:

- **`@opentelemetry/sdk-node`** — the Node.js SDK that wires up the tracer, exporter, and auto-instrumentations.
- **`@opentelemetry/auto-instrumentations-node`** — a meta-package that enables built-in auto-instrumentations (HTTP, gRPC, DNS, etc.) with a single call.
- **`@opentelemetry/exporter-trace-otlp-http`** — exports spans to an OTLP/HTTP endpoint.
- **`@opentelemetry/resources`** — provides `resourceFromAttributes` for describing this service (2.x API).
- **`@opentelemetry/semantic-conventions`** — provides the `ATTR_SERVICE_NAME` constant (and other semantic attribute keys).

Check `package.json` before installing to avoid duplicates. Install only what is missing.

```bash
# pnpm (detected from pnpm-lock.yaml)
pnpm add @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources \
  @opentelemetry/semantic-conventions

# npm equivalent
# npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
#   @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources \
#   @opentelemetry/semantic-conventions

# yarn equivalent
# yarn add @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
#   @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources \
#   @opentelemetry/semantic-conventions
```

Install the latest majors of each package — do not pin specific minor versions. As of the OTel JS 2.x release, `@opentelemetry/resources` 2.x removed the `Resource` class constructor; the code in this blueprint uses the `resourceFromAttributes` factory (2.x API). Run `npm info <pkg> version` (or the equivalent for your package manager) to confirm the latest before installing.

## Create the instrumentation module

Place the file at:

```
src/lib/otel.ts
```

Write the following file in full. Read the inline comments — adapt the service name default and any exporter options to match the project before saving.

```ts
// dawn-blueprint: opentelemetry@1
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"

// Read the OTLP endpoint from the environment. No default — if unset, the
// exporter will fall back to the OTel SDK default (http://localhost:4318/v1/traces).
// Always set OTEL_EXPORTER_OTLP_ENDPOINT in your environment.
const exporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  // Adapt: if your backend requires auth headers, pass them here or via
  // OTEL_EXPORTER_OTLP_HEADERS (see Configure environment below).
})

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    // Adapt: replace "dawn-app" with your service name, or rely on the
    // OTEL_SERVICE_NAME environment variable (takes precedence at SDK init time).
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "dawn-app",
  }),
  traceExporter: exporter,
  // getNodeAutoInstrumentations() enables HTTP, gRPC, DNS, and other built-in
  // instrumentations. Pass options to disable individual instrumentations:
  // getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } })
  instrumentations: [getNodeAutoInstrumentations()],
})

let started = false

/**
 * Initialize the OpenTelemetry Node SDK and register a SIGTERM shutdown hook.
 * Call this function at the very top of your app's entry point — before any
 * other imports run — so auto-instrumentations patch modules at load time.
 *
 * Safe to call multiple times: only the first call starts the SDK.
 */
export function startTelemetry(): void {
  if (started) return
  started = true

  sdk.start()

  // Flush and shut down the SDK cleanly when the process exits.
  // The Node SDK's shutdown() is async; give it 5 s before forcing exit.
  process.on("SIGTERM", () => {
    sdk
      .shutdown()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error("OTel SDK shutdown error:", err)
        process.exit(1)
      })
  })
}
```

> **Before saving:**
> - `OTEL_SERVICE_NAME` default (`"dawn-app"`) — replace with a meaningful name for this app
> - Exporter URL — will come from `OTEL_EXPORTER_OTLP_ENDPOINT` in the environment (see Configure environment)
> - Auth headers (if required by your backend) — set via `OTEL_EXPORTER_OTLP_HEADERS` or in the `OTLPTraceExporter` constructor

## Wire it into your app

OTel must initialize **before** any other module loads. Auto-instrumentations work by patching modules at require/import time; if the SDK starts after `http` or `fetch` have already been imported, those patches are missed and spans will not be generated.

### Option A — Custom server entry (recommended)

If the project has a custom server entry (e.g. `src/server.ts` or `src/index.ts`), import `startTelemetry` from `./lib/otel` and call it as the **very first statement**. This works with the project's existing TypeScript toolchain and requires no extra loader.

```ts
// src/server.ts  (or src/index.ts — wherever the server bootstraps)
import { startTelemetry } from "./lib/otel"
startTelemetry()

// All other imports come after — OTel is now active before they load.
import { createServer } from "http"
// ... rest of server bootstrap
```

In ESM projects, `import` statements are hoisted by the runtime regardless of source order. Use a dynamic `await import()` to guarantee ordering:

```ts
// src/server.ts — ESM-safe ordering via dynamic import
const { startTelemetry } = await import("./lib/otel")
startTelemetry()

const { createServer } = await import("http")
// ... rest of server bootstrap
```

### Option B — Node preload flag (works without a custom entry)

If there is no custom entry, or to guarantee OTel loads first regardless of ESM hoisting, preload the module via Node's `--import` flag.

**Important:** Node cannot preload a bare `.ts` file without a TypeScript loader. You have two sub-options:

- **(B1) Compiled JS** — build the project first, then point `--import` at the compiled output file (e.g. `dist/lib/otel.js`):

  ```json
  {
    "scripts": {
      "start": "node --import ./dist/lib/otel.js dist/server.js"
    }
  }
  ```

- **(B2) tsx loader** — if your project uses `tsx` as a TypeScript runner, chain it with `--import`:

  ```bash
  node --import tsx --import ./src/lib/otel.ts dist/server.js
  # or via NODE_OPTIONS:
  NODE_OPTIONS="--import tsx --import ./src/lib/otel.ts" node dist/server.js
  ```

  Do not use `--import ./src/lib/otel.js` while pointing at a `.ts` source file — Node will not resolve it without a loader and the preload will silently fail or error.

> **`dawn dev` note:** `dawn dev` runs a child route runtime inside a managed process. To instrument that child process with OTel, set `NODE_OPTIONS` in your `.env` before starting `dawn dev`. The child runtime inherits `NODE_OPTIONS` from its environment. Use one of the B1/B2 forms above (e.g. `NODE_OPTIONS="--import tsx --import ./src/lib/otel.ts"`) or prefer Option A if a custom entry exists.

## Configure environment

Add the following variables to `.env` (never commit this file):

```
# OTLP collector/backend endpoint — required
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces

# Human-readable service name shown in traces
OTEL_SERVICE_NAME=dawn-app

# Auth headers for backends that require them (e.g. Honeycomb, Grafana Cloud)
# Format: comma-separated key=value pairs
# OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=your-api-key,x-honeycomb-dataset=your-dataset
```

Document them in `.env.example` so other contributors know what to set:

```
OTEL_EXPORTER_OTLP_ENDPOINT=
OTEL_SERVICE_NAME=
# OTEL_EXPORTER_OTLP_HEADERS=
```

If the project uses a different env-loading convention (e.g. a vault, a platform-injected secret, or an `env.ts` file), follow that convention instead of `.env`.

> **LangSmith tracing is separate.** `dawn dev` automatically enables LangSmith tracing when `LANGSMITH_API_KEY` is present (setting `LANGCHAIN_TRACING_V2=true`). OpenTelemetry tracing is independent — both can be active at the same time. They export to different backends via different mechanisms.

## Verify

1. **Start the server with env set** — ensure `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` are in the environment, then start the app:

   ```bash
   dawn dev
   # or, for a self-hosted server with compiled output:
   node --import ./dist/lib/otel.js dist/server.js
   ```

   The OTel SDK logs nothing on successful start by default. If you see an error like `Error: connect ECONNREFUSED`, the collector endpoint is not reachable — check that the backend is running and the URL is correct.

2. **Exercise a route** — send a request to trigger a run:

   ```bash
   echo '{"messages":[{"role":"user","content":"Hello"}]}' \
     | dawn run '/your-route' --url http://127.0.0.1:3001
   ```

3. **Confirm spans in your backend** — open your observability backend UI and look for traces with the service name matching `OTEL_SERVICE_NAME`. You should see at least one HTTP span for the inbound request.

4. **Collector reachability check** — if no spans arrive, run:

   ```bash
   curl -v $OTEL_EXPORTER_OTLP_ENDPOINT
   ```

   A connection error means the backend is not reachable from this host. A 4xx response usually means a missing or incorrect auth header (`OTEL_EXPORTER_OTLP_HEADERS`).

## Updating an existing install

If `src/lib/otel.ts` already exists with the `// dawn-blueprint: opentelemetry@1` marker on its first line:

1. Compare the existing file against the module template in [Create the instrumentation module](#create-the-instrumentation-module).
2. Apply relevant changes from this guide (e.g. updated `ATTR_SERVICE_NAME` import from `@opentelemetry/semantic-conventions`, the double-start guard, the `SIGTERM` hook) while **preserving the user's customisations** — service name default, exporter URL overrides, extra instrumentations, or any additional `ResourceAttributes`.
3. Do not change the marker line; it must remain `// dawn-blueprint: opentelemetry@1` as the first line of the file.
4. Confirm that `startTelemetry()` is still called at the top of the server entry (or via `NODE_OPTIONS`) after updating.
