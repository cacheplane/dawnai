---
description: Containerize a Dawn app as a LangGraph platform image for self-hosting.
website: https://langchain-ai.github.io/langgraphjs/
version: 2
tags: [deploy, docker, self-host, langgraph]
source: official
---

# Containerize your Dawn app with Docker

You are an AI coding agent containerizing a Dawn app for self-hosting. Dawn builds a LangGraph **platform** deploy artifact (`langgraph.json` + entry files); this guide uses the LangGraph CLI to turn that artifact into a Docker image. It does NOT replace LangSmith (Dawn's default deploy target), and it does NOT hand-roll a `node server.js` — Dawn has no standalone server; the image runs the LangGraph platform runtime.

## Prerequisites / when not to apply

Before proceeding, confirm all of the following are true:

1. **Docker is installed** — run `docker --version` to confirm. If it is not installed, direct the user to [docker.com/get-started](https://www.docker.com/get-started/) and stop.
2. **The user is self-hosting** — this blueprint is for running a Dawn app in your own container environment. If the user deploys to **LangSmith** (Dawn's default deploy target), they do **not** need this — LangSmith handles containerization itself from the `langgraph.json` artifact `dawn build` produces. If the user is LangSmith-only, stop here and point them to [Deployment](/docs/deployment).
3. **The user understands the platform requirements** — the Docker image this guide produces is a **LangGraph platform** image. Running it requires:
   - **Postgres** and **Redis** (the platform stores thread state in Postgres and uses Redis for pub/sub)
   - A **LangGraph/LangSmith license key** (`LANGGRAPH_CLOUD_LICENSE_KEY` or a LangSmith API key for the self-hosted-lite tier)

   The `langgraphjs up` command (from the LangGraph CLI) provisions Postgres and Redis locally via docker-compose and is the easiest way to run the image locally. See the [LangGraph self-hosting docs](https://langchain-ai.github.io/langgraphjs/) for full infrastructure details.

   If the user only needs a simple `node server.js` container, explain that Dawn does not produce a standalone HTTP server — `dawn build` emits `langgraph.json`, not a runnable server script — and stop.

## Inspect the project

Run these checks before writing any files:

1. **Package manager** — detect from lockfile: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm. This determines install commands used later.
2. **App config** — read `dawn.config.ts` and note the `appDir` field (defaults to `src/app`).
3. **AGENTS.md** — read it if present for project-specific conventions (naming, style).
4. **Existing Dockerfile check** — look for a root `Dockerfile`. If it exists and its first line is `# dawn-blueprint: docker@2`, skip to [Updating an existing install](#updating-an-existing-install). If it is `# dawn-blueprint: docker@1`, this is an older version — proceed with the steps below to regenerate it.
5. **pnpm build script approval** — if the package manager is pnpm, check `package.json` for `pnpm.onlyBuiltDependencies`. Newer Dawn scaffolds include `["esbuild"]` in this list. If it is absent, the `pnpm i` step inside the generated image will fail with `ERR_PNPM_IGNORED_BUILDS` because esbuild's native binary requires a post-install script. Add it now if missing:

   ```json
   {
     "pnpm": {
       "onlyBuiltDependencies": ["esbuild"]
     }
   }
   ```

## Install the LangGraph CLI

Add `@langchain/langgraph-cli` as a dev dependency. Its bin is `langgraphjs`.

```bash
# pnpm (detected from pnpm-lock.yaml)
pnpm add -D @langchain/langgraph-cli

# npm equivalent
# npm install --save-dev @langchain/langgraph-cli

# yarn equivalent
# yarn add -D @langchain/langgraph-cli
```

Confirm the bin is available after install:

```bash
pnpm exec langgraphjs --version
```

## Build the deploy artifact and the image

### 1. Build the Dawn deploy artifact

```bash
pnpm exec dawn build --clean
```

This writes `.dawn/build/langgraph.json` and the compiled entry files. The graph paths inside `langgraph.json` are relative to the **app root** (e.g. `./.dawn/build/hello-tenant.ts:graph`).

### 2. Copy the config to the app root

```bash
cp .dawn/build/langgraph.json ./langgraph.json
```

**Why this step is required:** `langgraphjs` resolves graph paths relative to the location of the config file it reads. If you point it at `.dawn/build/langgraph.json`, it resolves `./.dawn/build/hello-tenant.ts` relative to `.dawn/build/` and looks for `.dawn/build/.dawn/build/hello-tenant.ts` — a path that does not exist. Placing `langgraph.json` at the root makes the paths resolve correctly.

Add the generated copy to `.gitignore` (or keep a hand-authored root `langgraph.json` — Dawn shallow-merges it on build):

```bash
echo 'langgraph.json' >> .gitignore
```

### 3. Generate the Dockerfile

```bash
npx @langchain/langgraph-cli dockerfile ./Dockerfile
```

Then add the blueprint marker as the **first line** of the generated `Dockerfile` (the CLI does not include it; re-add it after each regeneration):

```dockerfile
# dawn-blueprint: docker@2
FROM langchain/langgraphjs-api:22
ADD . /deps/<your-app-name>
ENV LANGSERVE_GRAPHS=...
RUN pnpm i --frozen-lockfile
...
```

The generated `FROM langchain/langgraphjs-api:22` base image bundles the LangGraph platform runtime. Note: the LangGraph CLI readme mentions Node 20 only, but Node 22 works — the readme is stale on this point.

You may optionally add a brief `.dockerignore` to keep the build context lean. Since `ADD . /deps/<app>` copies the entire context, excluding large or sensitive directories speeds up the build:

```
node_modules
.git
.env
.env.local
.env.*.local
coverage
.DS_Store
```

### 4. Build the Docker image

Build directly from the generated Dockerfile:

```bash
docker build -t my-dawn-app .
```

Or skip the Dockerfile and build in one step using the CLI:

```bash
npx @langchain/langgraph-cli build -t my-dawn-app
```

## Configure environment

Runtime secrets are passed to the container at run time — never baked into the image. The LangGraph platform runtime requires several variables in addition to your model provider keys:

```
# Model provider key — required by your agent
OPENAI_API_KEY=sk-...

# LangGraph platform runtime — required to run the image
POSTGRES_URI=postgres://user:password@host:5432/langgraph
REDIS_URI=redis://host:6379

# License — required to run the LangGraph platform runtime.
# Use your LangSmith API key for the self-hosted-lite tier,
# or a dedicated LANGGRAPH_CLOUD_LICENSE_KEY for the full platform.
LANGSMITH_API_KEY=lsv2_...
# LANGGRAPH_CLOUD_LICENSE_KEY=...
```

See the [LangGraph self-hosting docs](https://langchain-ai.github.io/langgraphjs/) for the full list of platform environment variables and tier details.

Document required variables in `.env.example` so contributors know what to provide. Never commit `.env` or bake secrets into the image.

## Verify

1. **Confirm the build succeeds:**

   ```bash
   docker build -t my-dawn-app .
   ```

   A clean exit means the image was built. If `pnpm i` fails inside the image with `ERR_PNPM_IGNORED_BUILDS`, add `esbuild` to `pnpm.onlyBuiltDependencies` in `package.json` (see [Inspect the project](#inspect-the-project)).

2. **Run locally with `langgraphjs up`** — this is the fastest path to a local smoke test. The command provisions Postgres and Redis via docker-compose and runs your image against them:

   ```bash
   npx @langchain/langgraph-cli up
   ```

   You will need the license key (or LangSmith API key) set in your environment for the runtime to start.

3. **Hit the platform endpoints:**

   ```bash
   curl http://localhost:8123/healthz
   curl http://localhost:8123/threads
   ```

   A 200 response on `/healthz` confirms the LangGraph platform runtime is up. `/threads` is the Agent Protocol endpoint for creating and listing conversation threads.

4. **Check env vars** — if the runtime starts but the agent fails, confirm all required variables (model key, `POSTGRES_URI`, `REDIS_URI`, license key) are present and being passed to the container.

## Updating an existing install

If the root `Dockerfile` already exists and its first line is `# dawn-blueprint: docker@2`:

1. Re-run the build to refresh the artifact:

   ```bash
   pnpm exec dawn build --clean
   cp .dawn/build/langgraph.json ./langgraph.json
   ```

2. Regenerate the Dockerfile (this overwrites it):

   ```bash
   npx @langchain/langgraph-cli dockerfile ./Dockerfile
   ```

3. Re-add the marker as the first line of the regenerated `Dockerfile`:

   ```
   # dawn-blueprint: docker@2
   ```

4. Preserve any `dockerfile_lines` customizations you had added to `langgraph.json` (the LangGraph CLI reads this field to inject extra Dockerfile instructions — it survives regeneration as long as your `langgraph.json` still contains it).

5. Rebuild with `docker build -t my-dawn-app .` to confirm the image still builds cleanly.
