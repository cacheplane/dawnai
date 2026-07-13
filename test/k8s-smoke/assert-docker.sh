#!/bin/sh
# sandbox-docker-e2e assertions (docker-out-of-docker / DooD).
#
# Drives a CONTAINERIZED Dawn app — built the user-facing way (`dawn build`
# node target, run as `node .dawn/build/server.mjs`) — over the Agent Protocol
# and proves it engaged dockerSandbox to spawn a REAL, isolated SIBLING sandbox
# container on the host daemon, then tore it down.
#
# The app container mounts the host Docker socket (-v /var/run/docker.sock), so
# its `docker run` creates a sibling `dawn-sbx-*` container ON THE HOST daemon
# (not nested inside the app container). The app talks to that sibling via
# `docker exec` over the shared socket — not over the network — so the sandbox
# stays on `--network none` (config network mode "deny") and is still driveable.
#
#   sh test/k8s-smoke/assert-docker.sh
#
# Requires (on the host running this script): docker, curl, jq.
#
# What it proves:
#   1. GET  /healthz            → 200 (app is serving)
#   2. POST /threads            → thread_id
#   3. POST /threads/{id}/runs/wait {route:"/smoke#agent", input:{messages:[…]}}
#      → the returned message history contains a runBash ToolMessage whose REAL
#        stdout (`id -u && hostname`, executed inside the sandbox) is `1000`
#        (hardened non-root uid) on line 1 and a hostname that is NOT the app
#        container's on line 2 (it's the sibling sandbox container). The aimock
#        final assistant reply is canned — we assert on the genuine TOOL RESULT.
#   4. Exactly one `dawn-sbx-*` sibling container exists; `docker inspect` shows
#      it is non-root (Config.User == "1000:1000") with a read-only rootfs
#      (HostConfig.ReadonlyRootfs == true).
#   5. Cross-check: the tool-result hostname == the sandbox container's hostname
#      (so the command ran in the sandbox, not the app container).
#   6. DELETE /threads/{id} → the sandbox container AND its named volume
#      (`dawn-sbx-vol-*`) are gone within 60s.
set -eu

# --- Parameters (image tags / names / ports) ---------------------------------
APP_IMAGE="${APP_IMAGE:-dawn-smoke-app:docker}"
AIMOCK_IMAGE="${AIMOCK_IMAGE:-dawn-smoke-aimock:latest}"
NET="${NET:-dawn-smoke-net}"
APP_NAME="${APP_NAME:-dawn-smoke-app}"
AIMOCK_NAME="${AIMOCK_NAME:-dawn-smoke-aimock}"
APP_PORT="${APP_PORT:-8000}"
AIMOCK_PORT="${AIMOCK_PORT:-4010}"
DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
BASE="http://127.0.0.1:${APP_PORT}"
ROUTE='/smoke#agent'
SBX_PREFIX="dawn-sbx-"
SBX_VOL_PREFIX="dawn-sbx-vol-"

# --- Idempotent trap cleanup -------------------------------------------------
# Remove the app + aimock + network + any leftover sandbox siblings/volumes on
# every exit (success or failure), so re-runs start clean.
cleanup() {
  docker rm -f "$APP_NAME" >/dev/null 2>&1 || true
  docker rm -f "$AIMOCK_NAME" >/dev/null 2>&1 || true
  # Any leftover sandbox siblings (name OR dawn.sandbox label) + their volumes.
  for c in $(docker ps -aq --filter "name=${SBX_PREFIX}" 2>/dev/null); do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
  for v in $(docker volume ls -q --filter "name=${SBX_VOL_PREFIX}" 2>/dev/null); do
    docker volume rm "$v" >/dev/null 2>&1 || true
  done
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

fail() {
  echo "ASSERT FAILED: $*" >&2
  echo "----- diagnostics -----" >&2
  docker ps -a >&2 2>&1 || true
  docker volume ls >&2 2>&1 || true
  echo "----- app logs -----" >&2
  docker logs "$APP_NAME" --tail=150 >&2 2>&1 || true
  echo "----- aimock logs -----" >&2
  docker logs "$AIMOCK_NAME" --tail=60 >&2 2>&1 || true
  for c in $(docker ps -aq --filter "name=${SBX_PREFIX}" 2>/dev/null); do
    echo "----- sandbox inspect ($c) -----" >&2
    docker inspect "$c" >&2 2>&1 || true
  done
  exit 1
}

# Extract the runBash tool-result STDOUT from a blob whose messages live at
# `.messages` (runs/wait output) or `.values.messages` (GET /state). Handles the
# LangChain constructor-serialized ToolMessage shape
# ({id:[…,"ToolMessage"], kwargs:{content,name}}) and a plain {type:"tool"} shape.
# runBash wraps its output in a `{stdout,stderr,exitCode}` JSON ENVELOPE, so the
# ToolMessage content is that JSON string — we parse it and return `.stdout`
# (falling back to the raw content for any non-enveloped shape).
extract_tool_content() {
  printf '%s' "$1" | jq -r '
    (.messages // .values.messages // [])
    | map(select(
        ( ((.id? // []) | if type=="array" then (.[-1] // "") else . end) == "ToolMessage" )
        or (.type? == "tool")
      ))
    | map(select(((.kwargs.name? // .name?) == "runBash")))
    | (.[0] // {})
    | (.kwargs.content? // .content? // "")
    | (try fromjson catch .)
    | (if type == "object" then (.stdout // "") else . end)
  '
}

# --- 0. clean slate + host prerequisites -------------------------------------
cleanup
docker info >/dev/null 2>&1 || fail "host docker daemon not reachable (DooD needs a working host docker)"

# The app runs as non-root (uid 1000) but must reach the bind-mounted docker
# socket, which is mode 0660 owned by root:<docker-group>. Grant the app process
# supplementary membership in the socket's OWNING GROUP (probed from inside a
# throwaway container so it's correct on every host): 0 on Docker Desktop, the
# `docker` group's gid on a Linux CI runner. This is the standard secure DooD
# pattern — socket access without running the app as root.
SOCK_GID=$(docker run --rm -v "${DOCKER_SOCK}:/var/run/docker.sock" \
  --entrypoint sh "$APP_IMAGE" -c 'stat -c %g /var/run/docker.sock 2>/dev/null' | tr -dc '0-9')
[ -n "$SOCK_GID" ] || fail "could not probe the docker socket group gid (is ${DOCKER_SOCK} mountable?)"
echo "==> docker socket group gid = ${SOCK_GID}"

# --- 1. network --------------------------------------------------------------
docker network create "$NET" >/dev/null 2>&1 || true
echo "==> network ${NET} ready"

# --- 2. aimock ---------------------------------------------------------------
docker run -d --name "$AIMOCK_NAME" --network "$NET" "$AIMOCK_IMAGE" >/dev/null \
  || fail "failed to start aimock container"
echo "==> aimock ${AIMOCK_NAME} started"

# --- 3. app (DooD: host socket mounted; publishes port ${APP_PORT}) ----------
# DAWN_PERMISSIONS_MODE=bypass: the smoke proves SANDBOX behavior (isolation +
# teardown), not the permission-prompt HITL. Without it, the default interactive
# bash gate interrupts the run at the runBash tool call (never executes it),
# leaving the graph parked at `__interrupt__`. bypass lets runBash execute
# headlessly so we can assert on its real in-sandbox stdout.
docker run -d --name "$APP_NAME" --network "$NET" \
  -v "${DOCKER_SOCK}:/var/run/docker.sock" \
  --group-add "$SOCK_GID" \
  -e DAWN_SMOKE_SANDBOX=docker \
  -e DAWN_PERMISSIONS_MODE=bypass \
  -e "OPENAI_BASE_URL=http://${AIMOCK_NAME}:${AIMOCK_PORT}/v1" \
  -e OPENAI_API_KEY=dummy \
  -p "${APP_PORT}:8000" \
  "$APP_IMAGE" >/dev/null \
  || fail "failed to start app container"
echo "==> app ${APP_NAME} started"

# --- 4. wait for /healthz ----------------------------------------------------
ready=
i=0
while [ "$i" -lt 90 ]; do
  if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then ready=1; break; fi
  # Bail early if the app container died.
  if [ -z "$(docker ps -q --filter "name=${APP_NAME}")" ]; then
    fail "app container exited before /healthz became reachable"
  fi
  i=$((i + 1))
  sleep 1
done
[ -n "$ready" ] || fail "app /healthz never became reachable at ${BASE}"
echo "==> app reachable at ${BASE} (/healthz 200)"

# --- 5. create thread --------------------------------------------------------
THREAD_JSON=$(curl -fsS -X POST "${BASE}/threads" -H 'content-type: application/json' -d '{}') \
  || fail "POST /threads request failed"
TID=$(printf '%s' "$THREAD_JSON" | jq -r '.thread_id // empty')
[ -n "$TID" ] || fail "no thread_id in POST /threads response: $THREAD_JSON"
echo "==> thread_id=$TID"

# --- 6. run (blocks until the graph completes; spawns the sandbox sibling) ----
RUN_JSON=$(curl -fsS --max-time 240 -X POST "${BASE}/threads/${TID}/runs/wait" \
  -H 'content-type: application/json' \
  -d "{\"route\":\"${ROUTE}\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"identify the sandbox\"}]}}") \
  || fail "POST /threads/${TID}/runs/wait request failed"

# --- 7. assert on the runBash TOOL RESULT (real in-sandbox stdout) -----------
CONTENT=$(extract_tool_content "$RUN_JSON")
if [ -z "$CONTENT" ] || [ "$CONTENT" = "null" ]; then
  echo "==> runs/wait carried no runBash tool message; falling back to GET /state" >&2
  STATE_JSON=$(curl -fsS "${BASE}/threads/${TID}/state") || fail "GET /threads/${TID}/state failed"
  CONTENT=$(extract_tool_content "$STATE_JSON")
fi
{ [ -n "$CONTENT" ] && [ "$CONTENT" != "null" ]; } || fail "no runBash tool-result content in run output or state"

UID_LINE=$(printf '%s\n' "$CONTENT" | sed -n '1p' | tr -d '\r')
HOST_LINE=$(printf '%s\n' "$CONTENT" | sed -n '2p' | tr -d '\r')
echo "==> tool result: uid='${UID_LINE}' host='${HOST_LINE}'"

[ "$UID_LINE" = "1000" ] || fail "expected non-root uid 1000 on line 1, got '${UID_LINE}' (content: ${CONTENT})"
[ -n "$HOST_LINE" ] || fail "expected a sandbox hostname on line 2, got empty (content: ${CONTENT})"

APP_HOSTNAME=$(docker inspect -f '{{.Config.Hostname}}' "$APP_NAME" 2>/dev/null | tr -d '\r')
[ "$HOST_LINE" != "$APP_HOSTNAME" ] \
  || fail "tool-result hostname '${HOST_LINE}' == app container hostname — command ran in the APP, not the sandbox"

# --- 8. sandbox sibling container assertions ---------------------------------
SBX_IDS=$(docker ps -q --filter "name=${SBX_PREFIX}")
SBX_COUNT=$(printf '%s\n' "$SBX_IDS" | grep -c . || true)
[ "$SBX_COUNT" = "1" ] || fail "expected exactly one ${SBX_PREFIX}* sibling container, found ${SBX_COUNT}"
SBX_ID=$(printf '%s\n' "$SBX_IDS" | sed -n '1p')

SBX_USER=$(docker inspect -f '{{.Config.User}}' "$SBX_ID" 2>/dev/null | tr -d '\r')
SBX_ROROOTFS=$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$SBX_ID" 2>/dev/null | tr -d '\r')
SBX_HOSTNAME=$(docker inspect -f '{{.Config.Hostname}}' "$SBX_ID" 2>/dev/null | tr -d '\r')
SBX_NAME=$(docker inspect -f '{{.Name}}' "$SBX_ID" 2>/dev/null | sed 's#^/##' | tr -d '\r')
echo "==> sandbox container ${SBX_NAME} user='${SBX_USER}' readonlyRootfs='${SBX_ROROOTFS}' hostname='${SBX_HOSTNAME}'"

case "$SBX_USER" in
  "1000:1000" | "1000") ;;
  *) fail "sandbox container ${SBX_NAME} is not non-root uid 1000 (Config.User='${SBX_USER}')" ;;
esac
[ "$SBX_ROROOTFS" = "true" ] \
  || fail "sandbox container ${SBX_NAME} rootfs is not read-only (HostConfig.ReadonlyRootfs='${SBX_ROROOTFS}')"

# --- 9. cross-check: command ran IN the sandbox sibling ----------------------
[ "$HOST_LINE" = "$SBX_HOSTNAME" ] \
  || fail "tool-result hostname '${HOST_LINE}' != sandbox container hostname '${SBX_HOSTNAME}' — command may not have run in the sandbox"
echo "==> OK: runBash ran in sandbox container ${SBX_NAME} as uid ${UID_LINE} (non-root, read-only rootfs)"

# --- 10. teardown on DELETE --------------------------------------------------
curl -fsS -X DELETE "${BASE}/threads/${TID}" -o /dev/null || fail "DELETE /threads/${TID} failed"

gone=
C_LEFT=1
V_LEFT=1
i=0
while [ "$i" -lt 60 ]; do
  C_LEFT=$(docker ps -aq --filter "name=${SBX_PREFIX}" | grep -c . || true)
  V_LEFT=$(docker volume ls -q --filter "name=${SBX_VOL_PREFIX}" | grep -c . || true)
  if [ "$C_LEFT" = "0" ] && [ "$V_LEFT" = "0" ]; then gone=1; break; fi
  i=$((i + 1))
  sleep 1
done
[ -n "$gone" ] || fail "sandbox container/volume not torn down within 60s of DELETE (containers=${C_LEFT} volumes=${V_LEFT})"

echo "==> OK: sandbox container + volume torn down after DELETE /threads/${TID}"
echo "sandbox-docker-e2e assertions PASSED"
