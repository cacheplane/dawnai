import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { after, describe, it } from "node:test"

import { syncChartAppVersions } from "./sync-chart-appversion.mjs"

const tempRoots = []

function fixtureRoot(charts) {
  const root = mkdtempSync(join(tmpdir(), "dawn-chart-sync-"))
  tempRoots.push(root)
  for (const [relativePath, appVersion] of Object.entries(charts)) {
    const path = resolve(root, relativePath)
    mkdirSync(resolve(path, ".."), { recursive: true })
    writeFileSync(
      path,
      `apiVersion: v2\nname: example\nversion: 0.1.0\nappVersion: "${appVersion}"\n`,
      "utf8",
    )
  }
  return root
}

after(() => {
  for (const root of tempRoots) rmSync(root, { force: true, recursive: true })
})

describe("syncChartAppVersions", () => {
  it("rewrites a stale appVersion and reports the change", () => {
    const charts = ["charts/a/Chart.yaml"]
    const root = fixtureRoot({ "charts/a/Chart.yaml": "0.8.12" })

    const updated = syncChartAppVersions({ charts, cliVersion: "0.8.13", root })

    assert.deepEqual(updated, [{ chart: "charts/a/Chart.yaml", from: "0.8.12", to: "0.8.13" }])
    assert.match(
      readFileSync(resolve(root, "charts/a/Chart.yaml"), "utf8"),
      /^appVersion: "0\.8\.13"$/m,
    )
  })

  it("leaves the chart's own version untouched", () => {
    const charts = ["charts/a/Chart.yaml"]
    const root = fixtureRoot({ "charts/a/Chart.yaml": "0.8.12" })

    syncChartAppVersions({ charts, cliVersion: "0.8.13", root })

    assert.match(readFileSync(resolve(root, "charts/a/Chart.yaml"), "utf8"), /^version: 0\.1\.0$/m)
  })

  it("is a no-op when every chart already matches", () => {
    const charts = ["charts/a/Chart.yaml"]
    const root = fixtureRoot({ "charts/a/Chart.yaml": "0.8.13" })

    assert.deepEqual(syncChartAppVersions({ charts, cliVersion: "0.8.13", root }), [])
  })

  it("syncs every configured chart", () => {
    const charts = ["charts/a/Chart.yaml", "charts/b/Chart.yaml"]
    const root = fixtureRoot({
      "charts/a/Chart.yaml": "0.8.12",
      "charts/b/Chart.yaml": "0.8.11",
    })

    const updated = syncChartAppVersions({ charts, cliVersion: "0.8.13", root })

    assert.deepEqual(
      updated.map((entry) => entry.chart),
      charts,
    )
  })

  it("throws when a chart has no appVersion to sync", () => {
    const root = mkdtempSync(join(tmpdir(), "dawn-chart-sync-"))
    tempRoots.push(root)
    mkdirSync(resolve(root, "charts/a"), { recursive: true })
    writeFileSync(resolve(root, "charts/a/Chart.yaml"), "apiVersion: v2\nname: example\n", "utf8")

    assert.throws(
      () => syncChartAppVersions({ charts: ["charts/a/Chart.yaml"], cliVersion: "0.8.13", root }),
      /no appVersion line to sync/,
    )
  })

  it("keeps the real charts in sync with @dawn-ai/cli", () => {
    // Guards the same invariant scripts/check-docs.mjs asserts: running the sync
    // against the live repo must be a no-op on a released tree.
    const cliVersion = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../packages/cli/package.json"), "utf8"),
    ).version
    assert.deepEqual(syncChartAppVersions({ cliVersion }), [])
  })
})
