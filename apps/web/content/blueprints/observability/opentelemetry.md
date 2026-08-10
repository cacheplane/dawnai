---
description: Add OpenTelemetry tracing to a Dawn app.
website: https://opentelemetry.io
version: 2
tags: [observability, tracing, otel]
source: official
---

# Add OpenTelemetry to your Dawn app

You are an AI coding agent adding OpenTelemetry tracing to a Dawn app running in a Node process you control. This blueprint creates a self-starting ECMAScript preload that initializes the OTel Node SDK before Dawn loads, then exports spans to an OTLP endpoint. It does not replace tracing supplied by a hosting platform, stand up a collector, or instrument tools beyond the Node auto-instrumentations you enable.

## Prerequisites

Confirm all of the following before changing the app:

1. **Node.js 24 or newer** — this matches Dawn's runtime requirement and supports the `--import` preload used below.
2. **An OTLP/HTTP trace endpoint** — an OpenTelemetry Collector or compatible backend such as Jaeger, Honeycomb, or Grafana Tempo must be reachable from the runtime.
3. **A controllable Node startup path** — use this blueprint with `dawn start` or the generated Node target's `.dawn/build/server.mjs`. For the `hono` edge target, use instrumentation supported by that platform. For generated `langsmith` entries, evaluate platform tracing first.

If no OTLP backend or controllable Node process is available, stop and explain what must be supplied.

## Inspect the project

Before writing files:

1. Read `AGENTS.md` when present and inspect `package.json`, `dawn.config.ts`, `.dockerignore`, and the selected deployment path.
2. Check for a root `instrumentation.mjs` whose first line is `// dawn-blueprint: opentelemetry@2`. If present, follow [Updating an existing install](#updating-an-existing-install).
3. Check for the legacy `src/lib/otel.ts` marker `// dawn-blueprint: opentelemetry@1`. That module exported `startTelemetry()` but did not call it when preloaded; migrate it using the legacy steps below.
4. Confirm how runtime environment variables are injected. `dawn start` does not load the file named by `dawn.config.ts`'s `env` setting, so a process manager, shell, container, or platform must provide the OTel variables.

## Install runtime dependencies

The preload runs in production, so install these as regular `dependencies`, not `devDependencies`:

- `@opentelemetry/sdk-node`
- `@opentelemetry/auto-instrumentations-node`
- `@opentelemetry/instrumentation`
- `@opentelemetry/exporter-trace-otlp-http`
- `@opentelemetry/resources`
- `@opentelemetry/semantic-conventions`

Check `package.json` first and install only what is missing:

```bash
pnpm add @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
  @opentelemetry/instrumentation \
  @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources \
  @opentelemetry/semantic-conventions

# npm equivalent:
# npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
#   @opentelemetry/instrumentation \
#   @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources \
#   @opentelemetry/semantic-conventions

# yarn equivalent:
# yarn add @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
#   @opentelemetry/instrumentation \
#   @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources \
#   @opentelemetry/semantic-conventions
```

Use compatible current majors. The template uses the OpenTelemetry resources 2.x `resourceFromAttributes` API rather than the removed `new Resource(...)` constructor.

## Create the self-starting preload

Create this JavaScript module at the app root:

```text
instrumentation.mjs
```

Use `.mjs`, not a TypeScript source file. Current Dawn scaffolds set `noEmit: true`, so there is no compiled `dist/lib/otel.js` to preload. Node evaluates this module before the application entry and the top-level `sdk.start()` performs the initialization; merely exporting a start function is not enough.

```js
// dawn-blueprint: opentelemetry@2
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
if (!endpoint) {
  throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT is required")
}

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "dawn-app",
  }),
  traceExporter: new OTLPTraceExporter({ url: endpoint }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Adapt this map when an instrumentation is too noisy.
      // "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ],
})

// This file is a preload: initialize at module evaluation time, before Dawn's
// CLI or generated server imports the runtime and HTTP modules.
sdk.start()

// Best-effort flush on a natural event-loop exit. Do not install a signal or
// process.exit handler here that could compete with the host's lifecycle.
process.once("beforeExit", () => {
  void sdk.shutdown().catch((error) => {
    console.error("OpenTelemetry shutdown failed:", error)
  })
})
```

Before saving, choose an appropriate fallback service name. Authentication headers can be supplied through `OTEL_EXPORTER_OTLP_HEADERS`; do not hard-code them in this file.

The `beforeExit` hook is natural-exit cleanup only. It does not guarantee a flush for `SIGTERM`, `SIGINT`, `process.exit()`, or forced container termination. This template deliberately avoids claiming ownership of process signals; if termination-time delivery is required, coordinate shutdown with the process supervisor and the exact server lifecycle rather than adding an independent exit handler here.

## Validate the preload

Check JavaScript syntax without starting the application:

```bash
node --check instrumentation.mjs
```

Once the required environment is set and the dependencies are installed, verify that Node can resolve and execute the preload itself. Dawn's entry is ESM, so include OpenTelemetry's supported ESM instrumentation hook as well as the preload:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318/v1/traces \
OTEL_SERVICE_NAME=dawn-app \
NODE_OPTIONS="--experimental-loader=@opentelemetry/instrumentation/hook.mjs --import=./instrumentation.mjs" \
node -e 'console.log("OpenTelemetry preload initialized")'
```

An import, loader, or configuration error must fail here before Dawn starts. A successful message proves the self-starting module evaluated; end-to-end span delivery is verified below. Node currently labels the loader flag experimental because OpenTelemetry's ESM hook still uses that API.

## Start Dawn with the preload

`NODE_OPTIONS` lets the same file run before either supported Node entry without editing Dawn-generated artifacts.

For `dawn start`, invoke the app-local binary so only the Dawn process receives the preload:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318/v1/traces \
OTEL_SERVICE_NAME=dawn-app \
NODE_OPTIONS="--experimental-loader=@opentelemetry/instrumentation/hook.mjs --import=./instrumentation.mjs" \
./node_modules/.bin/dawn start --host 127.0.0.1 --port 8000
```

For the generated Node target, run the emitted entry directly:

```bash
pnpm exec dawn build --clean

OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318/v1/traces \
OTEL_SERVICE_NAME=dawn-app \
NODE_OPTIONS="--experimental-loader=@opentelemetry/instrumentation/hook.mjs --import=./instrumentation.mjs" \
node .dawn/build/server.mjs
```

The preload runs before `.dawn/build/server.mjs` imports `@dawn-ai/cli`. Keep `instrumentation.mjs` in the app root and in the build context.

### Generated Docker image

Do not edit the marker-managed Dockerfile. Its existing `CMD ["node", ".dawn/build/server.mjs"]` automatically honors `NODE_OPTIONS`, and its `COPY . .` places the root preload at `/app/instrumentation.mjs`.

After building the Dawn-generated image, inject the preload and secrets at container run time:

```bash
docker run --rm \
  --publish 127.0.0.1:8000:8000 \
  --env-file .env \
  --env 'NODE_OPTIONS=--experimental-loader=@opentelemetry/instrumentation/hook.mjs --import=./instrumentation.mjs' \
  my-dawn-app
```

Ensure `.dockerignore` does not exclude `instrumentation.mjs`, keep the OTel packages in regular `dependencies`, and refresh `package-lock.json` because the generated image installs with npm. The OTLP endpoint from `--env-file` must be reachable from inside the container; `127.0.0.1` refers to the container itself, not a collector running on the host. In a container platform, use the collector's service address and set the same complete `NODE_OPTIONS` value in the workload environment rather than changing the generated command.

## Configure environment

Provide these values through the runtime's secret and environment mechanism:

```dotenv
# Full OTLP/HTTP traces endpoint expected by OTLPTraceExporter
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318/v1/traces

# Human-readable service name shown in traces
OTEL_SERVICE_NAME=dawn-app

# Optional backend authentication, as comma-separated key=value pairs
# OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20your-token
```

Document variable names without values in `.env.example`. Never commit populated credentials. `dawn start` does not automatically load `.env` or `config.env`; the shell examples above set non-secret local values explicitly, while production should inject all values through its process, container, or platform configuration.

OpenTelemetry and other tracing integrations are independent. `dawn dev` enables LangSmith tracing when `LANGSMITH_API_KEY` is present; an OTel-instrumented Node deployment exports separately to the configured OTLP backend.

## Verify end to end

1. Start the Node runtime with `NODE_OPTIONS` using one of the commands above.
2. Confirm process health:

   ```bash
   curl --fail http://127.0.0.1:8000/healthz
   ```

3. Exercise a real route so HTTP and model/tool activity can produce spans:

   ```bash
   echo '{"messages":[{"role":"user","content":"Hello"}]}' \
     | pnpm exec dawn run /research --url http://127.0.0.1:8000
   ```

4. In the observability backend, find a trace whose service name matches `OTEL_SERVICE_NAME`. The preload check alone does not prove export; the backend trace does.
5. If no trace arrives, verify collector reachability and authentication from the same runtime environment. A connection error indicates an unreachable endpoint; a 4xx response usually indicates missing or invalid `OTEL_EXPORTER_OTLP_HEADERS`.

## Updating an existing install

### Version 2

If root `instrumentation.mjs` starts with `// dawn-blueprint: opentelemetry@2`:

1. Compare it with the current template while preserving the service name, exporter options, headers, and intentional instrumentation overrides.
2. Keep `sdk.start()` at top level; do not turn it back into an uncalled exported function.
3. Run `node --check instrumentation.mjs`, the standalone preload command, and the end-to-end trace check.
4. Confirm every Node deployment path supplies both the ESM loader hook and `--import=./instrumentation.mjs` in `NODE_OPTIONS`, including the generated Docker image.

### Migrating version 1

If `src/lib/otel.ts` starts with `// dawn-blueprint: opentelemetry@1`:

1. Create root `instrumentation.mjs` from the version 2 template and carry forward only intentional exporter, resource, and instrumentation customizations.
2. Confirm the new file calls `sdk.start()` at top level.
3. Replace every `dist/lib/otel.js`, TypeScript-loader, and old preload reference with the ESM loader hook plus `--import=./instrumentation.mjs` through `NODE_OPTIONS`.
4. Validate the direct Dawn, generated-server, and container startup path the app actually deploys.
5. After trace export is confirmed and no import references remain, remove the legacy `src/lib/otel.ts` file.

Reference: https://opentelemetry.io/docs/languages/js/getting-started/nodejs/
