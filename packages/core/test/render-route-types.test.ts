import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

import { renderRouteTypes } from "../src/typegen/render-route-types"
import type { RouteManifest } from "../src/types"

const MANIFEST_SNAPSHOT_PATH = fileURLToPath(
  new URL("../../../test/fixtures/contracts/manifest.snap.json", import.meta.url),
)

async function loadManifestSnapshot(): Promise<RouteManifest> {
  return JSON.parse(await readFile(MANIFEST_SNAPSHOT_PATH, "utf8")) as RouteManifest
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

  test("renders route types from the checked-in manifest snapshot", async () => {
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
