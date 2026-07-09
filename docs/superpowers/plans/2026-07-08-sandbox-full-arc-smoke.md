# Full-arc sandbox smoke — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two gated CI lanes proving the sandbox arc end-to-end — a real Dawn app, built and deployed the user-facing way, driving a sandbox provider from inside its own workload to spawn a real isolated sandbox and tear it down.

**Architecture:** One committed minimal Dawn app (`test/k8s-smoke/app/`) + a baked aimock mock provide a deterministic, no-key agent turn that calls `runBash`. A Verdaccio-based image build puts the local `@dawn-ai/*` code in the image. `sandbox-k8s-e2e` runs it on kind+Calico across both Helm charts (cross-namespace); `sandbox-docker-e2e` runs it as a container with the host Docker socket mounted (docker-out-of-docker). Assertions live in committed shell scripts.

**Tech Stack:** kind, Calico, Helm, `@kubernetes/client-node`, Docker, `@copilotkit/aimock`, `langgraphjs dockerfile`, Verdaccio (existing harness), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-08-sandbox-full-arc-smoke-design.md`

---

## File structure

- `test/k8s-smoke/app/` — the smoke Dawn app: `package.json`, `dawn.config.ts`, `src/app/smoke/index.ts`, `workspace/.gitkeep`, `fixtures/smoke.json` (aimock).
- `test/k8s-smoke/aimock/` — `Dockerfile` + entrypoint that serves the baked fixture.
- `test/k8s-smoke/build-image.sh` — shared Verdaccio-based image build (arg: `k8s|docker`).
- `test/k8s-smoke/assert-k8s.sh` — K8s-lane assertions.
- `test/k8s-smoke/assert-docker.sh` — Docker-lane assertions.
- `test/k8s-smoke/values-dawn-app.yaml`, `values-sandbox-infra.yaml` — chart overrides for the K8s lane.
- `.github/workflows/ci.yml` — two new jobs: `sandbox-k8s-e2e`, `sandbox-docker-e2e`.
- `apps/web/content/docs/sandbox.mdx` — a short "Verifying the full arc" note.

Naming: the app route is `/smoke` (assistant id `/smoke#agent`). The sandbox namespace is `dawn-sandboxes`; the app namespace is `dawn-app`.

---

## Task 1: Spike — Verdaccio → `docker build` install → run

**Goal:** Prove (before building anything real) that a container image can `npm install` a local `@dawn-ai/*` package from the harness Verdaccio during `docker build`, and run. This de-risks the spec's primary risk. **This task's output is a decision, recorded in the plan, not shipped code.**

**Files:**
- Scratch only (`/tmp` or scratchpad). Nothing committed except a short findings note appended to this plan.

- [ ] **Step 1: Stand up the harness Verdaccio and publish one package**

Read `test/harness/local-registry.ts` and `test/harness/packaged-app.ts` to see how the existing harness starts Verdaccio and publishes local packages by scope. Start it manually (or via the harness helper) and publish `@dawn-ai/sandbox` (+ its local `@dawn-ai/*` deps) to it. Capture the registry URL (e.g. `http://localhost:4873`).

- [ ] **Step 2: Build a throwaway image that installs from it**

Write a scratch `Dockerfile`:

```dockerfile
FROM node:22-slim
ARG NPM_REGISTRY
WORKDIR /app
RUN npm init -y && npm install --registry "$NPM_REGISTRY" @dawn-ai/sandbox
RUN node -e "require('@dawn-ai/sandbox'); console.log('resolved @dawn-ai/sandbox OK')"
```

Build it two ways and record which works on this runner:
- `docker build --network host --build-arg NPM_REGISTRY=http://localhost:4873 .`
- `docker build --build-arg NPM_REGISTRY=http://host.docker.internal:4873 --add-host=host.docker.internal:host-gateway .`

Run: `docker build ...`
Expected: the `RUN node -e ...` layer prints `resolved @dawn-ai/sandbox OK`.

- [ ] **Step 3: Record the decision**

Append a short "Task 1 findings" section to THIS plan file: which networking form worked (`--network host` vs `host-gateway`), the exact working `docker build` invocation, and — if neither worked — confirm the fallback (pack local `@dawn-ai/*` tarballs into the build context as `file:` deps, reusing `packCurrentPackage` from `test/harness/packaged-app.ts`). Tasks 2–4 use whatever this step records.

- [ ] **Step 4: Commit the findings note**

```bash
git add docs/superpowers/plans/2026-07-08-sandbox-full-arc-smoke.md
git commit -m "docs(plan): record full-arc smoke image-build spike findings"
```

## Task 1 findings (spike)

**Verified locally on macOS (Docker Desktop, `desktop-linux` driver).** Started the harness Verdaccio standalone via `startLocalRegistry()` + `publishWorkspace(url)` from `test/harness/local-registry.ts` (same code path `registry-global-setup.ts` uses) — this publishes every non-private `packages/*` package, so `@dawn-ai/sandbox` and its workspace dep `@dawn-ai/workspace` both land on the registry in one call; no extra wiring needed. Registry bound to `http://127.0.0.1:<port>/`.

**`--network host` FAILED on macOS**, exactly as expected — Docker Desktop's build runs in a Linux VM where `--network host` does not expose the Mac host's loopback:

```bash
docker build --network host --build-arg NPM_REGISTRY=http://localhost:<port> -f Dockerfile .
# → npm error code ECONNREFUSED ... request to http://localhost:<port>/@dawn-ai%2fsandbox failed
```

**`host.docker.internal` form WORKED — this is the invocation to use on macOS:**

```bash
docker build --add-host=host.docker.internal:host-gateway \
  --build-arg NPM_REGISTRY=http://host.docker.internal:<port> \
  -t dawn-spike -f Dockerfile .
```

Result: `npm install` resolved `@dawn-ai/sandbox` and its transitive deps (`@dawn-ai/workspace` from the local registry, `@kubernetes/client-node` proxied through to npmjs by the same Verdaccio config) — 70 packages added, no errors. The `RUN` check layer printed `resolved @dawn-ai/sandbox OK`.

**Registry-URL form to use:** `http://host.docker.internal:<port>` as the `NPM_REGISTRY` build-arg on macOS, with `--add-host=host.docker.internal:host-gateway` on the `docker build` command (Docker Desktop for Mac typically resolves `host.docker.internal` without the flag, but passing it is harmless and is what makes the same invocation portable to Docker Engine on Linux, where it is NOT resolved by default).

**Mac vs CI (ubuntu-latest) — call this out explicitly for the lane implementer:** GitHub-hosted `ubuntu-latest` runners use the real Docker Engine (no VM layer), where **`--network host` DOES expose the host's ports** to the build, unlike Docker Desktop's macOS VM. So the two environments likely want *different* invocations:
- **macOS dev machine:** `--add-host=host.docker.internal:host-gateway` + `NPM_REGISTRY=http://host.docker.internal:<port>` (proven above).
- **CI (ubuntu-latest, Docker Engine):** `--network host` + `NPM_REGISTRY=http://localhost:<port>` is expected to work and is simpler (no `--add-host` needed) — but this was NOT empirically verified in this spike (no CI run was executed). The `host.docker.internal` form should also work on CI if `--add-host=host.docker.internal:host-gateway` is always included, so **the safest single invocation for both lanes is the `host.docker.internal` form** (works on both, per Docker's own docs for Engine ≥20.10) — recommend Tasks 3–5 standardize on that everywhere rather than branching by OS, unless a real CI run shows a reason not to.

**Gotchas:**
- `@dawn-ai/sandbox` is ESM-only (`"type": "module"`, `exports` has no `require` condition). `node --input-type=module -e "import('@dawn-ai/sandbox')..."` resolved cleanly. Also tested plain `require('@dawn-ai/sandbox')` out of curiosity: it succeeded too (exit 0, no output) — Node 22.12+ (the `node:22-slim` tag pulled here) supports synchronous `require(esm)` for fully-ESM packages by default, so either check form works on this base image. Prefer the `import()` form in the smoke Dockerfile regardless, since it's guaranteed correct independent of Node's require-esm interop version.
- `publishWorkspace` requires every public package to share one version (`assertUniformPublishableVersion`) — true today (all `0.8.9`), so no extra step needed, but Tasks 3–5 should not assume this holds forever if a package's version ever drifts mid-release.
- Registry publish reused `pnpm pack` against already-built `dist/` — the workspace here had a stale build present already (`packages/sandbox/dist`, `packages/workspace/dist`); a from-scratch spike run should `pnpm build` first (the real lane's CI job already does a build step before this point).

**Tarball fallback: NOT needed.** The `host.docker.internal` registry form worked outright; no fallback to `file:`-tarball deps was required or tested.

**Decision for Tasks 3–5:** use the Verdaccio + `host.docker.internal` install path (not the tarball fallback) for the `build-image.sh` scripts, with `--add-host=host.docker.internal:host-gateway` unconditionally included on every `docker build` invocation (harmless when unneeded, load-bearing on macOS, expected-safe on CI).

---

## Task 2: The smoke Dawn app

**Files:**
- Create: `test/k8s-smoke/app/package.json`
- Create: `test/k8s-smoke/app/dawn.config.ts`
- Create: `test/k8s-smoke/app/src/app/smoke/index.ts`
- Create: `test/k8s-smoke/app/workspace/.gitkeep`
- Create: `test/k8s-smoke/app/fixtures/smoke.json`

- [ ] **Step 1: package.json**

```json
{
  "name": "dawn-smoke-app",
  "private": true,
  "type": "module",
  "scripts": { "build": "dawn build", "dev": "dawn dev" },
  "dependencies": {
    "@dawn-ai/cli": "*",
    "@dawn-ai/langchain": "*",
    "@dawn-ai/sandbox": "*"
  }
}
```

(Versions are `*` — the image build installs the exact published-to-Verdaccio versions. Add any `@langchain/*` peer deps the scaffold template declares; mirror `create-dawn-ai-app`'s template `package.json` for the peer set.)

- [ ] **Step 2: dawn.config.ts — provider selected by env**

```ts
import { config } from "@dawn-ai/cli"
import { dockerSandbox, kubernetesSandbox } from "@dawn-ai/sandbox"

const provider =
  process.env.DAWN_SMOKE_SANDBOX === "docker"
    ? dockerSandbox({ image: "node:22-slim" })
    : kubernetesSandbox({ image: "node:22-slim", namespace: "dawn-sandboxes" })

export default config({
  sandbox: { provider, network: { mode: "deny" } },
})
```

- [ ] **Step 3: the route**

`src/app/smoke/index.ts`:

```ts
import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt:
    "You are a sandbox smoke agent. When asked to identify the sandbox, call runBash with `id -u && hostname` and reply with its exact stdout.",
})
```

The workspace capability auto-activates because `workspace/` exists (Step 4), contributing `runBash`. The sandbox intercepts `runBash` for the thread.

- [ ] **Step 4: workspace marker**

Create an empty `test/k8s-smoke/app/workspace/.gitkeep` so the workspace capability (and thus `runBash`) is active.

- [ ] **Step 5: aimock fixture**

`fixtures/smoke.json` — the committed deterministic script. Match the fixture shape `@dawn-ai/testing`/aimock already use (see `test/runtime/fixtures/aimock/` and `packages/testing/src`). It must, for the user message `"identify the sandbox"`:
1. First turn (no tool result yet) → assistant message with a `runBash` tool call, args `{ "command": "id -u && hostname" }`.
2. Second turn (has tool result) → assistant final message whose content is exactly the tool stdout.

Copy the exact JSON structure from an existing committed fixture that drives a tool call (grep `test/` for a fixture with `tool_calls`) and adapt the tool name/args. Do not invent a shape.

- [ ] **Step 6: verify it scaffolds + builds locally (no container yet)**

From `test/k8s-smoke/app/`, with the repo's local packages linked (pnpm workspace or the Verdaccio install from Task 1), run `pnpm dawn build`.
Expected: emits a root `langgraph.json` and typegen succeeds (the `/smoke#agent` route + `runBash` tool are discovered). If build needs packages not in the workspace, note them for the image build.

- [ ] **Step 7: Commit**

```bash
git add test/k8s-smoke/app
git commit -m "test(smoke): minimal Dawn app (workspace + runBash, env-selected sandbox)"
```

---

## Task 3: aimock image + shared image build

**Files:**
- Create: `test/k8s-smoke/aimock/Dockerfile`
- Create: `test/k8s-smoke/build-image.sh`

- [ ] **Step 1: aimock image**

`test/k8s-smoke/aimock/Dockerfile` — a small image that runs `@copilotkit/aimock` serving the app's committed fixture on a fixed port. Read how the test harness starts aimock (`test/**/aimock*.ts`) to get the invocation and fixture-loading flag. Bake `test/k8s-smoke/app/fixtures/smoke.json` into the image (COPY it in) and start aimock pointed at it. Expose the port aimock listens on.

- [ ] **Step 2: shared build script**

`test/k8s-smoke/build-image.sh` takes `$1 = k8s|docker` and `$2 = registry URL`. It:
1. `dawn build` the app (in `test/k8s-smoke/app`), then `langgraphjs dockerfile` to generate the app Dockerfile (per the "Dawn self-host / docker" guidance — build against the ROOT `langgraph.json`).
2. `docker build` the app image installing `@dawn-ai/*` from the Verdaccio registry using the **exact invocation Task 1 recorded**. For `docker`, additionally install the `docker` CLI client in the image (append a layer / `--build-arg`), since `dockerSandbox` shells out to `docker`.
3. Tag: `dawn-smoke-app:$1`.

Keep the two variants as close as possible — only the docker-CLI layer and the default `DAWN_SMOKE_SANDBOX` differ.

- [ ] **Step 3: smoke the build locally**

Run `sh test/k8s-smoke/build-image.sh k8s <verdaccio-url>` with the Task-1 Verdaccio up.
Expected: `dawn-smoke-app:k8s` builds; `docker run --rm dawn-smoke-app:k8s node -e "require('@dawn-ai/sandbox')"` resolves OK.

- [ ] **Step 4: Commit**

```bash
git add test/k8s-smoke/aimock test/k8s-smoke/build-image.sh
git commit -m "test(smoke): aimock image + shared Verdaccio image build"
```

---

## Task 4: `sandbox-k8s-e2e` lane + assertions

**Files:**
- Create: `test/k8s-smoke/assert-k8s.sh`
- Create: `test/k8s-smoke/values-sandbox-infra.yaml`, `test/k8s-smoke/values-dawn-app.yaml`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: chart value overrides**

`values-sandbox-infra.yaml` — add the app SA as a cross-namespace orchestrator subject:

```yaml
orchestrator:
  subjects:
    - kind: ServiceAccount
      name: dawn-app
      namespace: dawn-app
```

`values-dawn-app.yaml` — image `dawn-smoke-app:k8s` (`imagePullPolicy: Never` for kind-loaded), `serviceAccount.create: true` (name `dawn-app`), `env` includes `DAWN_SMOKE_SANDBOX=k8s` and `OPENAI_BASE_URL=http://aimock.dawn-app.svc.cluster.local:<port>/v1`, plus a dummy `OPENAI_API_KEY`. Set `containerPort`/`healthPath` to the app's real values.

- [ ] **Step 2: assertion script**

`assert-k8s.sh` (run after the app is Ready; takes the app Service URL, reachable via `kubectl port-forward` or an in-cluster curl Job):
1. `POST /threads` → capture `thread_id`.
2. `POST /threads/$id/runs/wait` with `{ "route": "/smoke", "input": { "messages": [{ "role": "user", "content": "identify the sandbox" }] } }`.
3. Assert the final message stdout contains `1000` (uid) on its first line.
4. `kubectl get pods -n dawn-sandboxes -o json` → assert exactly one `dawn-sbx-*` Pod exists; assert its `spec.securityContext.runAsNonRoot==true`, `runAsUser!=0`, and a `NetworkPolicy` matching the thread exists.
5. Assert the run's reported hostname equals the sandbox Pod name (not the app pod).
6. `DELETE /threads/$id` → poll until the `dawn-sbx-*` Pod **and** its PVC are gone (bounded, e.g. 60s).

Every failed assertion `echo`s context (`kubectl get`/`describe`) and exits non-zero.

- [ ] **Step 3: the CI job**

Add `sandbox-k8s-e2e` to `ci.yml`, mirroring `sandbox-k8s`'s kind+Calico setup and SHA-pinned actions. Steps: create cluster (no default CNI) → install Calico → start Verdaccio + publish local packages (reuse the harness path) → `build-image.sh k8s` + `kind load docker-image dawn-smoke-app:k8s` + build/load the aimock image → `kubectl create ns dawn-app` → `helm install dawn-sandbox-infra -n dawn-sandboxes --create-namespace -f values-sandbox-infra.yaml` → deploy aimock (Deployment+Service in `dawn-app`) → `helm install dawn-app -n dawn-app -f values-dawn-app.yaml --wait` → `sh assert-k8s.sh` → always-run cleanup. Gate with `env: DAWN_TEST_SMOKE_E2E: "1"` (its own job, like `sandbox-k8s`).

- [ ] **Step 4: validate YAML + run it**

`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` and `actionlint`. This lane can only be truly validated in CI (needs kind); push happens in Task 6. Locally, at minimum run `assert-k8s.sh`'s logic against a hand-brought-up kind if the implementer has kind, else note "CI-validated".

- [ ] **Step 5: Commit**

```bash
git add test/k8s-smoke/assert-k8s.sh test/k8s-smoke/values-*.yaml .github/workflows/ci.yml
git commit -m "test(smoke): sandbox-k8s-e2e lane — app-in-pod drives kubernetesSandbox"
```

---

## Task 5: `sandbox-docker-e2e` lane + assertions

**Files:**
- Create: `test/k8s-smoke/assert-docker.sh`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: assertion script**

`assert-docker.sh`:
1. `docker network create dawn-smoke-net`.
2. Run aimock: `docker run -d --name aimock --network dawn-smoke-net dawn-smoke-aimock`.
3. Run the app: `docker run -d --name dawn-smoke-app --network dawn-smoke-net -v /var/run/docker.sock:/var/run/docker.sock -e DAWN_SMOKE_SANDBOX=docker -e OPENAI_BASE_URL=http://aimock:<port>/v1 -e OPENAI_API_KEY=dummy -p 8000:<port> dawn-smoke-app:docker`.
4. Wait for the app health endpoint.
5. Drive the same AP conversation (`POST /threads`, `runs/wait`).
6. Assert stdout contains `1000`; `docker ps --filter name=dawn-sbx-` shows exactly one sibling container; `docker inspect` it for non-root user + `ReadonlyRootfs==true`; reported hostname == the sibling container id/hostname.
7. `DELETE` thread → assert the `dawn-sbx-*` container **and** volume are gone.
8. Trailing cleanup (always): remove app, aimock, network, and any `dawn-sbx-*` containers/volumes.

- [ ] **Step 2: the CI job**

Add `sandbox-docker-e2e` to `ci.yml`, mirroring `sandbox-docker`'s setup (it already proves host Docker works). Steps: checkout/pnpm/node → start Verdaccio + publish → `build-image.sh docker` + build the aimock image → `sh assert-docker.sh` → always-run cleanup. Gate `env: DAWN_TEST_SMOKE_E2E: "1"`.

- [ ] **Step 3: validate + commit**

Validate YAML + actionlint. If the implementer has local Docker, run `assert-docker.sh` end-to-end (the daemon is available on this machine — do it and report the result). Then:

```bash
git add test/k8s-smoke/assert-docker.sh .github/workflows/ci.yml
git commit -m "test(smoke): sandbox-docker-e2e lane — containerized app drives dockerSandbox (DooD)"
```

---

## Task 6: Docs + land the PR

**Files:**
- Modify: `apps/web/content/docs/sandbox.mdx`
- (no changeset — test/CI/docs only, no `packages/**` change; the `changesets` check only gates package changes.)

- [ ] **Step 1: docs**

Add a short "Verifying the full arc" subsection to `sandbox.mdx`: what the two gated e2e lanes prove (a deployed app really drives the provider to spawn + tear down an isolated sandbox), how to run them locally (`DAWN_TEST_SMOKE_E2E=1` + kind / Docker), and the honest bound (kind ≠ cloud; deterministic aimock, not real-model). No banned phrases (`scripts/check-docs.mjs`); any model id gpt-5 family. Run `node scripts/check-docs.mjs` → PASS.

- [ ] **Step 2: full local verification**

`pnpm build && pnpm typecheck && pnpm lint && node scripts/check-docs.mjs`. The smoke app under `test/` must not break the workspace build/typecheck (it's not a workspace package — confirm it's excluded from `pnpm-workspace.yaml` globs, or add an ignore so its `*` deps don't confuse the installer). If it IS picked up as a workspace package, exclude `test/k8s-smoke/**` in `pnpm-workspace.yaml`.

- [ ] **Step 3: push + PR + watch the new lanes**

Rebase on `origin/main`, push, open the PR. Watch `sandbox-k8s-e2e` and `sandbox-docker-e2e` (both new) plus the existing lanes. Iterate on real CI output until both e2e lanes are green (this is where the lane is truly validated). Address any advisory-review / CodeQL findings.

---

## Notes for the executor

- **Determinism:** never introduce a real `OPENAI_API_KEY` path; the aimock fixture is the only model source.
- **Cleanup is mandatory** in both lanes (always-run steps) — leaked `dawn-sbx-*` Pods/containers/volumes will poison reruns and the shared runner.
- **The spike (Task 1) gates the build mechanism** for Tasks 3–5. Do it first and record the outcome before wiring lanes.
- **kind image loading:** `imagePullPolicy: Never` + `kind load docker-image` for every locally-built image; the sandbox workload image (`node:22-slim`) must also be pullable inside the cluster/daemon.
- Branch is `feat/sandbox-full-arc-smoke`; pin it before dispatching subagents (multi-worktree detached-HEAD hazard); never bare `biome check --write`.
