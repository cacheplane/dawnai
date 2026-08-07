#!/usr/bin/env sh
set -eu

NS="${DAWN_TEST_K8S_NS:-dawn-sandboxes}"
JOB="dawn-reaper-smoke"
STALE_PVC="dawn-reaper-smoke-stale"
NEW_PVC="dawn-reaper-smoke-new"
REFERENCED_PVC="dawn-reaper-smoke-referenced"
REFERENCE_POD="dawn-reaper-smoke-reference"
DIAGNOSTICS_PRINTED=0

is_positive_integer() {
  case "$1" in
    "" | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -gt 0 ]
}

print_diagnostics() {
  DIAGNOSTICS_PRINTED=1
  kubectl -n "$NS" describe job "$JOB" || true
  kubectl -n "$NS" describe pods -l "job-name=$JOB" || true
  kubectl -n "$NS" logs "job/$JOB" --all-containers=true || true
}

cleanup() {
  status=$1
  trap - 0
  if [ "$status" -ne 0 ] && [ "$DIAGNOSTICS_PRINTED" -eq 0 ]; then
    print_diagnostics
  fi
  kubectl -n "$NS" delete job "$JOB" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  kubectl -n "$NS" delete pod "$REFERENCE_POD" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  kubectl -n "$NS" delete pvc "$STALE_PVC" "$NEW_PVC" "$REFERENCED_PVC" \
    --ignore-not-found --wait=true >/dev/null 2>&1 || true
  exit "$status"
}
trap 'cleanup "$?"' 0

# Remove fixtures left by an interrupted or repeated run before creating them.
kubectl -n "$NS" delete job "$JOB" --ignore-not-found --wait=true
kubectl -n "$NS" delete pod "$REFERENCE_POD" --ignore-not-found --wait=true
kubectl -n "$NS" delete pvc "$STALE_PVC" "$NEW_PVC" "$REFERENCED_PVC" \
  --ignore-not-found --wait=true

TTL_SECONDS=604800
OLD_MARKER=$(( $(date -u +%s) - TTL_SECONDS - 1 ))
if ! is_positive_integer "$OLD_MARKER"; then
  printf '%s\n' "invalid stale PVC marker: $OLD_MARKER" >&2
  exit 1
fi

kubectl -n "$NS" apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $STALE_PVC
  labels:
    app.kubernetes.io/managed-by: dawn
  annotations:
    dawn.sh/unbound-since: "$OLD_MARKER"
spec:
  storageClassName: ""
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Mi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $NEW_PVC
  labels:
    app.kubernetes.io/managed-by: dawn
spec:
  storageClassName: ""
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Mi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $REFERENCED_PVC
  labels:
    app.kubernetes.io/managed-by: dawn
  annotations:
    dawn.sh/unbound-since: "$OLD_MARKER"
spec:
  storageClassName: ""
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Mi
EOF

kubectl -n "$NS" apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $REFERENCE_POD
  labels:
    app.kubernetes.io/name: $REFERENCE_POD
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: reference
      image: registry.k8s.io/pause:3.10
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
        readOnlyRootFilesystem: true
        runAsNonRoot: true
      volumeMounts:
        - name: referenced
          mountPath: /data
  volumes:
    - name: referenced
      persistentVolumeClaim:
        claimName: $REFERENCED_PVC
EOF

kubectl -n "$NS" create job --from=cronjob/dawn-reaper "$JOB"
if ! kubectl -n "$NS" wait --for=condition=Complete "job/$JOB" --timeout=120s; then
  print_diagnostics
  exit 1
fi

if kubectl -n "$NS" get pvc "$STALE_PVC" >/dev/null 2>&1; then
  printf '%s\n' "stale PVC was not reaped: $STALE_PVC" >&2
  exit 1
fi

NEW_MARKER=$(kubectl -n "$NS" get pvc "$NEW_PVC" -o jsonpath='{.metadata.annotations.dawn\.sh/unbound-since}')
if ! is_positive_integer "$NEW_MARKER"; then
  printf '%s\n' "new PVC marker is not a positive integer: $NEW_MARKER" >&2
  exit 1
fi

kubectl -n "$NS" get pvc "$REFERENCED_PVC" >/dev/null
REFERENCED_MARKER=$(kubectl -n "$NS" get pvc "$REFERENCED_PVC" -o jsonpath='{.metadata.annotations.dawn\.sh/unbound-since}')
if [ -n "$REFERENCED_MARKER" ]; then
  printf '%s\n' "referenced PVC marker was not cleared: $REFERENCED_MARKER" >&2
  exit 1
fi

kubectl -n "$NS" logs "job/$JOB" --all-containers=true
printf '%s\n' "PVC reaper smoke passed"
