#!/usr/bin/env node
// Sync each Helm chart's `appVersion` to the current @dawn-ai/cli version and
// advance the chart's own patch version once.
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
// Advancing both fields is required: an unchanged chart version already exists in
// GHCR and causes Helm publication to skip the new application release. The
// appVersion comparison is the idempotency boundary, so rerunning the Version
// Packages command cannot increment the chart version twice. Keep CHARTS in sync
// with the list in scripts/check-docs.mjs.
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { parseSemver } from "./release/semver.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CHARTS = ["charts/dawn-app/Chart.yaml", "charts/dawn-sandbox-infra/Chart.yaml"]

const APP_VERSION_LINE = /^appVersion:\s*["']?([^"'\n]+)["']?$/m
const CHART_VERSION_LINE = /^version:\s*["']?([^"'\n]+)["']?$/m

function incrementPatch(version) {
  const parsed = parseSemver(version)
  const prerelease =
    parsed.prerelease.length === 0 ? "" : `-${parsed.prerelease.map(String).join(".")}`
  const build = parsed.build.length === 0 ? "" : `+${parsed.build.join(".")}`
  return `${parsed.major}.${parsed.minor}.${BigInt(parsed.patch) + 1n}${prerelease}${build}`
}

export function syncChartAppVersions({ cliVersion, charts = CHARTS, root = repoRoot } = {}) {
  parseSemver(cliVersion)

  // Read and validate every chart before writing any of them. This prevents a
  // malformed later chart from leaving an earlier chart partially synchronized.
  const observations = []
  for (const chartYaml of charts) {
    const path = resolve(root, chartYaml)
    const source = readFileSync(path, "utf8")
    const appVersionMatch = source.match(APP_VERSION_LINE)
    if (!appVersionMatch) {
      throw new Error(`${chartYaml} has no appVersion line to sync`)
    }
    const chartVersionMatch = source.match(CHART_VERSION_LINE)
    if (!chartVersionMatch) {
      throw new Error(`${chartYaml} has no chart version line to increment`)
    }
    try {
      parseSemver(chartVersionMatch[1])
    } catch {
      throw new Error(`${chartYaml} has invalid chart version: ${chartVersionMatch[1]}`)
    }
    observations.push({
      appVersion: appVersionMatch[1],
      chart: chartYaml,
      chartVersion: chartVersionMatch[1],
      path,
      source,
    })
  }

  const updated = []
  for (const observation of observations) {
    if (observation.appVersion === cliVersion) continue
    const chartVersionTo = incrementPatch(observation.chartVersion)
    const nextSource = observation.source
      .replace(CHART_VERSION_LINE, `version: ${chartVersionTo}`)
      .replace(APP_VERSION_LINE, `appVersion: "${cliVersion}"`)
    writeFileSync(observation.path, nextSource, "utf8")
    updated.push({
      appVersionFrom: observation.appVersion,
      appVersionTo: cliVersion,
      chart: observation.chart,
      chartVersionFrom: observation.chartVersion,
      chartVersionTo,
    })
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
  for (const update of updated) {
    process.stdout.write(
      `${update.chart}: version ${update.chartVersionFrom} -> ${update.chartVersionTo}; ` +
        `appVersion ${update.appVersionFrom} -> ${update.appVersionTo}\n`,
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
