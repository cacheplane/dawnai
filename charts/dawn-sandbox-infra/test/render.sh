#!/usr/bin/env sh
# Renders the chart and greps assertions. Usage: test/render.sh
set -eu
CHART="$(dirname "$0")/.."
tmpl() { helm template test "$CHART" "$@"; }
assert() { if ! grep -qE "$2"; then echo "FAIL: $1"; exit 1; fi; echo "ok: $1"; }
refute() { if grep -qE "$2"; then echo "FAIL (expected absent): $1"; exit 1; fi; echo "ok: $1"; }

# Namespace + PSS (default baseline enforce, restricted warn/audit)
tmpl --show-only templates/namespace.yaml | assert "ns name" 'name: dawn-sandboxes'
tmpl --show-only templates/namespace.yaml | assert "pss enforce baseline" 'pod-security.kubernetes.io/enforce: baseline'
tmpl --show-only templates/namespace.yaml | assert "pss warn restricted" 'pod-security.kubernetes.io/warn: restricted'
# Override: enforce restricted
tmpl --show-only templates/namespace.yaml --set podSecurityStandard.enforce=restricted | assert "pss enforce override" 'pod-security.kubernetes.io/enforce: restricted'

# Orchestrator RBAC: ServiceAccount, Role (exact rule surface), RoleBinding
RBAC="$(tmpl --show-only templates/rbac-orchestrator.yaml)"
printf '%s\n' "$RBAC" | assert "orchestrator SA" 'kind: ServiceAccount'
printf '%s\n' "$RBAC" | assert "orchestrator SA name" 'name: dawn-orchestrator'
printf '%s\n' "$RBAC" | assert "orchestrator Role" 'kind: Role'
printf '%s\n' "$RBAC" | assert "orchestrator RoleBinding" 'kind: RoleBinding'
printf '%s\n' "$RBAC" | assert "pods+pvc resources" '\["pods", "persistentvolumeclaims"\]'
printf '%s\n' "$RBAC" | assert "pods/pvc verbs" '\["create", "get", "delete"\]'
printf '%s\n' "$RBAC" | assert "pods/exec resource" '\["pods/exec"\]'
printf '%s\n' "$RBAC" | assert "networkpolicies resource" '\["networkpolicies"\]'
printf '%s\n' "$RBAC" | assert "networkpolicies verbs" '\["create", "get", "list", "update", "delete"\]'

# Default-deny egress NetworkPolicy backstop
NETPOL="$(tmpl --show-only templates/networkpolicy-default-deny.yaml)"
printf '%s\n' "$NETPOL" | assert "netpol kind" 'kind: NetworkPolicy'
printf '%s\n' "$NETPOL" | assert "netpol podSelector all" 'podSelector: \{\}'
printf '%s\n' "$NETPOL" | assert "netpol policyTypes egress" 'policyTypes: \[Egress\]'
printf '%s\n' "$NETPOL" | assert "netpol dns to kube-system" 'kubernetes.io/metadata.name: kube-system'
printf '%s\n' "$NETPOL" | assert "netpol dns port 53" 'port: 53'
# Override: disable the backstop entirely
if tmpl --show-only templates/networkpolicy-default-deny.yaml --set networkPolicy.defaultDenyEgress=false 2>/dev/null | grep -q 'kind: NetworkPolicy'; then
  echo "FAIL: netpol should be absent when defaultDenyEgress=false"; exit 1
fi
echo "ok: netpol absent when disabled"

# ResourceQuota
RQ="$(tmpl --show-only templates/resourcequota.yaml)"
printf '%s\n' "$RQ" | assert "resourcequota kind" 'kind: ResourceQuota'
printf '%s\n' "$RQ" | assert "resourcequota requests.cpu" 'requests.cpu: "8"'
printf '%s\n' "$RQ" | assert "resourcequota requests.memory" 'requests.memory: "16Gi"'
printf '%s\n' "$RQ" | assert "resourcequota limits.cpu" 'limits.cpu: "16"'
printf '%s\n' "$RQ" | assert "resourcequota pvc count" 'persistentvolumeclaims: "50"'
# Override: disable the quota entirely
if tmpl --show-only templates/resourcequota.yaml --set resourceQuota.enabled=false 2>/dev/null | grep -q 'kind: ResourceQuota'; then
  echo "FAIL: resourcequota should be absent when resourceQuota.enabled=false"; exit 1
fi
echo "ok: resourcequota absent when disabled"

# LimitRange (carries the delegated pids cap)
LR="$(tmpl --show-only templates/limitrange.yaml)"
printf '%s\n' "$LR" | assert "limitrange kind" 'kind: LimitRange'
printf '%s\n' "$LR" | assert "limitrange type Container" 'type: Container'
printf '%s\n' "$LR" | assert "limitrange default pids" 'pids: "512"'
printf '%s\n' "$LR" | assert "limitrange default cpu" 'cpu: "1"'
printf '%s\n' "$LR" | assert "limitrange default memory" 'memory: "512Mi"'
printf '%s\n' "$LR" | assert "limitrange defaultRequest cpu" 'cpu: "100m"'

# Reaper RBAC
RRBAC="$(tmpl --show-only templates/reaper-rbac.yaml)"
printf '%s\n' "$RRBAC" | assert "reaper SA" 'name: dawn-reaper'
printf '%s\n' "$RRBAC" | assert "reaper Role pvc verbs" '\["get", "list", "patch", "delete"\]'
printf '%s\n' "$RRBAC" | assert "reaper Role pods verbs" '\["list"\]'

# Reaper CronJob: hardened securityContext + correct SA + TTL env
CJ="$(tmpl --show-only templates/reaper-cronjob.yaml)"
printf '%s\n' "$CJ" | assert "cronjob kind" 'kind: CronJob'
printf '%s\n' "$CJ" | assert "cronjob schedule" 'schedule: "17 \* \* \* \*"'
printf '%s\n' "$CJ" | assert "cronjob SA" 'serviceAccountName: dawn-reaper'
printf '%s\n' "$CJ" | assert "cronjob ttl env (168h -> 604800s)" 'value: "604800"'
printf '%s\n' "$CJ" | assert "cronjob ns env" 'value: "dawn-sandboxes"'
printf '%s\n' "$CJ" | assert "cronjob runAsNonRoot" 'runAsNonRoot: true'
printf '%s\n' "$CJ" | assert "cronjob runAsUser 65532" 'runAsUser: 65532'
printf '%s\n' "$CJ" | assert "cronjob readOnlyRootFilesystem" 'readOnlyRootFilesystem: true'
printf '%s\n' "$CJ" | assert "cronjob allowPrivilegeEscalation false" 'allowPrivilegeEscalation: false'
printf '%s\n' "$CJ" | assert "cronjob drop ALL caps" 'drop: \["ALL"\]'
printf '%s\n' "$CJ" | assert "cronjob seccomp RuntimeDefault" 'type: RuntimeDefault'
printf '%s\n' "$CJ" | assert "cronjob configmap script" 'name: dawn-reaper-script'
# Override: disable the reaper entirely (CronJob + RBAC + ConfigMap gone)
if tmpl --show-only templates/reaper-cronjob.yaml --set reaper.enabled=false 2>/dev/null | grep -q 'kind: CronJob'; then
  echo "FAIL: cronjob should be absent when reaper.enabled=false"; exit 1
fi
echo "ok: cronjob absent when disabled"
if tmpl --show-only templates/reaper-rbac.yaml --set reaper.enabled=false 2>/dev/null | grep -q 'kind: Role'; then
  echo "FAIL: reaper RBAC should be absent when reaper.enabled=false"; exit 1
fi
echo "ok: reaper RBAC absent when disabled"

echo "render checks passed"
