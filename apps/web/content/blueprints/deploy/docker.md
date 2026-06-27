---
description: Containerize a Dawn app with a production Dockerfile.
website: https://www.docker.com
version: 1
tags: [deploy, docker, self-host]
source: official
---

# Containerize your Dawn app with Docker

You are an AI coding agent adding a production Dockerfile to a Dawn app so it can be self-hosted as a container. It builds the app with `dawn build` and runs the result. It does NOT set up CI/CD, a container registry, or orchestration (Kubernetes/Compose) — it produces a `Dockerfile` and `.dockerignore` you can build and run.

## Prerequisites / when not to apply

Before proceeding, confirm both of the following are true:

1. **Docker is installed** — run `docker --version` to confirm. If it is not installed, direct the user to [docker.com/get-started](https://www.docker.com/get-started/) and stop.
2. **The user is self-hosting** — this blueprint is for running a Dawn app in your own container environment. If the user deploys to **LangSmith** (Dawn's default deploy target), they do **not** need a Dockerfile — LangSmith builds and runs the app from the `langgraph.json` artifact that `dawn build` produces. If the user is LangSmith-only, stop here and point them to [Deployment](/docs/deployment).

## Inspect the project

Run these checks before writing any files:

1. **Package manager** — detect from lockfile: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm. This determines the install commands in the Dockerfile.
2. **App config** — read `dawn.config.ts` and note the `appDir` field (defaults to `src/app`).
3. **AGENTS.md** — read it if present for project-specific conventions (naming, style, preferred base images).
4. **Existing Dockerfile check** — look for a root `Dockerfile`. If it exists and its first line is `# dawn-blueprint: docker@1`, skip to [Updating an existing install](#updating-an-existing-install).
5. **Start command and port** — determine how the built app is started in production (e.g. `node dist/server.js`, `node .dawn/build/server.js`, or a `start` script in `package.json`) and which port it listens on. Ask the user to confirm if you cannot determine this from the source.

## Install dependencies

No npm packages are added — Docker is external tooling. The Dockerfile uses the project's existing package manager (detected in the step above). If `docker` is not installed, point the user to [docker.com](https://www.docker.com/get-started/).

## Create the Dockerfile

Place this file at the **project root** as `Dockerfile`. The first line must be the marker comment exactly as shown — it identifies this file as managed by this blueprint.

Read the inline comments. You must adapt the **package manager commands**, **start command**, and **port** to match this project before saving.

```dockerfile
# dawn-blueprint: docker@1

# ── builder ──────────────────────────────────────────────────────────────────
# Install all dependencies and run `dawn build` to produce the deployment
# artifacts in .dawn/build/.
FROM node:22-slim AS builder

WORKDIR /app

# Enable corepack so pnpm is available without a separate install step.
# Adapt: remove this line (and use npm/yarn commands below) if not using pnpm.
RUN corepack enable

# Copy manifest and lockfile first so Docker can cache the install layer.
# Adapt: replace with the files your package manager uses:
#   pnpm  → package.json pnpm-lock.yaml
#   npm   → package.json package-lock.json
#   yarn  → package.json yarn.lock
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDependencies, needed for the build).
# Adapt: swap for your package manager:
#   npm   → npm ci
#   yarn  → yarn install --frozen-lockfile
RUN pnpm install --frozen-lockfile

# Copy the rest of the source.
COPY . .

# Build the Dawn deployment artifacts into .dawn/build/.
RUN pnpm exec dawn build --clean

# ── runner ────────────────────────────────────────────────────────────────────
# Smaller final image — only production dependencies + built artifacts.
FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Enable corepack in the runner stage too (needed if the start script uses pnpm).
# Adapt: remove if not using pnpm.
RUN corepack enable

# Copy manifest and lockfile so we can install production deps only.
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only.
# Adapt: swap for your package manager:
#   npm   → npm ci --omit=dev
#   yarn  → yarn install --frozen-lockfile --production
RUN pnpm install --frozen-lockfile --prod

# Copy the built artifacts from the builder stage.
COPY --from=builder /app/.dawn/build/ ./.dawn/build/

# Expose the port the app listens on.
# Adapt: replace 8123 with the actual port your app uses.
EXPOSE 8123

# Start the app.
# Adapt: replace with the command that starts your production server,
# e.g. "node", ".dawn/build/server.js" or a script defined in package.json.
CMD ["node", ".dawn/build/server.js"]
```

> **Checklist before saving:**
> - Package manager commands match the detected lockfile
> - `EXPOSE` port matches the port your app listens on
> - `CMD` matches the command that starts your production server

## Add a .dockerignore

Create a root `.dockerignore` to prevent large or sensitive directories from being sent to the Docker build context. This keeps builds fast and avoids accidentally baking secrets into the image.

```
# Dependencies (reinstalled inside the image)
node_modules

# Dawn build cache and generated files
.dawn

# Version control
.git
.gitignore

# Environment files — never copy these into an image
.env
.env.local
.env.*.local

# Editor and OS artifacts
.DS_Store
*.swp
*.swo
.vscode
.idea

# Test and coverage output
coverage
.nyc_output
```

## Configure environment

Runtime environment variables (model provider API keys, database URLs, etc.) are passed to the container at run time — they are **not** baked into the image. `.env` is already excluded via `.dockerignore`, so there is no risk of accidentally including secrets.

For local runs, pass variables with `--env-file`:

```bash
docker run --rm -p 8123:8123 --env-file .env my-dawn-app
```

In production, inject secrets through your hosting environment's secret management (e.g. `docker run -e KEY=value`, Kubernetes Secrets, AWS ECS task definitions). Never copy `.env` into the image and never commit secrets to the image layers.

Document required variables in `.env.example` so contributors know what to provide:

```
# Required at runtime
OPENAI_API_KEY=
# Add other provider keys and config here
```

## Verify

1. **Build the image:**

   ```bash
   docker build -t my-dawn-app .
   ```

   Confirm the build exits cleanly. If `dawn build` fails inside the container, check that all source files are copied before the build step and that no required env vars are needed at build time (they should not be).

2. **Run the container:**

   ```bash
   # Adapt: replace 8123 with your actual port
   docker run --rm -p 8123:8123 --env-file .env my-dawn-app
   ```

3. **Hit the health endpoint:**

   ```bash
   curl http://localhost:8123/healthz
   ```

   A 200 response confirms the server is up. If the connection is refused, verify that `EXPOSE` and `-p` use the same port, and that the `CMD` actually starts the server on that port.

4. **Check env vars** — if the container starts but the agent fails, confirm all required environment variables are present in `.env` and are being passed with `--env-file` (or `-e`).

## Updating an existing install

If the root `Dockerfile` already exists and its first line is `# dawn-blueprint: docker@1`:

1. Compare the existing file against the template in [Create the Dockerfile](#create-the-dockerfile).
2. Apply relevant improvements from this guide (e.g. layer-caching order, `--frozen-lockfile`, `--prod` flag for the runner stage) while **preserving the user's customisations** — base image variant, package manager, port, extra `COPY` steps, and any additional `RUN` commands they have added.
3. Do not change the marker line; it must remain `# dawn-blueprint: docker@1` as the first line of the file.
4. Rebuild with `docker build -t my-dawn-app .` after updating to confirm the image still builds cleanly.
