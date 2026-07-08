#!/usr/bin/env sh
# Renders the chart and greps assertions. Usage: test/render.sh
set -eu
CHART="$(dirname "$0")/.."
# image.repository is not schema-required (so bare `helm lint` stays green),
# but every real render needs it set — pass it on every tmpl() call below.
tmpl() { helm template test "$CHART" --set image.repository=example/app "$@"; }
assert() { if ! grep -qE "$2"; then echo "FAIL: $1"; exit 1; fi; echo "ok: $1"; }
refute() { if grep -qE "$2"; then echo "FAIL (expected absent): $1"; exit 1; fi; echo "ok: $1"; }

# Deployment: image, probes on /healthz, SA, hardened securityContext
DEPLOY="$(tmpl --show-only templates/deployment.yaml)"
printf '%s\n' "$DEPLOY" | assert "deployment kind" 'kind: Deployment'
printf '%s\n' "$DEPLOY" | assert "image repository+tag" 'image: example/app:0.8.9'
printf '%s\n' "$DEPLOY" | assert "named http port" 'containerPort: 8000'
printf '%s\n' "$DEPLOY" | assert "liveness probe path" 'path: /healthz'
printf '%s\n' "$DEPLOY" | assert "serviceAccountName default" 'serviceAccountName: dawn-orchestrator'
printf '%s\n' "$DEPLOY" | assert "automountServiceAccountToken true" 'automountServiceAccountToken: true'
printf '%s\n' "$DEPLOY" | assert "runAsNonRoot" 'runAsNonRoot: true'
printf '%s\n' "$DEPLOY" | assert "allowPrivilegeEscalation false" 'allowPrivilegeEscalation: false'
printf '%s\n' "$DEPLOY" | assert "drop ALL caps" 'drop:'
printf '%s\n' "$DEPLOY" | assert "drop ALL caps value" '^\s*- ALL$'
printf '%s\n' "$DEPLOY" | assert "seccomp RuntimeDefault" 'type: RuntimeDefault'
printf '%s\n' "$DEPLOY" | assert "readOnlyRootFilesystem default false" 'readOnlyRootFilesystem: false'
printf '%s\n' "$DEPLOY" | assert "tmp emptyDir mount" 'mountPath: /tmp'
printf '%s\n' "$DEPLOY" | assert "static replicas present by default" 'replicas: 1'

# image.repository is required at template render time (not schema-required,
# so bare `helm lint --strict` with no --set still passes)
if helm template test "$CHART" 2>&1 | grep -q "image.repository is required"; then
  echo "ok: image.repository required guard fires without --set"
else
  echo "FAIL: expected a required-guard error when image.repository is unset"; exit 1
fi

# digest pin overrides tag
DIGEST_IMG="$(tmpl --set image.digest=sha256:deadbeef --show-only templates/deployment.yaml | grep 'image:')"
printf '%s\n' "$DIGEST_IMG" | assert "digest pin" 'image: example/app@sha256:deadbeef'

# Custom containerPort/healthPath (build-time-verifiable values)
CUSTOM="$(tmpl --set containerPort=9000 --set healthPath=/healthz/live --show-only templates/deployment.yaml)"
printf '%s\n' "$CUSTOM" | assert "custom containerPort" 'containerPort: 9000'
printf '%s\n' "$CUSTOM" | assert "custom healthPath" 'path: /healthz/live'

# secretName convenience envFrom
SECRET_ENV="$(tmpl --set secretName=my-app-secrets --show-only templates/deployment.yaml)"
printf '%s\n' "$SECRET_ENV" | assert "secretName envFrom" 'name: "my-app-secrets"'

# Custom serviceAccount name
CUSTOM_SA="$(tmpl --set serviceAccount.name=my-custom-sa --show-only templates/deployment.yaml)"
printf '%s\n' "$CUSTOM_SA" | assert "custom SA name" 'serviceAccountName: my-custom-sa'

# replicas absent when autoscaling on
AUTOSCALE_DEPLOY="$(tmpl --set autoscaling.enabled=true --show-only templates/deployment.yaml)"
if printf '%s\n' "$AUTOSCALE_DEPLOY" | grep -qE '^\s*replicas:'; then
  echo "FAIL: replicas should be absent from Deployment when autoscaling.enabled=true"; exit 1
fi
echo "ok: replicas absent from Deployment when autoscaling on"

# Service: ClusterIP default, port -> http
SVC="$(tmpl --show-only templates/service.yaml)"
printf '%s\n' "$SVC" | assert "service kind" 'kind: Service'
printf '%s\n' "$SVC" | assert "service type default ClusterIP" 'type: ClusterIP'
printf '%s\n' "$SVC" | assert "service port default 80" 'port: 80'
printf '%s\n' "$SVC" | assert "service targetPort http" 'targetPort: http'
printf '%s\n' "$SVC" | assert "service port name http" 'name: http'

# Service type override
SVC_LB="$(tmpl --set service.type=LoadBalancer --show-only templates/service.yaml)"
printf '%s\n' "$SVC_LB" | assert "service type override" 'type: LoadBalancer'

# Ingress: absent by default
if tmpl --show-only templates/ingress.yaml 2>/dev/null | grep -q 'kind: Ingress'; then
  echo "FAIL: ingress should be absent when ingress.enabled=false (default)"; exit 1
fi
echo "ok: ingress absent by default"

# Ingress: present + shaped correctly when enabled
ING="$(tmpl --set ingress.enabled=true --set ingress.className=nginx --set ingress.host=app.example.com --set ingress.tls.enabled=true --set ingress.tls.secretName=app-tls --show-only templates/ingress.yaml)"
printf '%s\n' "$ING" | assert "ingress kind" 'kind: Ingress'
printf '%s\n' "$ING" | assert "ingress apiVersion networking.k8s.io/v1" 'apiVersion: networking.k8s.io/v1'
printf '%s\n' "$ING" | assert "ingress className" 'ingressClassName: nginx'
printf '%s\n' "$ING" | assert "ingress host" 'host: "app.example.com"'
printf '%s\n' "$ING" | assert "ingress tls secretName" 'secretName: "app-tls"'
printf '%s\n' "$ING" | assert "ingress pathType default Prefix" 'pathType: Prefix'
printf '%s\n' "$ING" | assert "ingress backend service port name http" 'name: http'

echo "render checks passed"
