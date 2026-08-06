---
"@dawn-ai/devkit": patch
"create-dawn-ai-app": patch
---

Scaffold templates now pin `vitest` with a caret (`^4.1.10`) instead of an exact
stale version. The old exact `4.1.4` pin made fresh `npm install`s crash with
npm's arborist `edgesOut` bug after an upstream peer-landscape change (vitest
≤4.1.9 became uninstallable under npm's strict peer resolution) — a failure
mode a caret range rides out automatically. Existing broken scaffolds can fix
themselves with `npm install --legacy-peer-deps` or by bumping `vitest` to
`^4.1.10`.
