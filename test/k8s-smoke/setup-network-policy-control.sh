#!/usr/bin/env sh
set -eu

NS="${DAWN_TEST_K8S_NS:-dawn-sandboxes}"
SERVER="dawn-egress-control"
SERVICE="dawn-egress-control"
CLIENT="dawn-egress-control-client"
IMAGE="node:22-slim"

cleanup_client() {
  kubectl -n "$NS" delete pod "$CLIENT" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup_client 0

kubectl -n "$NS" delete pod "$CLIENT" "$SERVER" --ignore-not-found --wait=true
kubectl -n "$NS" delete service "$SERVICE" --ignore-not-found --wait=true

kubectl -n "$NS" apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $SERVER
  labels:
    app: $SERVER
spec:
  restartPolicy: Never
  containers:
    - name: server
      image: $IMAGE
      command: ["node", "-e"]
      args:
        - |
          require("node:http")
            .createServer((_request, response) => {
              response.writeHead(200, { "content-type": "text/plain" });
              response.end("OK");
            })
            .listen(8080, "0.0.0.0");
      readinessProbe:
        httpGet:
          path: /
          port: 8080
        periodSeconds: 1
---
apiVersion: v1
kind: Service
metadata:
  name: $SERVICE
spec:
  selector:
    app: $SERVER
  ports:
    - port: 8080
      targetPort: 8080
EOF

kubectl -n "$NS" wait --for=condition=Ready "pod/$SERVER" --timeout=120s

kubectl -n "$NS" apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $CLIENT
spec:
  restartPolicy: Never
  containers:
    - name: client
      image: $IMAGE
      command: ["sleep", "infinity"]
EOF

kubectl -n "$NS" wait --for=condition=Ready "pod/$CLIENT" --timeout=120s
kubectl -n "$NS" exec "$CLIENT" -- node -e '
  fetch("http://dawn-egress-control:8080/", { signal: AbortSignal.timeout(5000) })
    .then((response) => {
      if (response.status !== 200) {
        console.error(`expected HTTP 200, received ${response.status}`);
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
'

printf '%s\n' "http://$SERVICE:8080/"
