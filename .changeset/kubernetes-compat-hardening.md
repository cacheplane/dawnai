---
"@dawn-ai/cli": patch
"@dawn-ai/sandbox": patch
---

Validate the complete Kubernetes runtime permission contract during preflight,
replace existing owned NetworkPolicies with their live resource version, and
export the structured `KubePermission` type. Custom `KubeClient`
implementations must replace positional `canI(namespace, verb, resource)` with
`canI(namespace, permission)`; no compatibility overload is provided.

Serialize filesystem changes observed during the initial `dawn dev` child boot
so startup and restart children cannot race for the same listening port.
