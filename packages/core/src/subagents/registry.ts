import type { DawnAgent, DelegationConstraintPredicate } from "@dawn-ai/sdk"
import { isDawnAgent } from "@dawn-ai/sdk"
import type { RouteDefinition, RouteManifest } from "../types.js"
import type { DescriptorRouteIndex, ResolvedDelegationRule, ResolvedSubagent } from "./types.js"

const SUBAGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const DEFAULT_DESCRIPTION = "No description provided."

export interface ResolveSubagentRegistryArgs {
  readonly descriptor: DawnAgent | undefined
  readonly descriptorRouteIndex: DescriptorRouteIndex
  readonly parentRouteDir: string
  readonly parentRouteId: string
  readonly routeManifest: RouteManifest
  readonly loadDescription: (route: RouteDefinition) => Promise<string>
}

interface ExplicitRegistration {
  readonly name: string
  readonly descriptor: DawnAgent
  readonly route: RouteDefinition
}

interface PendingSubagent {
  readonly name: string
  readonly route: RouteDefinition
  readonly source: "convention" | "explicit"
  readonly rule: ResolvedDelegationRule
}

function invalidDelegationPolicy(message: string): Error {
  return new Error(`[DAWN_E1004] ${message}`)
}

function routeProblem(parentRouteId: string, message: string): Error {
  return invalidDelegationPolicy(`Parent route "${parentRouteId}": ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key)
}

function assertKnownKeys(
  value: Record<string, unknown>,
  knownKeys: readonly string[],
  parentRouteId: string,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !knownKeys.includes(key))
  if (unknown.length > 0) {
    throw routeProblem(parentRouteId, `${label} has unknown field(s): ${unknown.join(", ")}.`)
  }
}

function validateName(name: string, source: string, parentRouteId: string): void {
  if (!SUBAGENT_NAME.test(name)) {
    throw routeProblem(
      parentRouteId,
      `Invalid ${source} subagent name "${name}". Names must match ${SUBAGENT_NAME.source}.`,
    )
  }
}

function normalizeRule(
  value: unknown,
  name: string,
  parentRouteId: string,
): ResolvedDelegationRule {
  if (!isRecord(value)) {
    throw routeProblem(parentRouteId, `Delegation rule "${name}" must be an object.`)
  }

  const action = value.action
  if (action === "allow") {
    assertKnownKeys(value, ["action"], parentRouteId, `Delegation rule "${name}"`)
    return { action }
  }

  if (action === "deny" || action === "approve") {
    assertKnownKeys(value, ["action", "reason"], parentRouteId, `Delegation rule "${name}"`)
    if (hasOwn(value, "reason") && typeof value.reason !== "string") {
      throw routeProblem(parentRouteId, `Delegation rule "${name}" has a non-string reason.`)
    }
    return hasOwn(value, "reason") ? { action, reason: value.reason as string } : { action }
  }

  if (action === "constrain") {
    assertKnownKeys(value, ["action", "predicate"], parentRouteId, `Delegation rule "${name}"`)
    if (typeof value.predicate !== "function") {
      throw routeProblem(
        parentRouteId,
        `Delegation rule "${name}" must provide a predicate function for action "constrain".`,
      )
    }
    return { action, predicate: value.predicate as DelegationConstraintPredicate }
  }

  throw routeProblem(
    parentRouteId,
    `Delegation rule "${name}" has an invalid action. Expected "allow", "deny", "approve", or "constrain".`,
  )
}

function validateDescriptorConfig(
  descriptor: DawnAgent | undefined,
  parentRouteId: string,
): {
  readonly explicit: readonly { readonly name: string; readonly descriptor: DawnAgent }[]
  readonly defaultAction: "allow" | "deny" | "approve"
  readonly rules: ReadonlyMap<string, ResolvedDelegationRule>
} {
  if (descriptor === undefined) {
    return { explicit: [], defaultAction: "allow", rules: new Map() }
  }

  const untypedDescriptor = descriptor as unknown as Record<string, unknown>
  const explicit: Array<{ readonly name: string; readonly descriptor: DawnAgent }> = []
  if (hasOwn(untypedDescriptor, "subagents")) {
    if (!isRecord(untypedDescriptor.subagents)) {
      throw routeProblem(parentRouteId, "subagents must be a keyed object of Dawn agents.")
    }
    for (const [name, child] of Object.entries(untypedDescriptor.subagents)) {
      validateName(name, "explicit", parentRouteId)
      if (!isDawnAgent(child)) {
        throw routeProblem(
          parentRouteId,
          `Explicit subagent "${name}" must reference a Dawn agent descriptor.`,
        )
      }
      explicit.push({ name, descriptor: child })
    }
  }

  let defaultAction: "allow" | "deny" | "approve" = "allow"
  const rules = new Map<string, ResolvedDelegationRule>()
  if (hasOwn(untypedDescriptor, "delegation")) {
    if (!isRecord(untypedDescriptor.delegation)) {
      throw routeProblem(parentRouteId, "delegation must be an object.")
    }
    const delegation = untypedDescriptor.delegation
    assertKnownKeys(delegation, ["default", "rules"], parentRouteId, "delegation")

    if (hasOwn(delegation, "default")) {
      if (
        delegation.default !== "allow" &&
        delegation.default !== "deny" &&
        delegation.default !== "approve"
      ) {
        throw routeProblem(
          parentRouteId,
          'delegation.default must be "allow", "deny", or "approve".',
        )
      }
      defaultAction = delegation.default
    }

    if (hasOwn(delegation, "rules")) {
      if (!isRecord(delegation.rules)) {
        throw routeProblem(parentRouteId, "delegation.rules must be an object.")
      }
      for (const [name, rule] of Object.entries(delegation.rules)) {
        validateName(name, "rule", parentRouteId)
        rules.set(name, normalizeRule(rule, name, parentRouteId))
      }
    }
  }

  const explicitNames = explicit.map(({ name }) => name).sort(compareNames)
  for (const name of rules.keys()) {
    if (!explicitNames.includes(name)) {
      const available = explicitNames.length > 0 ? explicitNames.join(", ") : "(none)"
      throw routeProblem(
        parentRouteId,
        `Unknown rule name "${name}". Named rules apply only to explicit registrations. Available explicit names: ${available}.`,
      )
    }
  }

  return { explicit, defaultAction, rules }
}

function defaultRule(action: "allow" | "deny" | "approve"): ResolvedDelegationRule {
  return { action }
}

function compareNames(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function discoverConventionRoutes(
  parentRouteDir: string,
  parentRouteId: string,
  routeManifest: RouteManifest,
): readonly { readonly name: string; readonly route: RouteDefinition }[] {
  const prefix = `${parentRouteDir}/subagents/`
  const result: Array<{ readonly name: string; readonly route: RouteDefinition }> = []

  for (const route of routeManifest.routes) {
    if (!route.routeDir.startsWith(prefix)) continue
    const name = route.routeDir.slice(prefix.length)
    if (name.length === 0 || name.includes("/")) continue
    validateName(name, "convention", parentRouteId)
    result.push({ name, route })
  }

  return result
}

function resolveExplicitRegistrations(
  explicit: readonly { readonly name: string; readonly descriptor: DawnAgent }[],
  descriptorRouteIndex: DescriptorRouteIndex,
  routeManifest: RouteManifest,
  parentRouteId: string,
): readonly ExplicitRegistration[] {
  const result: ExplicitRegistration[] = []
  const namesByRouteId = new Map<string, string>()

  for (const registration of explicit) {
    const candidates = descriptorRouteIndex.get(registration.descriptor)
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw routeProblem(
        parentRouteId,
        `Explicit subagent "${registration.name}" resolves to no route. Export it as a route default before registering it.`,
      )
    }
    if (candidates.some((candidate) => typeof candidate !== "string")) {
      throw routeProblem(
        parentRouteId,
        `Explicit subagent "${registration.name}" has an invalid descriptor route index entry.`,
      )
    }
    if (candidates.length > 1) {
      throw routeProblem(
        parentRouteId,
        `Explicit subagent "${registration.name}" is ambiguous; candidate routes: ${candidates.join(", ")}. Export a distinct descriptor object for each route.`,
      )
    }

    const routeId = candidates[0] as string
    const matchingRoutes = routeManifest.routes.filter((route) => route.id === routeId)
    if (matchingRoutes.length !== 1) {
      throw routeProblem(
        parentRouteId,
        `Explicit subagent "${registration.name}" resolved to "${routeId}", but that route is not uniquely present in the route manifest.`,
      )
    }

    const previousName = namesByRouteId.get(routeId)
    if (previousName !== undefined) {
      throw routeProblem(
        parentRouteId,
        `Route "${routeId}" is registered more than once under explicit names "${previousName}" and "${registration.name}".`,
      )
    }
    namesByRouteId.set(routeId, registration.name)
    result.push({ ...registration, route: matchingRoutes[0] as RouteDefinition })
  }

  return result
}

async function descriptionFor(
  route: RouteDefinition,
  loadDescription: ResolveSubagentRegistryArgs["loadDescription"],
): Promise<string> {
  try {
    const description = await loadDescription(route)
    return typeof description === "string" ? description : DEFAULT_DESCRIPTION
  } catch {
    return DEFAULT_DESCRIPTION
  }
}

export async function resolveSubagentRegistry({
  descriptor,
  descriptorRouteIndex,
  parentRouteDir,
  parentRouteId,
  routeManifest,
  loadDescription,
}: ResolveSubagentRegistryArgs): Promise<readonly ResolvedSubagent[]> {
  const config = validateDescriptorConfig(descriptor, parentRouteId)
  const convention = discoverConventionRoutes(parentRouteDir, parentRouteId, routeManifest)
  const explicit = resolveExplicitRegistrations(
    config.explicit,
    descriptorRouteIndex,
    routeManifest,
    parentRouteId,
  )

  const explicitRouteIds = new Set(explicit.map(({ route }) => route.id))
  const pending: PendingSubagent[] = convention
    .filter(({ route }) => !explicitRouteIds.has(route.id))
    .map(({ name, route }) => ({
      name,
      route,
      source: "convention",
      rule: defaultRule(config.defaultAction),
    }))

  for (const registration of explicit) {
    pending.push({
      name: registration.name,
      route: registration.route,
      source: "explicit",
      rule: config.rules.get(registration.name) ?? defaultRule(config.defaultAction),
    })
  }

  const registrationByName = new Map<string, PendingSubagent>()
  for (const registration of pending) {
    const previous = registrationByName.get(registration.name)
    if (previous !== undefined) {
      throw routeProblem(
        parentRouteId,
        `Model-facing name collision for "${registration.name}" between routes "${previous.route.id}" and "${registration.route.id}". Rename or explicitly alias one registration.`,
      )
    }
    registrationByName.set(registration.name, registration)
  }

  const sorted = pending.sort((a, b) => compareNames(a.name, b.name))
  const resolved: ResolvedSubagent[] = []
  for (const registration of sorted) {
    resolved.push({
      name: registration.name,
      routeId: registration.route.id,
      source: registration.source,
      description: await descriptionFor(registration.route, loadDescription),
      rule: registration.rule,
    })
  }
  return resolved
}

export function dispatchableSubagents(
  registry: readonly ResolvedSubagent[],
): readonly ResolvedSubagent[] {
  return registry.filter(({ rule }) => rule.action !== "deny")
}
