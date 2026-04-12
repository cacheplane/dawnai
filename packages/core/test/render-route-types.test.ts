import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

import { renderRouteTypes } from "../src/typegen/render-route-types"
import type { RouteManifest, RouteSegment } from "../src/types"

const MANIFEST_SNAPSHOT_PATH = fileURLToPath(
  new URL("../../../test/fixtures/contracts/manifest.snap.json", import.meta.url),
)

interface RenderManifestSnapshot {
  readonly routes: Array<{
    readonly pathname: string
    readonly segments: RouteSegment[]
  }>
}

async function loadManifestSnapshot(): Promise<RouteManifest> {
  const snapshot = JSON.parse(
    await readFile(MANIFEST_SNAPSHOT_PATH, "utf8"),
  ) as RenderManifestSnapshot

  return {
    appRoot: "/fixture/type-rendering",
    routes: snapshot.routes.map((route) => ({
      id: route.pathname,
      pathname: route.pathname,
      entryKind: "page",
      entryFile: `/fixture/type-rendering${route.pathname === "/" ? "/index" : route.pathname}.tsx`,
      routeDir: `/fixture/type-rendering${route.pathname}`,
      segments: route.segments,
    })),
  }
}

describe("renderRouteTypes", () => {
  test("renders valid TypeScript for an empty manifest", () => {
    const manifest: RouteManifest = {
      appRoot: "/tmp/example-app",
      routes: [],
    }

    expect(renderRouteTypes(manifest)).toMatchInlineSnapshot(`
      "declare module "dawn:routes" {
        export type DawnRoutePath = never;
      
        export interface DawnRouteParams {}
      }
      "
    `)
  })

  test("renders route types from the synthetic checked-in path-and-param snapshot", async () => {
    const manifest = await loadManifestSnapshot()

    expect(renderRouteTypes(manifest)).toMatchInlineSnapshot(`
      "declare module "dawn:routes" {
        export type DawnRoutePath = "/" | "/[tenant]" | "/docs/[...path]" | "/docs/[[...path]]";
      
        export interface DawnRouteParams {
        "/": {};
        "/[tenant]": { tenant: string };
        "/docs/[...path]": { path: string[] };
        "/docs/[[...path]]": { path?: string[] };
        }
      }
      "
    `)
  })
})
