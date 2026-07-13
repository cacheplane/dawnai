# Full-arc sandbox smoke — design

**Date:** 2026-07-08
**Status:** approved (brainstorm)
**Topic:** End-to-end "everything works together" smoke tests for the execution-sandbox arc — a real Dawn app, deployed the way a user deploys it, driving a sandbox provider to spawn a real isolated workload and tear it down.

## Problem

The sandbox arc ships in three merged pieces — the `kubernetesSandbox`/`dockerSandbox` providers (0.8.9), the `dawn-sandbox-infra` Helm chart (#321), and the `dawn-app` deploy chart (#323). Every piece has its own gated CI lane, but each tests a **slice**:

- `sandbox-docker` — Docker provider conformance + hardening, run from the CI runner's shell.
- `sandbox-k8s` — kind+Calico, installs `sandbox-infra`, asserts orchestrator RBAC via `kubectl auth can-i`, runs provider conformance **from the runner's kubeconfig**.
- `chart-validate` — helm lint / render / kubeconform, both charts.
- `chart-apply-smoke` — installs `dawn-app` with an **nginx placeholder** image and curls the Service.

Nothing exercises the **composition**: a real Dawn app image, deployed by `dawn-app`, using the orchestrator ServiceAccount from `sandbox-infra`, that drives a sandbox provider **from inside its own running pod/container** on a real Agent-Protocol request, then cleans up. The chart RBAC is proven by a proxy (`can-i`), not by the app actually doing it; the provider is proven from the runner, not from a deployed workload; the placeholder app proves manifests apply but never touches the sandbox.

## Goal

Two gated CI lanes that prove the full self-host composition end-to-end, sharing one smoke app and one deterministic turn-driver:

- `sandbox-k8s-e2e` — the app runs as a Pod (deployed by `dawn-app`, orchestrator SA), drives `kubernetesSandbox` to spawn a sandbox **Pod**.
- `sandbox-docker-e2e` — the app runs as a **container** (self-host Docker deployment) with the host Docker socket mounted, drives `dockerSandbox` to spawn a **sibling** sandbox container (docker-out-of-docker).

Both are deterministic (no model key), reproducible, and gated by an env flag so they run on demand / on sandbox-touching changes — matching the existing `sandbox-k8s` pattern.

## Non-goals / honest bounds

- **kind ≠ a production cloud cluster.** Single-node, no microVM/gVisor, Calico-not-your-CNI. The lane proves *composition and wiring*, not cloud-grade isolation. A manual real-cluster (GKE/EKS) run remains a maintainer task; this design does not automate it.
- **No real-model correctness.** The agent turn is driven by `@copilotkit/aimock` with a committed fixture. We prove the sandbox is acquired and a command executes in it, not that a real model reasons well.
- Not a replacement for the slice lanes — it composes them, it does not subsume them. The existing `sandbox-docker` / `sandbox-k8s` / `chart-*` lanes stay.

## Architecture

### Shared foundation

**Smoke app** (`test/k8s-smoke/app/`, committed). A minimal Dawn app:

- One agent route with the workspace capability and a `runBash` tool.
- `dawn.config.ts` selects the sandbox provider from an env var so the *same source* builds both the K8s image (`kubernetesSandbox`) and the Docker image (`dockerSandbox`) — the provider is chosen at config-eval time from `DAWN_SMOKE_SANDBOX=k8s|docker`.
- A committed **aimock fixture** that, for a fixed user prompt, makes the agent call `runBash "id -u && hostname"` and return the output verbatim. This deterministically exercises **acquire → exec** in the sandbox.

**aimock in-cluster / in-container.** The existing `@copilotkit/aimock` mock, deployed alongside the app (a Deployment+Service in K8s; a sidecar/second container in the Docker lane), fixture baked into its image. The app's `OPENAI_BASE_URL` points at it. This is the same mock Dawn's deterministic e2e suite already uses, containerized.

**Image build (ephemeral Verdaccio).** The lane reuses the harness's ephemeral Verdaccio:

1. Publish the local `@dawn-ai/*` packages to a Verdaccio instance on the CI host (the packaged-app harness already knows how to stand this up and publish by scope).
2. `docker build` the smoke app image with `npm_config_registry` pointed at the host Verdaccio, reachable from the build via `--network host` (or `host.docker.internal`). The image therefore contains the framework **installed from a registry**, closest to a real user's `npm install @dawn-ai/*`.
3. `kind load docker-image` (K8s lane) or use the image directly on the host daemon (Docker lane).

The app image is built via the documented self-host path (`dawn build` → root `langgraph.json` → `langgraphjs dockerfile` → `docker build`), consistent with the "Dawn self-host / docker" guidance. **The Docker-lane image additionally installs the `docker` CLI client**, because `dockerSandbox` shells out to `docker` (`createDocker()`); the K8s-lane image needs no extra binary (`@kubernetes/client-node` is pure JS).

> **Primary technical risk, de-risked first:** getting local framework code into the image via Verdaccio requires `docker build`→host-registry networking on the CI runner. Task 1 of the plan is a spike that proves this networking end-to-end (build an image that installs one `@dawn-ai/*` package from the host Verdaccio and runs it) before any lane is wired. If host-registry networking proves too fragile, the documented fallback is packing local `@dawn-ai/*` tarballs into the build context as `file:` deps (hermetic, no networking) — the packaged-app harness already has the packing logic.

### `sandbox-k8s-e2e` lane

Extends the kind+Calico pattern:

1. Create kind cluster (no default CNI) → install Calico → wait Ready.
2. `helm install dawn-sandbox-infra` (namespace `dawn-sandboxes`), adding the app's ServiceAccount (`dawn-app/dawn-app`) as a **cross-namespace subject** on the orchestrator RoleBinding via the chart's `orchestrator.subjects` value.
3. Build + publish smoke app image (K8s variant) via Verdaccio; `kind load`. Build + `kind load` the aimock image (fixture baked in).
4. `helm install dawn-app` **into a separate `dawn-app` namespace** (deploy aimock there too); set `kubernetesSandbox({ namespace: "dawn-sandboxes" })`, `OPENAI_BASE_URL` → the in-cluster aimock Service, and `serviceAccount.create=true`. The app is deliberately **not** in `dawn-sandboxes` — that namespace's default-deny-egress backstop (from `sandbox-infra`) would otherwise block the app→aimock traffic, and this cross-namespace topology is exactly the `dawn-app` chart's documented deployment mode. The app creates sandbox Pods in `dawn-sandboxes` using its mounted SA token, authorized by the cross-namespace RoleBinding subject from step 2.
5. Wait for the app Deployment to be Ready.
6. Drive one Agent-Protocol conversation against the app Service: `POST /threads` → run with the fixture's prompt.
7. Assert (below).
8. `DELETE /threads/{id}` → assert teardown.

### `sandbox-docker-e2e` lane

Runs on the runner's host Docker (the `sandbox-docker` lane already proves Docker is available):

1. Build the smoke app image (Docker variant, with `docker` CLI) via Verdaccio; build the aimock image.
2. `docker run` the app container with `-v /var/run/docker.sock:/var/run/docker.sock`, `DAWN_SMOKE_SANDBOX=docker`, `OPENAI_BASE_URL` → the aimock container (shared docker network). This is the self-host Docker deployment + docker-out-of-docker.
3. Wait for the app to be healthy.
4. Drive the same AP conversation.
5. Assert (below) — the sandbox is a **sibling** container on the host daemon.
6. `DELETE` thread → assert the sibling container + volume are gone. Always clean up `dawn-sbx-*` in a trailing step.

## Success criteria (assertions)

Shared (both lanes):

- The app workload becomes Ready/healthy, deployed the user-facing way (chart / `docker run`), with the sandbox provider wired.
- On the run, a `dawn-sbx-*` **sandbox workload appears** (Pod in K8s, sibling container in Docker).
- The run response contains the exec output proving the command ran **in the sandbox, not the app**: `id -u` = `1000` (hardened non-root default) and `hostname` = the sandbox workload's name, distinct from the app's.
- After `DELETE` thread, the sandbox workload **and** its volume/PVC are gone.

K8s-specific:

- The sandbox Pod carries the hardened SecurityContext (`runAsNonRoot: true`, non-zero `runAsUser`, seccomp `RuntimeDefault`) and a per-thread NetworkPolicy exists.
- The app used its **mounted SA token** (authorized cross-namespace) to create the Pod in `dawn-sandboxes` — not the runner kubeconfig — evidenced by the app pod carrying only its own SA token and the Pod nonetheless being created in the sandbox namespace.

Docker-specific:

- The sibling container has the hardened flags (non-root user, read-only rootfs with writable `/workspace` + tmpfs).

## Testing / determinism

- Fully deterministic: aimock + committed fixture, no `OPENAI_API_KEY`, no network to real providers.
- Both lanes gated by an env flag (e.g. `DAWN_TEST_SMOKE_E2E=1` set in the workflow job) so they don't run in the default `validate` matrix; they run as their own jobs on `push`/PR the same way `sandbox-k8s` does.
- Assertions are shell + `kubectl`/`docker` inspection plus a response-body check, kept in a committed script under `test/k8s-smoke/` so the logic is reviewable and locally runnable, not inlined in YAML.

## File / component structure

- `test/k8s-smoke/app/` — the smoke Dawn app (route, `dawn.config.ts`, `package.json`, fixture).
- `test/k8s-smoke/aimock/` — aimock image context + baked fixture.
- `test/k8s-smoke/k8s/` — the K8s lane driver script + any manifests/values overrides.
- `test/k8s-smoke/docker/` — the Docker lane driver script.
- `test/k8s-smoke/build-image.sh` — shared Verdaccio-based image build (parameterized k8s|docker).
- `.github/workflows/ci.yml` — two new jobs: `sandbox-k8s-e2e`, `sandbox-docker-e2e`.

## Sequencing (for the plan)

1. **Spike:** Verdaccio → `docker build` install → run, prove host-registry networking (fallback: tarballs).
2. Shared foundation: smoke app + aimock image + fixture + shared build script.
3. `sandbox-k8s-e2e` lane + assertions.
4. `sandbox-docker-e2e` lane + assertions.
5. Docs: a short "verifying the full arc" section + wire both jobs into CI.

Each of 3/4 lands independently once 1/2 exist.
