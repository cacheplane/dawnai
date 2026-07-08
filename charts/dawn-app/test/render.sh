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
# ...and it must NOT emit a bare `env:` (YAML null) when env is unset
if printf '%s\n' "$SECRET_ENV" | grep -qE '^ +env:'; then
  echo "FAIL: bare env: rendered when only secretName is set (YAML null)"; exit 1
fi
echo "ok: no bare env: when only secretName is set"

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

# HPA: absent by default
if tmpl --show-only templates/hpa.yaml 2>/dev/null | grep -q 'kind: HorizontalPodAutoscaler'; then
  echo "FAIL: HPA should be absent when autoscaling.enabled=false (default)"; exit 1
fi
echo "ok: HPA absent by default"

# HPA: present + shaped correctly when enabled; Deployment omits replicas
HPA_OUT="$(tmpl --set autoscaling.enabled=true --set autoscaling.minReplicas=2 --set autoscaling.maxReplicas=10 --set autoscaling.targetCPUUtilizationPercentage=70 --set autoscaling.targetMemoryUtilizationPercentage=80)"
HPA="$(printf '%s\n' "$HPA_OUT" | awk '/^# Source: dawn-app\/templates\/hpa.yaml/,/^---$/')"
printf '%s\n' "$HPA" | assert "hpa kind" 'kind: HorizontalPodAutoscaler'
printf '%s\n' "$HPA" | assert "hpa apiVersion autoscaling/v2" 'apiVersion: autoscaling/v2'
printf '%s\n' "$HPA" | assert "hpa scaleTargetRef Deployment" 'kind: Deployment'
printf '%s\n' "$HPA" | assert "hpa minReplicas" 'minReplicas: 2'
printf '%s\n' "$HPA" | assert "hpa maxReplicas" 'maxReplicas: 10'
printf '%s\n' "$HPA" | assert "hpa target cpu" 'averageUtilization: 70'
printf '%s\n' "$HPA" | assert "hpa target memory" 'averageUtilization: 80'
HPA_DEPLOY="$(printf '%s\n' "$HPA_OUT" | awk '/^# Source: dawn-app\/templates\/deployment.yaml/,/^---$/')"
if printf '%s\n' "$HPA_DEPLOY" | grep -qE '^\s*replicas:'; then
  echo "FAIL: Deployment must omit replicas when HPA (autoscaling.enabled) is on"; exit 1
fi
echo "ok: Deployment omits replicas when HPA is on"

# PDB: absent by default
if tmpl --show-only templates/pdb.yaml 2>/dev/null | grep -q 'kind: PodDisruptionBudget'; then
  echo "FAIL: PDB should be absent when podDisruptionBudget.enabled=false (default)"; exit 1
fi
echo "ok: PDB absent by default"

# PDB: present + shaped correctly when enabled
PDB="$(tmpl --set podDisruptionBudget.enabled=true --set podDisruptionBudget.minAvailable=2 --show-only templates/pdb.yaml)"
printf '%s\n' "$PDB" | assert "pdb kind" 'kind: PodDisruptionBudget'
printf '%s\n' "$PDB" | assert "pdb apiVersion policy/v1" 'apiVersion: policy/v1'
printf '%s\n' "$PDB" | assert "pdb minAvailable" 'minAvailable: 2'
printf '%s\n' "$PDB" | assert "pdb selector matches app labels" 'app.kubernetes.io/name: dawn-app'

# ServiceAccount: absent by default (serviceAccount.create=false)
if tmpl --show-only templates/serviceaccount.yaml 2>/dev/null | grep -q 'kind: ServiceAccount'; then
  echo "FAIL: ServiceAccount should be absent when serviceAccount.create=false (default)"; exit 1
fi
echo "ok: ServiceAccount absent by default"

# ServiceAccount: present + named correctly when created
SA="$(tmpl --set serviceAccount.create=true --set serviceAccount.name=dawn-app-smoke --show-only templates/serviceaccount.yaml)"
printf '%s\n' "$SA" | assert "serviceaccount kind" 'kind: ServiceAccount'
printf '%s\n' "$SA" | assert "serviceaccount name" 'name: dawn-app-smoke'

echo "render checks passed"
