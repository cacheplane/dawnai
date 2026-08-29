import { snapshotJson } from "./adapter-normalize.mjs"
import { planRelease } from "./planner.mjs"

const REPORT_FIELDS = Object.freeze(["schemaVersion", "candidate", "before", "transition", "after"])
const PLAN_FIELDS = Object.freeze([
  "state",
  "disposition",
  "nextTransition",
  "reasons",
  "conflicts",
  "proposedMutations",
])
const TRANSITION_FIELDS = Object.freeze(["name", "status", "result", "error"])
const DISPOSITIONS = new Set(["noop", "audit-only", "would-transition", "blocked"])
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u

export async function runReleaseController({
  candidate,
  dryRun = false,
  observer,
  planner,
  effects,
  reporter,
}) {
  if (typeof dryRun !== "boolean") throw new TypeError("Release controller dry-run is invalid")
  const identity = candidate === null ? null : deepFreeze(snapshotJson(candidate))
  const observe = bindMethod(observer, "observe", "Release controller observer")
  const plan =
    planner === undefined
      ? (input) => planRelease(input)
      : bindMethod(planner, "plan", "Release controller planner")
  const writeReport = bindMethod(reporter, "write", "Release controller reporter")

  const beforeObservation = deepFreeze(snapshotJson(await observe({ candidate: identity })))
  const beforePlan = deepFreeze(
    normalizePlan(
      await plan({ candidate: identity, observation: beforeObservation, mode: "controller" }),
    ),
  )
  const before = deepFreeze({ observation: beforeObservation, plan: beforePlan })

  if (beforePlan.disposition !== "would-transition") {
    const output = report({
      candidate: identity,
      before,
      transition: transitionRecord({
        name: null,
        status: beforePlan.disposition === "blocked" ? "blocked" : "not-required",
      }),
      after: null,
    })
    await writeReport(output)
    return output
  }

  const transitionName = beforePlan.nextTransition
  if (dryRun) {
    const output = report({
      candidate: identity,
      before,
      transition: transitionRecord({ name: transitionName, status: "dry-run" }),
      after: null,
    })
    await writeReport(output)
    return output
  }

  let execute
  try {
    execute = selectedEffect(effects, transitionName)
  } catch (error) {
    const output = report({
      candidate: identity,
      before,
      transition: transitionRecord({
        name: transitionName,
        status: "configuration-error",
        error: { classification: "fatal", code: "RELEASE_EFFECT_UNAVAILABLE" },
      }),
      after: null,
    })
    await writeReport(output)
    throw controllerError({
      code: "RELEASE_EFFECT_UNAVAILABLE",
      report: output,
      cause: error,
    })
  }

  let transitionResult = null
  let transitionError = null
  try {
    const value = await execute({
      candidate: identity,
      observation: beforeObservation,
      plan: beforePlan,
    })
    transitionResult = value === undefined ? null : snapshotJson(value)
  } catch (error) {
    transitionError = normalizeTransitionError(error)
  }

  let after = null
  let observationFailure = null
  try {
    const afterObservation = deepFreeze(snapshotJson(await observe({ candidate: identity })))
    const afterPlan = deepFreeze(
      normalizePlan(
        await plan({ candidate: identity, observation: afterObservation, mode: "controller" }),
      ),
    )
    after = deepFreeze({ observation: afterObservation, plan: afterPlan })
  } catch (error) {
    observationFailure = normalizeTransitionError(error)
  }

  if (transitionError === null && observationFailure === null) {
    const output = report({
      candidate: identity,
      before,
      transition: transitionRecord({
        name: transitionName,
        status: "completed",
        result: transitionResult,
      }),
      after,
    })
    await writeReport(output)
    return output
  }

  const primary =
    [transitionError, observationFailure].find(
      (failure) => failure !== null && !failure.retryable,
    ) ??
    transitionError ??
    observationFailure
  const output = report({
    candidate: identity,
    before,
    transition: transitionRecord({
      name: transitionName,
      status: primary.retryable ? "retryable-error" : "fatal-error",
      result: transitionResult,
      error: {
        classification: primary.retryable ? "retryable" : "fatal",
        code: primary.code,
        ...(observationFailure === null ? {} : { reobservationCode: observationFailure.code }),
      },
    }),
    after,
  })
  await writeReport(output)
  throw controllerError({ code: primary.code, report: output, cause: primary.cause })
}

function normalizePlan(value) {
  const plan = snapshotJson(value)
  if (
    !hasExactFields(plan, PLAN_FIELDS) ||
    typeof plan.state !== "string" ||
    plan.state.length === 0 ||
    !DISPOSITIONS.has(plan.disposition) ||
    !Array.isArray(plan.reasons) ||
    !plan.reasons.every((reason) => typeof reason === "string") ||
    !Array.isArray(plan.conflicts) ||
    !plan.conflicts.every((conflict) => typeof conflict === "string") ||
    !Array.isArray(plan.proposedMutations)
  ) {
    throw new TypeError("Release controller plan is malformed")
  }
  if (
    (plan.disposition === "would-transition" &&
      (typeof plan.nextTransition !== "string" || plan.nextTransition.length === 0)) ||
    (plan.disposition !== "would-transition" && plan.nextTransition !== null)
  ) {
    throw new TypeError("Release controller plan transition is malformed")
  }
  return plan
}

function selectedEffect(effects, name) {
  if (effects === null || typeof effects !== "object" || Array.isArray(effects)) {
    throw new TypeError("Release controller effects are invalid")
  }
  const descriptor = Object.getOwnPropertyDescriptor(effects, name)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    throw new TypeError(`Release controller effect ${name} is unavailable`)
  }
  return descriptor.value.bind(effects)
}

function bindMethod(value, method, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, method)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    throw new TypeError(`${label} method ${method} is invalid`)
  }
  return descriptor.value.bind(value)
}

function normalizeTransitionError(error) {
  const codeDescriptor =
    error !== null && typeof error === "object"
      ? Object.getOwnPropertyDescriptor(error, "code")
      : undefined
  const retryableDescriptor =
    error !== null && typeof error === "object"
      ? Object.getOwnPropertyDescriptor(error, "retryable")
      : undefined
  const code =
    codeDescriptor !== undefined &&
    "value" in codeDescriptor &&
    typeof codeDescriptor.value === "string" &&
    ERROR_CODE_PATTERN.test(codeDescriptor.value)
      ? codeDescriptor.value
      : "RELEASE_TRANSITION_FAILED"
  const retryable =
    retryableDescriptor !== undefined &&
    "value" in retryableDescriptor &&
    retryableDescriptor.value === true
  return { code, retryable, cause: error }
}

function transitionRecord({ name, status, result = null, error = null }) {
  return { name, status, result, error }
}

function report({ candidate, before, transition, after }) {
  const output = {
    schemaVersion: 1,
    candidate,
    before,
    transition,
    after,
  }
  if (
    !hasExactFields(output, REPORT_FIELDS) ||
    !hasExactFields(output.transition, TRANSITION_FIELDS)
  ) {
    throw new TypeError("Release controller report is malformed")
  }
  return deepFreeze(snapshotJson(output))
}

function controllerError({ code, report, cause }) {
  const error = new Error("Release controller transition did not complete", { cause })
  Object.defineProperties(error, {
    code: { value: code, enumerable: true },
    report: { value: report, enumerable: true },
  })
  return error
}

function hasExactFields(value, fields) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  )
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
