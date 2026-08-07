# Helm CI Node 24 Refresh

## Goal

Remove the deprecated Node 20 action runtime warning from Dawn's Kubernetes CI
lanes while advancing those lanes to a currently supported Kind, Kubernetes,
and Calico combination.

## Scope

Update the three active `helm/kind-action` references in
`.github/workflows/ci.yml` from v1.12.0 to the immutable v1.14.0 commit
`ef37e7f390d99f746eb8b610417061a60e82a6cc`. Version 1.14.0 uses the Node 24
GitHub Actions runtime and defaults to Kind v0.31.0 with Kubernetes v1.35.0.

Update the two Calico installation URLs in the Kubernetes sandbox lanes from
v3.28.2 to v3.32.1. Calico v3.32 is tested against Kubernetes 1.35, so the CNI
and network-policy implementation remains aligned with the cluster version
created by the upgraded Kind action.

Do not change:

- Helm chart templates, values, schemas, or chart versions unless the upgraded
  verification lanes expose a concrete incompatibility.
- `node:22-slim` sandbox workload fixtures. They are isolated execution images,
  not Dawn application runtimes, and are unrelated to the GitHub Actions
  runtime warning.
- Historical specifications or implementation plans that record the versions
  used when those designs were implemented.

## Verification

`packages/sandbox/test/ci-workflow-pins.test.ts` will read the active CI
workflow and assert that every Kind action reference uses the approved
immutable commit and every Calico manifest URL uses the approved release. The
test must also guard the expected three Kind references and two Calico
references so a new Kubernetes lane cannot silently retain an older version.
The sandbox package's existing Vitest configuration includes this test in
`pnpm test`, which is the required CI `Source Tests` step and part of local
`pnpm ci:validate`.

Run the existing local chart checks from the repository root:

```sh
helm lint --strict charts/dawn-sandbox-infra
sh charts/dawn-sandbox-infra/test/reaper.test.sh
sh charts/dawn-sandbox-infra/test/render.sh
helm template test charts/dawn-sandbox-infra | kubeconform -strict -summary -ignore-missing-schemas
helm template test charts/dawn-sandbox-infra --set podSecurityStandard.enforce=restricted --set reaper.enabled=false | kubeconform -strict -summary -ignore-missing-schemas
helm lint --strict charts/dawn-app
sh charts/dawn-app/test/render.sh
helm template test charts/dawn-app --set image.repository=example/app | kubeconform -strict -summary -ignore-missing-schemas
helm template test charts/dawn-app --set image.repository=example/app --set ingress.enabled=true --set ingress.host=app.example.com --set autoscaling.enabled=true --set podDisruptionBudget.enabled=true | kubeconform -strict -summary -ignore-missing-schemas
```

The pull request CI is the authoritative integration verification because the
Kind-based jobs require the GitHub Linux runner environment. The following CI
jobs must pass:

- `chart-validate`
- `chart-apply-smoke`
- `sandbox-k8s`
- `sandbox-k8s-e2e`

The broader required `validate` job must also remain green.

## Failure Handling

If Kubernetes 1.35 exposes a chart or sandbox incompatibility, fix only the
smallest production behavior needed for compatibility and add a focused test.
Any such user-facing chart change requires an appropriate chart version bump
and release assessment. If the failure is in the test environment rather than
production behavior, keep the fix in CI configuration.

## Release Impact

The planned change only updates CI dependencies, so it does not require a
changeset or Helm chart version bump. A chart change discovered during
verification would expand that release impact and must be called out before
merge.
