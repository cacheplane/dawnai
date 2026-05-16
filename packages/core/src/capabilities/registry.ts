import type { CapabilityContribution, CapabilityMarker } from "./types.js"

export type { CapabilityMarker }

export interface CapabilityRegistry {
  readonly markers: ReadonlyArray<CapabilityMarker>
}

export interface AppliedContribution {
  readonly markerName: string
  readonly contribution: CapabilityContribution
}

export interface CapabilityError {
  readonly markerName: string
  readonly phase: "detect" | "load"
  readonly message: string
}

export interface ApplyResult {
  readonly contributions: ReadonlyArray<AppliedContribution>
  readonly errors: ReadonlyArray<CapabilityError>
}

export function createCapabilityRegistry(
  markers: ReadonlyArray<CapabilityMarker>,
): CapabilityRegistry {
  return { markers }
}

export async function applyCapabilities(
  registry: CapabilityRegistry,
  routeDir: string,
): Promise<ApplyResult> {
  const contributions: AppliedContribution[] = []
  const errors: CapabilityError[] = []

  for (const marker of registry.markers) {
    let detected: boolean
    try {
      detected = await marker.detect(routeDir)
    } catch (error) {
      errors.push({
        markerName: marker.name,
        phase: "detect",
        message: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    if (!detected) continue

    try {
      const contribution = await marker.load(routeDir)
      contributions.push({ markerName: marker.name, contribution })
    } catch (error) {
      errors.push({
        markerName: marker.name,
        phase: "load",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { contributions, errors }
}
