#!/usr/bin/env node
// Sync each Helm chart's `appVersion` to the current @dawn-ai/cli version.
//
// Changesets versions the npm packages but knows nothing about the charts, while
// scripts/check-docs.mjs asserts the charts track @dawn-ai/cli. Left manual, that
// mismatch fails the Release workflow's "Validate Release Candidate" step *after*
// the Version PR has already merged — blocking the publish until someone bumps the
// charts by hand (which is exactly what happened for 0.8.13).
//
// Running this immediately after `changeset version` (see the root `version`
// script) means the bump lands inside the Version PR, so the release is green on
// the first attempt.
//
// A chart's own `version` (its chart semver) is deliberately left alone — only
// `appVersion`, which documents the Dawn release the chart targets, tracks the
// package train. Keep CHARTS in sync with the list in scripts/check-docs.mjs.
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CHARTS = ["charts/dawn-app/Chart.yaml", "charts/dawn-sandbox-infra/Chart.yaml"]

const APP_VERSION_LINE = /^appVersion:\s*["']?([^"'\n]+)["']?$/m

export function syncChartAppVersions({ cliVersion, charts = CHARTS, root = repoRoot } = {}) {
  const updated = []
  for (const chartYaml of charts) {
    const path = resolve(root, chartYaml)
    const source = readFileSync(path, "utf8")
    const match = source.match(APP_VERSION_LINE)
    if (!match) {
      throw new Error(`${chartYaml} has no appVersion line to sync`)
    }
    if (match[1] === cliVersion) continue
    writeFileSync(path, source.replace(APP_VERSION_LINE, `appVersion: "${cliVersion}"`), "utf8")
    updated.push({ chart: chartYaml, from: match[1], to: cliVersion })
  }
  return updated
}

function main() {
  const cliVersion = JSON.parse(
    readFileSync(resolve(repoRoot, "packages/cli/package.json"), "utf8"),
  ).version
  const updated = syncChartAppVersions({ cliVersion })
  if (updated.length === 0) {
    process.stdout.write(`Chart appVersion already at ${cliVersion}\n`)
    return
  }
  for (const { chart, from, to } of updated) {
    process.stdout.write(`${chart}: appVersion ${from} -> ${to}\n`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
