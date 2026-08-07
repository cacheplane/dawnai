import { isDawnAgent } from "@dawn-ai/sdk"
import type { CapabilityMarkerContext } from "./capabilities/types.js"

/**
 * The Node implementation of the capability-marker route-description loader
 * (`CapabilityMarkerContext.loadRouteDescription`). Lives in core behind the
 * explicitly node-only "@dawn-ai/core/node" subpath (NOT the "." barrel) so
 * `node:url` stays out of the default import graph — the subagents marker used
 * to `await import("node:url")` inline, and a dynamic import with a literal
 * specifier is still a bundler edge. Edge entries never import this subpath.
 *
 * Best-effort by contract: any failure (missing file, transpile error, entry
 * that is not a DawnAgent) resolves to `undefined`, and the marker then uses
 * its default description text. Composing an agent must never fail over a
 * description.
 */
export const nodeLoadRouteDescription: NonNullable<
  CapabilityMarkerContext["loadRouteDescription"]
> = async (route) => {
  try {
    const { pathToFileURL } = await import("node:url")
    const mod = (await import(pathToFileURL(route.entryFile).href)) as { default?: unknown }
    const candidate = mod.default
    return isDawnAgent(candidate) && typeof candidate.description === "string"
      ? candidate.description
      : undefined
  } catch {
    return undefined
  }
}
