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
  for (const [relativePath, fixture] of Object.entries(charts)) {
    const { appVersion, chartVersion = "0.1.0" } =
      typeof fixture === "string" ? { appVersion: fixture } : fixture
    const path = resolve(root, relativePath)
    mkdirSync(resolve(path, ".."), { recursive: true })
    writeFileSync(
      path,
      `apiVersion: v2\nname: example\nversion: ${chartVersion}\nappVersion: "${appVersion}"\n`,
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

    assert.deepEqual(updated, [
      {
        appVersionFrom: "0.8.12",
        appVersionTo: "0.8.13",
        chart: "charts/a/Chart.yaml",
        chartVersionFrom: "0.1.0",
        chartVersionTo: "0.1.1",
      },
    ])
    const source = readFileSync(resolve(root, "charts/a/Chart.yaml"), "utf8")
    assert.match(source, /^appVersion: "0\.8\.13"$/m)
    assert.match(source, /^version: 0\.1\.1$/m)
  })

  it("is a byte-for-byte no-op when every chart already matches", () => {
    const charts = ["charts/a/Chart.yaml"]
    const root = fixtureRoot({ "charts/a/Chart.yaml": "0.8.13" })
    const path = resolve(root, "charts/a/Chart.yaml")
    const before = readFileSync(path, "utf8")

    assert.deepEqual(syncChartAppVersions({ charts, cliVersion: "0.8.13", root }), [])
    assert.equal(readFileSync(path, "utf8"), before)
  })

  it("increments every stale chart independently", () => {
    const charts = ["charts/a/Chart.yaml", "charts/b/Chart.yaml"]
    const root = fixtureRoot({
      "charts/a/Chart.yaml": { appVersion: "0.8.12", chartVersion: "0.1.0" },
      "charts/b/Chart.yaml": { appVersion: "0.8.11", chartVersion: "1.7.29" },
    })

    const updated = syncChartAppVersions({ charts, cliVersion: "0.8.13", root })

    assert.deepEqual(
      updated.map((entry) => entry.chart),
      charts,
    )
    assert.match(readFileSync(resolve(root, charts[0]), "utf8"), /^version: 0\.1\.1$/m)
    assert.match(readFileSync(resolve(root, charts[1]), "utf8"), /^version: 1\.7\.30$/m)
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

  it("rejects a malformed chart version without partially updating another chart", () => {
    const charts = ["charts/a/Chart.yaml", "charts/b/Chart.yaml"]
    const root = fixtureRoot({
      "charts/a/Chart.yaml": { appVersion: "0.8.12", chartVersion: "0.1.0" },
      "charts/b/Chart.yaml": { appVersion: "0.8.12", chartVersion: "not-semver" },
    })
    const firstPath = resolve(root, charts[0])
    const before = readFileSync(firstPath, "utf8")

    assert.throws(
      () => syncChartAppVersions({ charts, cliVersion: "0.8.13", root }),
      /charts\/b\/Chart\.yaml has invalid chart version: not-semver/,
    )
    assert.equal(readFileSync(firstPath, "utf8"), before)
  })

  it("increments the patch field of a valid prerelease chart version", () => {
    const charts = ["charts/a/Chart.yaml"]
    const root = fixtureRoot({
      "charts/a/Chart.yaml": { appVersion: "0.8.12", chartVersion: "2.4.6-rc.1+build.9" },
    })

    syncChartAppVersions({ charts, cliVersion: "0.8.13", root })

    assert.match(
      readFileSync(resolve(root, charts[0]), "utf8"),
      /^version: 2\.4\.7-rc\.1\+build\.9$/m,
    )
  })

  it("rejects a non-SemVer CLI version", () => {
    const charts = ["charts/a/Chart.yaml"]
    const root = fixtureRoot({ "charts/a/Chart.yaml": "0.8.12" })

    assert.throws(
      () => syncChartAppVersions({ charts, cliVersion: "latest", root }),
      /Invalid exact SemVer: latest/,
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
