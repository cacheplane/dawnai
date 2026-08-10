import type { RuntimeExecutionResult } from "../runtime-result.js"
import type { RuntimeErrorExpectation, RuntimeMetaExpectation } from "./index.js"
import { createScenarioSnapshotter } from "./scenario-snapshot.js"
import type {
  ScenarioDescriptor,
  ScenarioSuiteBuilder,
  ScenarioSuiteDescriptor,
  ScenarioToolCallExpectationDescriptor,
  ScenarioToolMockDescriptor,
} from "./scenario-types.js"

const SCENARIO_SUITE = Symbol.for("dawn.scenario-suite")
const SCENARIO_DRAFT = Symbol("dawn.scenario-draft")
const TOOL_CALL_EXPECTATION_DRAFT = Symbol("dawn.tool-call-expectation-draft")
const parsedSuiteCache = new WeakMap<object, ScenarioSuiteDescriptor>()

type ScenarioStatus = ScenarioDescriptor["expectedStatus"]
type ToolCallCount = NonNullable<ScenarioToolCallExpectationDescriptor["count"]>

interface ScenarioDraft {
  readonly assert: ScenarioDescriptor["assert"] | undefined
  readonly execution: ScenarioDescriptor["execution"]
  readonly expectedError: RuntimeErrorExpectation | undefined
  readonly expectedErrorSet: boolean
  readonly expectedMeta: RuntimeMetaExpectation | undefined
  readonly expectedOutput: unknown
  readonly expectedOutputSet: boolean
  readonly expectedStatus: ScenarioStatus | undefined
  readonly input: unknown
  readonly inputSet: boolean
  readonly name: string
  readonly owner: symbol
  readonly toolCallExpectations: readonly ScenarioToolCallExpectationDescriptor[]
  readonly toolMocks: readonly ScenarioToolMockDescriptor[]
}

interface ToolCallExpectationDraft {
  readonly argumentMatchers: readonly unknown[]
  readonly count: ToolCallCount | undefined
  readonly name: string
  readonly notCalled: boolean
  readonly owner: symbol
}

interface RuntimeScenarioFacade {
  readonly [SCENARIO_DRAFT]: ScenarioDraft
  assert(callback: unknown): RuntimeScenarioFacade
  expectError(expectation: unknown): RuntimeScenarioFacade
  expectFailed(): RuntimeScenarioFacade
  expectMeta(expectation: unknown): RuntimeScenarioFacade
  expectOutput(expectation: unknown): RuntimeScenarioFacade
  expectPassed(): RuntimeScenarioFacade
  expectTool(name: unknown, configure: unknown): RuntimeScenarioFacade
  input(value: unknown): RuntimeScenarioFacade
  mockTool(name: unknown, implementation: unknown): RuntimeScenarioFacade
  server(url: unknown): RuntimeScenarioFacade
}

interface RuntimeToolCallExpectationFacade {
  readonly [TOOL_CALL_EXPECTATION_DRAFT]: ToolCallExpectationDraft
  called(): RuntimeToolCallExpectationFacade
  calledOnce(): RuntimeToolCallExpectationFacade
  calledTimes(count: unknown): RuntimeToolCallExpectationFacade
  notCalled(): RuntimeToolCallExpectationFacade
  withArgs(value: unknown): RuntimeToolCallExpectationFacade
}

export function createScenarioSuiteBuilder(
  route: string,
): ScenarioSuiteBuilder<Record<never, never>> {
  assertNonEmptyString(route, "Scenario suite route")
  const scenarios: readonly ScenarioDescriptor[] = Object.freeze([])
  return createSuiteFacade(Object.freeze({ route, scenarios }))
}

export function isScenarioSuite(
  value: unknown,
): value is ScenarioSuiteBuilder<Record<never, never>> {
  try {
    parseBrandedSuite(value)
    return true
  } catch {
    return false
  }
}

export function readScenarioSuite(value: unknown): ScenarioSuiteDescriptor {
  try {
    return parseBrandedSuite(value)
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown validation error"
    throw new Error(`Malformed scenario suite: ${detail}`)
  }
}

function createSuiteFacade(
  descriptor: ScenarioSuiteDescriptor,
): ScenarioSuiteBuilder<Record<never, never>> {
  const facade = {
    scenario(name: unknown, configure: unknown) {
      return addScenario(descriptor, name, configure)
    },
    [SCENARIO_SUITE]: descriptor,
  }

  const frozenFacade = Object.freeze(facade)
  parsedSuiteCache.set(frozenFacade, descriptor)
  return frozenFacade as unknown as ScenarioSuiteBuilder<Record<never, never>>
}

function addScenario(
  suite: ScenarioSuiteDescriptor,
  nameValue: unknown,
  configureValue: unknown,
): ScenarioSuiteBuilder<Record<never, never>> {
  const name = assertNonEmptyString(nameValue, "Scenario name")

  if (suite.scenarios.some((scenario) => scenario.name === name)) {
    throw new Error(`Duplicate scenario name: ${name}`)
  }

  if (typeof configureValue !== "function") {
    throw new Error(`Scenario ${name} requires a configure callback`)
  }

  const owner = Symbol(name)
  const initial = createScenarioFacade({
    assert: undefined,
    execution: "in-process",
    expectedError: undefined,
    expectedErrorSet: false,
    expectedMeta: undefined,
    expectedOutput: undefined,
    expectedOutputSet: false,
    expectedStatus: undefined,
    input: undefined,
    inputSet: false,
    name,
    owner,
    toolCallExpectations: [],
    toolMocks: [],
  })
  const configure = configureValue as (builder: RuntimeScenarioFacade) => unknown
  const configured = configure(initial)
  const draft = readScenarioDraft(configured, owner, name)
  const scenario = parseScenarioDescriptor(
    descriptorFromDraft(draft),
    suite.scenarios.length,
    createScenarioSnapshotter(),
  )
  const nextSuite = Object.freeze({
    route: suite.route,
    scenarios: Object.freeze([...suite.scenarios, scenario]),
  })

  return createSuiteFacade(nextSuite)
}

function createScenarioFacade(draft: ScenarioDraft): RuntimeScenarioFacade {
  Object.freeze(draft.toolCallExpectations)
  Object.freeze(draft.toolMocks)
  Object.freeze(draft)

  const facade: RuntimeScenarioFacade = {
    [SCENARIO_DRAFT]: draft,
    assert(callback) {
      if (typeof callback !== "function") {
        throw new Error(`Scenario ${draft.name} assert() requires a callback`)
      }

      return transitionScenario(draft, {
        assert: callback as (result: RuntimeExecutionResult) => unknown | Promise<unknown>,
      })
    },
    expectError(expectation) {
      if (draft.expectedStatus === "passed") {
        throw new Error("Passing scenarios cannot declare an error expectation")
      }

      return transitionScenario(draft, {
        expectedError: parseRuntimeErrorExpectation(expectation, "Error expectation"),
        expectedErrorSet: true,
      })
    },
    expectFailed() {
      assertStatusUnset(draft)

      if (draft.expectedOutputSet) {
        throw new Error("Failing scenarios cannot declare an output expectation")
      }

      return transitionScenario(draft, { expectedStatus: "failed" })
    },
    expectMeta(expectation) {
      return transitionScenario(draft, {
        expectedMeta: parseRuntimeMetaExpectation(expectation, "Metadata expectation"),
      })
    },
    expectOutput(expectation) {
      if (draft.expectedStatus === "failed") {
        throw new Error("Failing scenarios cannot declare an output expectation")
      }

      return transitionScenario(draft, {
        expectedOutput: expectation,
        expectedOutputSet: true,
      })
    },
    expectPassed() {
      assertStatusUnset(draft)

      if (draft.expectedErrorSet) {
        throw new Error("Passing scenarios cannot declare an error expectation")
      }

      return transitionScenario(draft, { expectedStatus: "passed" })
    },
    expectTool(name, configure) {
      return addToolCallExpectation(draft, name, configure)
    },
    input(value) {
      if (draft.inputSet) {
        throw new Error("Scenario input must be set exactly once")
      }

      return transitionScenario(draft, { input: value, inputSet: true })
    },
    mockTool(name, implementation) {
      return addToolMock(draft, name, implementation)
    },
    server(url) {
      if (draft.execution !== "in-process") {
        throw new Error("Server execution can only be selected once")
      }

      if (draft.toolMocks.length > 0) {
        throw new Error("Server scenarios cannot use tool mocks")
      }

      const serverUrl = assertNonEmptyString(url, "Scenario server URL")
      return transitionScenario(draft, { execution: { serverUrl } })
    },
  }

  return Object.freeze(facade)
}

function transitionScenario(
  draft: ScenarioDraft,
  updates: Partial<ScenarioDraft>,
): RuntimeScenarioFacade {
  const nextToolMocks = updates.toolMocks ?? draft.toolMocks
  const nextToolCallExpectations = updates.toolCallExpectations ?? draft.toolCallExpectations

  return createScenarioFacade({
    ...draft,
    ...updates,
    toolCallExpectations: [...nextToolCallExpectations],
    toolMocks: [...nextToolMocks],
  })
}

function addToolMock(
  draft: ScenarioDraft,
  nameValue: unknown,
  implementationValue: unknown,
): RuntimeScenarioFacade {
  if (draft.execution !== "in-process") {
    throw new Error("Server scenarios cannot use tool mocks")
  }

  const name = assertNonEmptyString(nameValue, "Tool mock name")

  if (draft.toolMocks.some((mock) => mock.name === name)) {
    throw new Error(`Tool mock ${name} can only be declared once`)
  }

  if (typeof implementationValue !== "function") {
    throw new Error(`Tool mock ${name} requires an implementation function`)
  }

  const implementation = implementationValue as (input: unknown) => unknown
  return transitionScenario(draft, {
    toolMocks: [...draft.toolMocks, { implementation, name }],
  })
}

function addToolCallExpectation(
  draft: ScenarioDraft,
  nameValue: unknown,
  configureValue: unknown,
): RuntimeScenarioFacade {
  if (draft.execution !== "in-process") {
    throw new Error("Server scenarios cannot declare tool expectations")
  }

  const name = assertNonEmptyString(nameValue, "Tool expectation name")

  if (!draft.toolMocks.some((mock) => mock.name === name)) {
    throw new Error(`Mock tool ${name} before declaring an expectation for it`)
  }

  if (typeof configureValue !== "function") {
    throw new Error(`Tool expectation ${name} requires a configure callback`)
  }

  const owner = Symbol(name)
  const initial = createToolCallExpectationFacade({
    argumentMatchers: [],
    count: undefined,
    name,
    notCalled: false,
    owner,
  })
  const configure = configureValue as (builder: RuntimeToolCallExpectationFacade) => unknown
  const configured = configure(initial)
  const callDraft = readToolCallExpectationDraft(configured, owner, name)

  if (!callDraft.count && callDraft.argumentMatchers.length === 0) {
    throw new Error(`Tool expectation ${name} must add at least one assertion`)
  }

  const expectation: ScenarioToolCallExpectationDescriptor = {
    argumentMatchers: [...callDraft.argumentMatchers],
    ...(callDraft.count ? { count: callDraft.count } : {}),
    name,
  }

  return transitionScenario(draft, {
    toolCallExpectations: [...draft.toolCallExpectations, expectation],
  })
}

function createToolCallExpectationFacade(
  draft: ToolCallExpectationDraft,
): RuntimeToolCallExpectationFacade {
  Object.freeze(draft.argumentMatchers)
  Object.freeze(draft)

  const facade: RuntimeToolCallExpectationFacade = {
    [TOOL_CALL_EXPECTATION_DRAFT]: draft,
    called() {
      return selectCallCount(draft, { kind: "at-least", value: 1 })
    },
    calledOnce() {
      return selectCallCount(draft, { kind: "exact", value: 1 })
    },
    calledTimes(countValue) {
      if (typeof countValue !== "number" || !Number.isSafeInteger(countValue) || countValue < 0) {
        throw new Error("calledTimes(count) requires a non-negative safe integer")
      }

      return selectCallCount(draft, { kind: "exact", value: countValue })
    },
    notCalled() {
      if (draft.argumentMatchers.length > 0) {
        throw new Error("notCalled cannot be combined with arguments")
      }

      return selectCallCount(draft, { kind: "exact", value: 0 }, true)
    },
    withArgs(value) {
      if (draft.notCalled) {
        throw new Error("notCalled cannot be combined with arguments")
      }

      if (draft.count?.kind === "exact" && draft.count.value === 0) {
        throw new Error("An exact zero call count cannot be combined with argument matchers")
      }

      return transitionToolCallExpectation(draft, {
        argumentMatchers: [...draft.argumentMatchers, value],
      })
    },
  }

  return Object.freeze(facade)
}

function selectCallCount(
  draft: ToolCallExpectationDraft,
  count: ToolCallCount,
  notCalled = false,
): RuntimeToolCallExpectationFacade {
  if (draft.count) {
    throw new Error("A tool expectation count can only be selected once")
  }

  return transitionToolCallExpectation(draft, { count, notCalled })
}

function transitionToolCallExpectation(
  draft: ToolCallExpectationDraft,
  updates: Partial<ToolCallExpectationDraft>,
): RuntimeToolCallExpectationFacade {
  const argumentMatchers = updates.argumentMatchers ?? draft.argumentMatchers
  return createToolCallExpectationFacade({
    ...draft,
    ...updates,
    argumentMatchers: [...argumentMatchers],
  })
}

function assertStatusUnset(draft: ScenarioDraft): void {
  if (draft.expectedStatus) {
    throw new Error("Scenario expected status must be set exactly once")
  }
}

function readScenarioDraft(value: unknown, owner: symbol, name: string): ScenarioDraft {
  if (!isRecord(value) || !Object.hasOwn(value, SCENARIO_DRAFT)) {
    throw new Error(`Scenario ${name} configure callback must return its builder`)
  }

  const draft = value[SCENARIO_DRAFT]

  if (!isScenarioDraft(draft) || draft.owner !== owner) {
    throw new Error(`Scenario ${name} configure callback must return its builder`)
  }

  return draft
}

function readToolCallExpectationDraft(
  value: unknown,
  owner: symbol,
  name: string,
): ToolCallExpectationDraft {
  if (!isRecord(value) || !Object.hasOwn(value, TOOL_CALL_EXPECTATION_DRAFT)) {
    throw new Error(`Tool expectation ${name} configure callback must return its builder`)
  }

  const draft = value[TOOL_CALL_EXPECTATION_DRAFT]

  if (!isToolCallExpectationDraft(draft) || draft.owner !== owner) {
    throw new Error(`Tool expectation ${name} configure callback must return its builder`)
  }

  return draft
}

function isScenarioDraft(value: unknown): value is ScenarioDraft {
  return isRecord(value) && typeof value.owner === "symbol"
}

function isToolCallExpectationDraft(value: unknown): value is ToolCallExpectationDraft {
  return isRecord(value) && typeof value.owner === "symbol"
}

function descriptorFromDraft(draft: ScenarioDraft): ScenarioDescriptor {
  if (!draft.inputSet) {
    throw new Error(`Scenario ${draft.name} requires input to be set exactly once`)
  }

  if (!draft.expectedStatus) {
    throw new Error(`Scenario ${draft.name} requires an expected status`)
  }

  if (draft.execution !== "in-process" && draft.toolMocks.length > 0) {
    throw new Error("Server scenarios cannot use tool mocks")
  }

  if (draft.expectedStatus === "failed" && draft.expectedOutputSet) {
    throw new Error("Failing scenarios cannot declare an output expectation")
  }

  if (draft.expectedStatus === "passed" && draft.expectedErrorSet) {
    throw new Error("Passing scenarios cannot declare an error expectation")
  }

  const mockedNames = new Set(draft.toolMocks.map((mock) => mock.name))

  for (const expectation of draft.toolCallExpectations) {
    if (!mockedNames.has(expectation.name)) {
      throw new Error(`Mock tool ${expectation.name} before declaring an expectation for it`)
    }
  }

  return {
    ...(draft.assert ? { assert: draft.assert } : {}),
    execution: draft.execution,
    ...(draft.expectedErrorSet && draft.expectedError
      ? { expectedError: draft.expectedError }
      : {}),
    ...(draft.expectedMeta ? { expectedMeta: draft.expectedMeta } : {}),
    ...(draft.expectedOutputSet ? { expectedOutput: draft.expectedOutput } : {}),
    expectedStatus: draft.expectedStatus,
    input: draft.input,
    name: draft.name,
    toolCallExpectations: [...draft.toolCallExpectations],
    toolMocks: [...draft.toolMocks],
  }
}

function parseBrandedSuite(value: unknown): ScenarioSuiteDescriptor {
  if (!isRecord(value)) {
    throw new Error("value must be a scenario suite facade")
  }

  const scenarioMethod = Object.getOwnPropertyDescriptor(value, "scenario")

  if (
    !scenarioMethod ||
    !("value" in scenarioMethod) ||
    typeof scenarioMethod.value !== "function"
  ) {
    throw new Error("scenario suite facade must have a callable scenario method")
  }

  const cached = parsedSuiteCache.get(value)

  if (cached) {
    return cached
  }

  const brand = Object.getOwnPropertyDescriptor(value, SCENARIO_SUITE)

  if (!brand || !("value" in brand)) {
    throw new Error("value does not carry the scenario suite brand")
  }

  const parsed = parseSuiteDescriptor(brand.value)
  parsedSuiteCache.set(value, parsed)
  return parsed
}

function parseSuiteDescriptor(value: unknown): ScenarioSuiteDescriptor {
  const suite = assertRecord(value, "suite descriptor")
  const route = assertNonEmptyString(readRequired(suite, "route", "Suite route"), "Suite route")
  const names = new Set<string>()
  const snapshot = createScenarioSnapshotter()
  const scenarios = mapDenseArray(
    readRequired(suite, "scenarios", "Suite scenarios"),
    "Suite scenarios",
    (scenario, index) => {
      const parsed = parseScenarioDescriptor(scenario, index, snapshot)

      if (names.has(parsed.name)) {
        throw new Error(`duplicate scenario name: ${parsed.name}`)
      }

      names.add(parsed.name)
      return parsed
    },
  )

  return Object.freeze({ route, scenarios: Object.freeze(scenarios) })
}

function parseScenarioDescriptor(
  value: unknown,
  index: number,
  snapshot: (value: unknown) => unknown,
): ScenarioDescriptor {
  const label = `Scenario at index ${index}`
  const scenario = assertRecord(value, label)
  const name = assertNonEmptyString(
    readRequired(scenario, "name", `${label} name`),
    `${label} name`,
  )
  const input = readRequired(scenario, "input", `Scenario ${name} input`)
  const expectedStatus = parseScenarioStatus(
    readRequired(scenario, "expectedStatus", `Scenario ${name} expected status`),
    name,
  )
  const execution = parseExecution(
    readRequired(scenario, "execution", `Scenario ${name} execution`),
    name,
  )
  const toolMocks = parseToolMocks(
    readRequired(scenario, "toolMocks", `Scenario ${name} tool mocks`),
    name,
  )
  const mockedNames = new Set(toolMocks.map((mock) => mock.name))
  const toolCallExpectations = parseToolCallExpectations(
    readRequired(scenario, "toolCallExpectations", `Scenario ${name} tool call expectations`),
    name,
    mockedNames,
    snapshot,
  )

  if (execution !== "in-process" && toolMocks.length > 0) {
    throw new Error(`Scenario ${name} combines server execution with tool mocks`)
  }

  const hasExpectedOutput = Object.hasOwn(scenario, "expectedOutput")
  const hasExpectedError = Object.hasOwn(scenario, "expectedError")

  if (expectedStatus === "failed" && hasExpectedOutput) {
    throw new Error(`Failing scenario ${name} cannot declare an output expectation`)
  }

  if (expectedStatus === "passed" && hasExpectedError) {
    throw new Error(`Passing scenario ${name} cannot declare an error expectation`)
  }

  const expectedError = hasExpectedError
    ? parseRuntimeErrorExpectation(scenario.expectedError, `Scenario ${name} error expectation`)
    : undefined
  const expectedMeta = Object.hasOwn(scenario, "expectedMeta")
    ? parseRuntimeMetaExpectation(scenario.expectedMeta, `Scenario ${name} metadata expectation`)
    : undefined
  const assertValue = Object.hasOwn(scenario, "assert") ? scenario.assert : undefined

  if (Object.hasOwn(scenario, "assert") && typeof assertValue !== "function") {
    throw new Error(`Scenario ${name} assert must be a function`)
  }

  return Object.freeze({
    ...(typeof assertValue === "function"
      ? {
          assert: assertValue as (result: RuntimeExecutionResult) => unknown | Promise<unknown>,
        }
      : {}),
    execution,
    ...(expectedError ? { expectedError } : {}),
    ...(expectedMeta ? { expectedMeta } : {}),
    ...(hasExpectedOutput ? { expectedOutput: snapshot(scenario.expectedOutput) } : {}),
    expectedStatus,
    input: snapshot(input),
    name,
    toolCallExpectations,
    toolMocks,
  })
}

function parseScenarioStatus(value: unknown, name: string): ScenarioStatus {
  if (value !== "failed" && value !== "passed") {
    throw new Error(`Scenario ${name} expected status must be passed or failed`)
  }

  return value
}

function parseExecution(value: unknown, name: string): ScenarioDescriptor["execution"] {
  if (value === "in-process") {
    return value
  }

  const execution = assertRecord(value, `Scenario ${name} execution`)
  const serverUrl = assertNonEmptyString(
    readRequired(execution, "serverUrl", `Scenario ${name} server URL`),
    `Scenario ${name} server URL`,
  )
  return Object.freeze({ serverUrl })
}

function parseToolMocks(
  value: unknown,
  scenarioName: string,
): readonly ScenarioToolMockDescriptor[] {
  const names = new Set<string>()
  const mocks = mapDenseArray(value, `Scenario ${scenarioName} tool mocks`, (mockValue, index) => {
    const label = `Scenario ${scenarioName} tool mock at index ${index}`
    const mock = assertRecord(mockValue, label)
    const name = assertNonEmptyString(readRequired(mock, "name", `${label} name`), `${label} name`)
    const implementation = readRequired(mock, "implementation", `${label} implementation`)

    if (names.has(name)) {
      throw new Error(`Scenario ${scenarioName} has duplicate tool mock ${name}`)
    }

    if (typeof implementation !== "function") {
      throw new Error(
        `Scenario ${scenarioName} tool mock ${name} implementation must be a function`,
      )
    }

    names.add(name)
    return Object.freeze({
      implementation: implementation as (input: unknown) => unknown,
      name,
    })
  })

  return Object.freeze(mocks)
}

function parseToolCallExpectations(
  value: unknown,
  scenarioName: string,
  mockedNames: ReadonlySet<string>,
  snapshot: (value: unknown) => unknown,
): readonly ScenarioToolCallExpectationDescriptor[] {
  const expectations = mapDenseArray(
    value,
    `Scenario ${scenarioName} tool call expectations`,
    (expectationValue, index) => {
      const label = `Scenario ${scenarioName} tool expectation at index ${index}`
      const expectation = assertRecord(expectationValue, label)
      const name = assertNonEmptyString(
        readRequired(expectation, "name", `${label} name`),
        `${label} name`,
      )

      if (!mockedNames.has(name)) {
        throw new Error(`Scenario ${scenarioName} must mock tool ${name} before expecting it`)
      }

      const argumentMatchers = mapDenseArray(
        readRequired(expectation, "argumentMatchers", `${label} argument matchers`),
        `${label} argument matchers`,
        snapshot,
      )

      const count = Object.hasOwn(expectation, "count")
        ? parseToolCallCount(expectation.count, label)
        : undefined

      if (!count && argumentMatchers.length === 0) {
        throw new Error(`${label} must contain at least one assertion`)
      }

      if (count?.kind === "exact" && count.value === 0 && argumentMatchers.length > 0) {
        throw new Error(`${label} exact zero count cannot be combined with argument matchers`)
      }

      return Object.freeze({
        argumentMatchers: Object.freeze(argumentMatchers),
        ...(count ? { count } : {}),
        name,
      })
    },
  )

  return Object.freeze(expectations)
}

function parseToolCallCount(value: unknown, label: string): ToolCallCount {
  const count = assertRecord(value, `${label} count`)

  if (count.kind === "at-least" && count.value === 1) {
    return Object.freeze({ kind: "at-least", value: 1 })
  }

  if (
    count.kind === "exact" &&
    typeof count.value === "number" &&
    Number.isSafeInteger(count.value) &&
    count.value >= 0
  ) {
    return Object.freeze({ kind: "exact", value: count.value })
  }

  throw new Error(`${label} count is malformed`)
}

function parseRuntimeMetaExpectation(value: unknown, label: string): RuntimeMetaExpectation {
  const expectation = assertRecord(value, label)
  const hasExecutionSource = Object.hasOwn(expectation, "executionSource")
  const hasMode = Object.hasOwn(expectation, "mode")
  const hasRouteId = Object.hasOwn(expectation, "routeId")
  const hasRoutePath = Object.hasOwn(expectation, "routePath")
  const executionSource = hasExecutionSource ? expectation.executionSource : undefined
  const mode = hasMode ? expectation.mode : undefined
  const routeId = hasRouteId ? expectation.routeId : undefined
  const routePath = hasRoutePath ? expectation.routePath : undefined

  if (hasExecutionSource && executionSource === undefined) {
    throw new Error(`${label}.executionSource cannot be undefined`)
  }

  if (hasMode && mode === undefined) {
    throw new Error(`${label}.mode cannot be undefined`)
  }

  if (hasRouteId && routeId === undefined) {
    throw new Error(`${label}.routeId cannot be undefined`)
  }

  if (hasRoutePath && routePath === undefined) {
    throw new Error(`${label}.routePath cannot be undefined`)
  }

  if (
    executionSource !== undefined &&
    executionSource !== "in-process" &&
    executionSource !== "server"
  ) {
    throw new Error(`${label}.executionSource must be in-process or server`)
  }

  if (
    mode !== undefined &&
    mode !== null &&
    mode !== "agent" &&
    mode !== "chain" &&
    mode !== "graph" &&
    mode !== "workflow"
  ) {
    throw new Error(`${label}.mode is malformed`)
  }

  if (routeId !== undefined && routeId !== null && typeof routeId !== "string") {
    throw new Error(`${label}.routeId must be a string or null`)
  }

  if (routePath !== undefined && routePath !== null && typeof routePath !== "string") {
    throw new Error(`${label}.routePath must be a string or null`)
  }

  return Object.freeze({
    ...(executionSource !== undefined ? { executionSource } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(routeId !== undefined ? { routeId } : {}),
    ...(routePath !== undefined ? { routePath } : {}),
  })
}

function parseRuntimeErrorExpectation(value: unknown, label: string): RuntimeErrorExpectation {
  const expectation = assertRecord(value, label)
  const hasKind = Object.hasOwn(expectation, "kind")
  const hasMessage = Object.hasOwn(expectation, "message")
  const kind = hasKind ? expectation.kind : undefined
  const message = hasMessage ? expectation.message : undefined

  if (hasKind && kind === undefined) {
    throw new Error(`${label}.kind cannot be undefined`)
  }

  if (hasMessage && message === undefined) {
    throw new Error(`${label}.message cannot be undefined`)
  }

  if (kind !== undefined && typeof kind !== "string") {
    throw new Error(`${label}.kind must be a string`)
  }

  if (message !== undefined && typeof message !== "string") {
    const messageMatcher = assertRecord(message, `${label}.message`)

    if (typeof messageMatcher.includes !== "string") {
      throw new Error(`${label}.message.includes must be a string`)
    }

    return Object.freeze({
      ...(kind !== undefined ? { kind } : {}),
      message: Object.freeze({ includes: messageMatcher.includes }),
    })
  }

  return Object.freeze({
    ...(kind !== undefined ? { kind } : {}),
    ...(message !== undefined ? { message } : {}),
  })
}

function readRequired(
  record: Record<PropertyKey, unknown>,
  key: PropertyKey,
  label: string,
): unknown {
  if (!Object.hasOwn(record, key)) {
    throw new Error(`${label} is required`)
  }

  return record[key]
}

function assertRecord(value: unknown, label: string): Record<PropertyKey, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`)
  }

  return value
}

function assertDenseArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`)
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new Error(`${label} must not contain a hole at index ${index}`)
    }
  }

  return value
}

function mapDenseArray<T>(
  value: unknown,
  label: string,
  transform: (value: unknown, index: number) => T,
): T[] {
  const values = assertDenseArray(value, label)
  const transformed: T[] = []

  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index)) {
      throw new Error(`${label} must not contain a hole at index ${index}`)
    }

    transformed.push(transform(values[index], index))
  }

  return transformed
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }

  return value
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null
}
