---
"@dawn-ai/workspace": patch
"@dawn-ai/sandbox": patch
"@dawn-ai/cli": patch
---

Harden the Docker sandbox by default: drop all Linux capabilities, no-new-privileges,
a PID limit (512), a read-only root filesystem (workspace + /tmp stay writable), and
run-as-non-root (uid/gid 1000:1000 via a create-time root chown-init) — expressed as a
provider-agnostic `SandboxPolicy.security` intent. `resources.timeoutMs` is now enforced
per command (in-container `timeout`, exit 124). All hardening is on by default with
per-flag opt-outs (`readOnlyRootFilesystem`, `runAsNonRoot`, etc.). Behavior changes only
for apps already using `sandbox`; runtime system-directory writes / global installs now
fail under the defaults — bake system deps into your image or opt out.
