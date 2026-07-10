#!/bin/sh
# sandbox-k8s-e2e assertions.
#
# Drives the deployed smoke app over the Agent Protocol and proves it engaged
# kubernetesSandbox to spawn a REAL, isolated sandbox Pod — then tore it down.
#
# Run after `helm install dawn-app --wait` (the app Pod is Ready). Reaches the
# app via `kubectl port-forward`. Requires: kubectl, curl, jq.
#
#   sh test/k8s-smoke/assert-k8s.sh
#
# What it proves:
#   1. POST /threads            → thread_id
#   2. POST /threads/{id}/runs/wait {route:"/smoke#agent", input:{messages:[…]}}
#      → the returned message history contains a runBash ToolMessage whose
#        REAL stdout (`id -u && hostname`, executed inside the sandbox) is
#        `1000` (hardened non-root uid) on line 1 and a `dawn-sbx-*` hostname
#        on line 2. (The aimock final assistant reply is canned — we assert on
#        the TOOL RESULT, which is genuine in-sandbox output.)
#   3. Exactly one `dawn-sbx-*` Pod exists in dawn-sandboxes, non-root
#      (runAsNonRoot==true, runAsUser!=0), with a per-thread `dawn-sbx-net-*`
#      NetworkPolicy.
#   4. Cross-check: the tool-result hostname == the sandbox Pod name (so the
#      command ran in the sandbox Pod, not the app Pod).
#   5. DELETE /threads/{id} → the Pod AND its PVC are gone within 60s.
set -eu

NS_APP=dawn-app
NS_SBX=dawn-sandboxes
LOCAL_PORT=8000
BASE="http://127.0.0.1:${LOCAL_PORT}"
ROUTE='/smoke#agent'

fail() {
  echo "ASSERT FAILED: $*" >&2
  echo "----- diagnostics -----" >&2
  kubectl get pods -A -o wide >&2 2>&1 || true
  kubectl -n "$NS_SBX" get pods,pvc,networkpolicy -o wide >&2 2>&1 || true
  kubectl -n "$NS_APP" describe deploy/dawn-app >&2 2>&1 || true
  kubectl -n "$NS_APP" logs deploy/dawn-app --tail=120 >&2 2>&1 || true
  exit 1
}

# Extract the runBash tool-result content from a blob whose messages live at
# `.messages` (runs/wait output) or `.values.messages` (GET /state). Handles the
# LangChain constructor-serialized ToolMessage shape
# ({id:[…,"ToolMessage"], kwargs:{content,name}}) and a plain {type:"tool"} shape.
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
  '
}

# --- port-forward to the app Service ----------------------------------------
kubectl -n "$NS_APP" port-forward svc/dawn-app "${LOCAL_PORT}:8000" >/tmp/dawn-app-pf.log 2>&1 &
PF_PID=$!
cleanup() { kill "$PF_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

ready=
i=0
while [ "$i" -lt 60 ]; do
  if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then ready=1; break; fi
  i=$((i + 1))
  sleep 1
done
[ -n "$ready" ] || fail "app /healthz never became reachable via port-forward (see /tmp/dawn-app-pf.log)"
echo "==> app reachable at ${BASE}"

# --- 1. create thread --------------------------------------------------------
THREAD_JSON=$(curl -fsS -X POST "${BASE}/threads" -H 'content-type: application/json' -d '{}') \
  || fail "POST /threads request failed"
TID=$(printf '%s' "$THREAD_JSON" | jq -r '.thread_id // empty')
[ -n "$TID" ] || fail "no thread_id in POST /threads response: $THREAD_JSON"
echo "==> thread_id=$TID"

# --- 2. run (blocks until the graph completes; spawns the sandbox Pod) --------
RUN_JSON=$(curl -fsS --max-time 240 -X POST "${BASE}/threads/${TID}/runs/wait" \
  -H 'content-type: application/json' \
  -d "{\"route\":\"${ROUTE}\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"identify the sandbox\"}]}}") \
  || fail "POST /threads/${TID}/runs/wait request failed"

# --- 3. assert on the runBash TOOL RESULT (real in-sandbox stdout) -----------
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
case "$HOST_LINE" in
  dawn-sbx-*) ;;
  *) fail "expected a dawn-sbx-* sandbox hostname on line 2, got '${HOST_LINE}'" ;;
esac

# --- 4. sandbox Pod / NetworkPolicy assertions -------------------------------
PODS_JSON=$(kubectl -n "$NS_SBX" get pods -o json)
SBX_COUNT=$(printf '%s' "$PODS_JSON" | jq '[.items[] | select(.metadata.name | startswith("dawn-sbx-"))] | length')
[ "$SBX_COUNT" = "1" ] || fail "expected exactly one dawn-sbx-* Pod in ${NS_SBX}, found ${SBX_COUNT}"

SBX_NAME=$(printf '%s' "$PODS_JSON" | jq -r '.items[] | select(.metadata.name | startswith("dawn-sbx-")) | .metadata.name')
RUN_AS_NONROOT=$(printf '%s' "$PODS_JSON" | jq -r --arg n "$SBX_NAME" '.items[] | select(.metadata.name==$n) | .spec.securityContext.runAsNonRoot')
RUN_AS_USER=$(printf '%s' "$PODS_JSON" | jq -r --arg n "$SBX_NAME" '.items[] | select(.metadata.name==$n) | .spec.securityContext.runAsUser')
[ "$RUN_AS_NONROOT" = "true" ] || fail "sandbox Pod ${SBX_NAME} runAsNonRoot != true (got '${RUN_AS_NONROOT}')"
{ [ -n "$RUN_AS_USER" ] && [ "$RUN_AS_USER" != "null" ] && [ "$RUN_AS_USER" != "0" ]; } \
  || fail "sandbox Pod ${SBX_NAME} runAsUser is root/empty (got '${RUN_AS_USER}')"

NP_COUNT=$(kubectl -n "$NS_SBX" get networkpolicy -o json \
  | jq '[.items[] | select(.metadata.name | startswith("dawn-sbx-net-"))] | length')
[ "$NP_COUNT" -ge 1 ] || fail "expected a per-thread dawn-sbx-net-* NetworkPolicy, found ${NP_COUNT}"

# --- 5. cross-check: command ran IN the sandbox Pod --------------------------
[ "$HOST_LINE" = "$SBX_NAME" ] \
  || fail "tool-result hostname '${HOST_LINE}' != sandbox Pod name '${SBX_NAME}' — command may not have run in the sandbox"
echo "==> OK: runBash ran in sandbox Pod ${SBX_NAME} as uid ${UID_LINE} (non-root, netpol present)"

# --- 6. teardown on DELETE ---------------------------------------------------
curl -fsS -X DELETE "${BASE}/threads/${TID}" -o /dev/null || fail "DELETE /threads/${TID} failed"

gone=
POD_LEFT=1
PVC_LEFT=1
i=0
while [ "$i" -lt 60 ]; do
  POD_LEFT=$(kubectl -n "$NS_SBX" get pods -o json | jq '[.items[] | select(.metadata.name | startswith("dawn-sbx-"))] | length')
  PVC_LEFT=$(kubectl -n "$NS_SBX" get pvc -o json | jq '[.items[] | select(.metadata.name | startswith("dawn-sbx-vol-"))] | length')
  if [ "$POD_LEFT" = "0" ] && [ "$PVC_LEFT" = "0" ]; then gone=1; break; fi
  i=$((i + 1))
  sleep 1
done
[ -n "$gone" ] || fail "sandbox Pod/PVC not torn down within 60s of DELETE (pods=${POD_LEFT} pvc=${PVC_LEFT})"

echo "==> OK: sandbox Pod + PVC torn down after DELETE /threads/${TID}"
echo "sandbox-k8s-e2e assertions PASSED"
