import type { RuntimeExecutionResult } from "../runtime-result.js"
import type { RuntimeErrorExpectation, RuntimeMetaExpectation } from "./index.js"
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
const SNAPSHOT_DATA = Symbol.for("dawn.scenario-readonly-snapshot-data.v1")

const DATE_MUTATORS = new Set<PropertyKey>([
  "setDate",
  "setFullYear",
  "setHours",
  "setMilliseconds",
  "setMinutes",
  "setMonth",
  "setSeconds",
  "setTime",
  "setUTCDate",
  "setUTCFullYear",
  "setUTCHours",
  "setUTCMilliseconds",
  "setUTCMinutes",
  "setUTCMonth",
  "setUTCSeconds",
  "setYear",
])

const MAP_MUTATORS = new Set<PropertyKey>(["clear", "delete", "set"])
const SET_MUTATORS = new Set<PropertyKey>(["add", "clear", "delete"])
const ARRAY_BUFFER_MUTATORS = new Set<PropertyKey>(["resize", "transfer", "transferToFixedLength"])
const SHARED_ARRAY_BUFFER_MUTATORS = new Set<PropertyKey>(["grow"])
const TYPED_ARRAY_MUTATORS = new Set<PropertyKey>(["copyWithin", "fill", "reverse", "set", "sort"])

const TYPED_ARRAY_CONSTRUCTORS = {
  BigInt64Array,
  BigUint64Array,
  Float32Array,
  Float64Array,
  Int16Array,
  Int32Array,
  Int8Array,
  Uint16Array,
  Uint32Array,
  Uint8Array,
  Uint8ClampedArray,
} as const
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object

type BinaryBuffer = ArrayBuffer | SharedArrayBuffer
type BinaryBufferKind = "ArrayBuffer" | "SharedArrayBuffer"
type SupportedTypedArray = InstanceType<
  (typeof TYPED_ARRAY_CONSTRUCTORS)[keyof typeof TYPED_ARRAY_CONSTRUCTORS]
>
type TypedArrayName = keyof typeof TYPED_ARRAY_CONSTRUCTORS

interface BinaryBufferSnapshotData {
  readonly bytes: Uint8Array
  readonly kind: BinaryBufferKind
  readonly maxByteLength: number
  readonly resizable: boolean
}

interface DataViewSnapshotData {
  readonly buffer: BinaryBuffer
  readonly byteLength: number
  readonly byteOffset: number
  readonly kind: "DataView"
}

interface TypedArraySnapshotData {
  readonly buffer: BinaryBuffer
  readonly byteOffset: number
  readonly kind: "TypedArray"
  readonly length: number
  readonly name: TypedArrayName
}

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
  return createSuiteFacade(parseSuiteDescriptor({ route, scenarios: [] }))
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

  return Object.freeze(facade) as unknown as ScenarioSuiteBuilder<Record<never, never>>
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
  const scenario = descriptorFromDraft(draft)
  const nextSuite = parseSuiteDescriptor({
    route: suite.route,
    scenarios: [...suite.scenarios, scenario],
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
  if (!isRecord(value) || !Object.hasOwn(value, SCENARIO_SUITE)) {
    throw new Error("value does not carry the scenario suite brand")
  }

  return parseSuiteDescriptor(value[SCENARIO_SUITE])
}

function parseSuiteDescriptor(value: unknown): ScenarioSuiteDescriptor {
  const suite = assertRecord(value, "suite descriptor")
  const route = assertNonEmptyString(readRequired(suite, "route", "Suite route"), "Suite route")
  const names = new Set<string>()
  const snapshot = createUnknownSnapshotter()
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

function createUnknownSnapshotter(): (value: unknown) => unknown {
  const seen = new WeakMap<object, unknown>()
  const binaryBackings = new WeakMap<object, BinaryBuffer>()

  function snapshot(value: unknown): unknown {
    if (typeof value !== "object" || value === null) {
      return value
    }

    if (seen.has(value)) {
      return seen.get(value)
    }

    if (Array.isArray(value)) {
      const copy: unknown[] = []
      copy.length = value.length
      remember(value, copy)

      for (let index = 0; index < value.length; index += 1) {
        if (Object.hasOwn(value, index)) {
          copy[index] = snapshot(value[index])
        }
      }

      return Object.freeze(copy)
    }

    if (value instanceof Date) {
      const target = new Date(readDateTime(value))
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      const proxy = createReadOnlyDateSnapshot(target)
      remember(value, proxy)
      snapshotOwnProperties(value, target, snapshot)
      Object.freeze(target)
      return proxy
    }

    if (value instanceof Map) {
      const target = new Map<unknown, unknown>()
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      const proxy = createReadOnlyMapSnapshot(target)
      remember(value, proxy)

      for (const [key, item] of readMapEntries(value)) {
        Map.prototype.set.call(target, snapshot(key), snapshot(item))
      }

      snapshotOwnProperties(value, target, snapshot)
      Object.freeze(target)
      return proxy
    }

    if (value instanceof Set) {
      const target = new Set<unknown>()
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      const proxy = createReadOnlySetSnapshot(target)
      remember(value, proxy)

      for (const item of readSetValues(value)) {
        Set.prototype.add.call(target, snapshot(item))
      }

      snapshotOwnProperties(value, target, snapshot)
      Object.freeze(target)
      return proxy
    }

    if (value instanceof RegExp) {
      const state = readRegExpState(value)
      const target = new RegExp(state.source, state.flags)
      target.lastIndex = state.lastIndex
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      const proxy = createReadOnlyRegExpSnapshot(target)
      remember(value, proxy)
      snapshotOwnProperties(value, target, snapshot, (key) => key === "lastIndex")
      Object.freeze(target)
      return proxy
    }

    if (value instanceof ArrayBuffer) {
      return snapshotBinaryBuffer(value, "ArrayBuffer")
    }

    if (value instanceof SharedArrayBuffer) {
      return snapshotBinaryBuffer(value, "SharedArrayBuffer")
    }

    if (value instanceof DataView) {
      const state = readDataViewState(value)
      const buffer = snapshot(state.buffer)
      const cycleSnapshot = seen.get(value)

      if (cycleSnapshot) {
        return cycleSnapshot
      }

      const backing = isRecord(buffer) ? binaryBackings.get(buffer) : undefined

      if (!backing) {
        throw new TypeError("DataView snapshot buffer is malformed")
      }

      const target = new DataView(backing, state.byteOffset, state.byteLength)
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      const proxy = createReadOnlyDataViewSnapshot(target, buffer as BinaryBuffer)
      remember(value, proxy)
      snapshotOwnProperties(value, target, snapshot)
      Object.freeze(target)
      return proxy
    }

    const typedArrayName = getTypedArrayName(value)

    if (typedArrayName) {
      const typedArray = value as SupportedTypedArray
      const state = readTypedArrayState(typedArray, typedArrayName)
      const buffer = snapshot(state.buffer)
      const cycleSnapshot = seen.get(typedArray)

      if (cycleSnapshot) {
        return cycleSnapshot
      }

      const backing = isRecord(buffer) ? binaryBackings.get(buffer) : undefined

      if (!backing) {
        throw new TypeError(`${typedArrayName} snapshot buffer is malformed`)
      }

      const target = createTypedArrayTarget(typedArrayName, backing, state.byteOffset, state.length)
      Object.setPrototypeOf(target, Object.getPrototypeOf(typedArray))
      const proxy = createReadOnlyTypedArraySnapshot(target, typedArrayName, buffer as BinaryBuffer)
      remember(typedArray, proxy)
      snapshotOwnProperties(typedArray, target, snapshot, isTypedArrayElementKey)
      Object.preventExtensions(target)
      return proxy
    }

    if (value instanceof Number) {
      return snapshotBoxedPrimitive(
        value,
        new Number(Number.prototype.valueOf.call(value)),
        snapshot,
      )
    }

    if (value instanceof String) {
      return snapshotBoxedPrimitive(
        value,
        new String(String.prototype.valueOf.call(value)),
        snapshot,
        (key) => key === "length" || isCanonicalArrayIndex(key),
      )
    }

    if (value instanceof Boolean) {
      return snapshotBoxedPrimitive(
        value,
        new Boolean(Boolean.prototype.valueOf.call(value)),
        snapshot,
      )
    }

    if (Object.prototype.toString.call(value) === "[object BigInt]") {
      const primitive = Reflect.apply(BigInt.prototype.valueOf, value, []) as bigint
      return snapshotBoxedPrimitive(value, Object(primitive), snapshot)
    }

    if (typeof File !== "undefined" && value instanceof File) {
      const target = new File([value], value.name, {
        lastModified: value.lastModified,
        type: value.type,
      })
      const intrinsicKeys = new Set<PropertyKey>(Reflect.ownKeys(target))
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      remember(value, target)
      snapshotOwnProperties(value, target, snapshot, (key) => intrinsicKeys.has(key))
      return Object.freeze(target)
    }

    if (typeof Blob !== "undefined" && value instanceof Blob) {
      const target = Blob.prototype.slice.call(value, 0, value.size, value.type) as Blob
      const intrinsicKeys = new Set<PropertyKey>(Reflect.ownKeys(target))
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      remember(value, target)
      snapshotOwnProperties(value, target, snapshot, (key) => intrinsicKeys.has(key))
      return Object.freeze(target)
    }

    if (typeof DOMException !== "undefined" && value instanceof DOMException) {
      const target = new DOMException(value.message, value.name)
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      remember(value, target)
      snapshotOwnProperties(value, target, snapshot)
      return Object.freeze(target)
    }

    if (value instanceof Error) {
      const target = new Error()
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      remember(value, target)
      snapshotOwnProperties(value, target, snapshot)
      return Object.freeze(target)
    }

    const tag = Object.prototype.toString.call(value)

    if (tag !== "[object Object]") {
      throw new TypeError(`${readSnapshotTypeName(tag)} snapshot values are not supported`)
    }

    const copy = Object.create(Object.getPrototypeOf(value)) as object
    remember(value, copy)
    snapshotOwnProperties(value, copy, snapshot)
    return Object.freeze(copy)
  }

  function snapshotBinaryBuffer(source: BinaryBuffer, kind: BinaryBufferKind): BinaryBuffer {
    const data = readBinaryBufferState(source, kind)
    const target = createBinaryBufferTarget(data)
    Object.setPrototypeOf(target, Object.getPrototypeOf(source))
    const proxy = createReadOnlyBinaryBufferSnapshot(target, kind)
    remember(source, proxy)
    binaryBackings.set(proxy, target)
    snapshotOwnProperties(source, target, snapshot)
    Object.freeze(target)
    return proxy
  }

  function snapshotBoxedPrimitive(
    source: object,
    target: object,
    snapshotValue: (value: unknown) => unknown,
    skip?: (key: PropertyKey) => boolean,
  ): object {
    Object.setPrototypeOf(target, Object.getPrototypeOf(source))
    remember(source, target)
    snapshotOwnProperties(source, target, snapshotValue, skip)
    return Object.freeze(target)
  }

  function remember(original: object, copy: object): void {
    seen.set(original, copy)
  }

  return snapshot
}

function createReadOnlyDateSnapshot(target: Date): Date {
  return new Proxy(target, {
    get(date, property, receiver) {
      if (property === SNAPSHOT_DATA) {
        return Object.freeze({ kind: "Date", time: Date.prototype.getTime.call(date) })
      }

      if (DATE_MUTATORS.has(property)) {
        return rejectSnapshotMutation
      }

      const result = Reflect.get(date, property, receiver)
      const descriptor = Object.getOwnPropertyDescriptor(Date.prototype, property)

      if (
        typeof result === "function" &&
        property !== "constructor" &&
        descriptor &&
        "value" in descriptor &&
        result === descriptor.value
      ) {
        return result.bind(date)
      }

      return result
    },
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
    set: rejectSnapshotMutation,
    setPrototypeOf: rejectSnapshotMutation,
  })
}

function createReadOnlyMapSnapshot(target: Map<unknown, unknown>): Map<unknown, unknown> {
  let proxy: Map<unknown, unknown>
  proxy = new Proxy(target, {
    get(map, property, receiver) {
      if (property === SNAPSHOT_DATA) {
        return createMapSnapshotData(map)
      }

      if (MAP_MUTATORS.has(property)) {
        return rejectSnapshotMutation
      }

      if (property === "size") {
        return Reflect.get(map, property, map)
      }

      if (property === "forEach") {
        return (
          callback: (value: unknown, key: unknown, map: Map<unknown, unknown>) => void,
          thisArg?: unknown,
        ): void => {
          Map.prototype.forEach.call(map, (value, key) => {
            callback.call(thisArg, value, key, proxy)
          })
        }
      }

      const result = Reflect.get(map, property, receiver)
      const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, property)

      if (
        typeof result === "function" &&
        property !== "constructor" &&
        descriptor &&
        "value" in descriptor &&
        result === descriptor.value
      ) {
        return result.bind(map)
      }

      return result
    },
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
    set: rejectSnapshotMutation,
    setPrototypeOf: rejectSnapshotMutation,
  })
  return proxy
}

function createReadOnlySetSnapshot(target: Set<unknown>): Set<unknown> {
  let proxy: Set<unknown>
  proxy = new Proxy(target, {
    get(set, property, receiver) {
      if (property === SNAPSHOT_DATA) {
        return createSetSnapshotData(set)
      }

      if (SET_MUTATORS.has(property)) {
        return rejectSnapshotMutation
      }

      if (property === "size") {
        return Reflect.get(set, property, set)
      }

      if (property === "forEach") {
        return (
          callback: (value: unknown, key: unknown, set: Set<unknown>) => void,
          thisArg?: unknown,
        ): void => {
          Set.prototype.forEach.call(set, (value) => {
            callback.call(thisArg, value, value, proxy)
          })
        }
      }

      const result = Reflect.get(set, property, receiver)
      const descriptor = Object.getOwnPropertyDescriptor(Set.prototype, property)

      if (
        typeof result === "function" &&
        property !== "constructor" &&
        descriptor &&
        "value" in descriptor &&
        result === descriptor.value
      ) {
        return result.bind(set)
      }

      return result
    },
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
    set: rejectSnapshotMutation,
    setPrototypeOf: rejectSnapshotMutation,
  })
  return proxy
}

function createReadOnlyRegExpSnapshot(target: RegExp): RegExp {
  return new Proxy(target, {
    get(regexp, property, receiver) {
      if (property === SNAPSHOT_DATA) {
        return createRegExpSnapshotData(regexp)
      }

      if (property === "compile") {
        return rejectSnapshotMutation
      }

      const result = readProxyProperty(regexp, property, receiver)

      if (typeof result !== "function" || property === "constructor") {
        return result
      }

      return (...args: unknown[]): unknown => {
        const working = new RegExp(regexp.source, regexp.flags)
        working.lastIndex = regexp.lastIndex
        Object.setPrototypeOf(working, Object.getPrototypeOf(regexp))
        return Reflect.apply(result, working, args)
      }
    },
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
    set: rejectSnapshotMutation,
    setPrototypeOf: rejectSnapshotMutation,
  })
}

function createReadOnlyBinaryBufferSnapshot(
  target: BinaryBuffer,
  kind: BinaryBufferKind,
): BinaryBuffer {
  const prototype = kind === "ArrayBuffer" ? ArrayBuffer.prototype : SharedArrayBuffer.prototype
  const mutators = kind === "ArrayBuffer" ? ARRAY_BUFFER_MUTATORS : SHARED_ARRAY_BUFFER_MUTATORS

  return new Proxy(target, {
    get(buffer, property, receiver) {
      if (property === SNAPSHOT_DATA) {
        return Object.freeze(readBinaryBufferState(buffer, kind))
      }

      if (mutators.has(property)) {
        return rejectSnapshotMutation
      }

      const descriptor = Object.getOwnPropertyDescriptor(prototype, property)

      if (descriptor?.get) {
        return Reflect.apply(descriptor.get, buffer, [])
      }

      const result = Reflect.get(buffer, property, receiver)

      if (
        typeof result === "function" &&
        property !== "constructor" &&
        descriptor &&
        "value" in descriptor &&
        result === descriptor.value
      ) {
        return result.bind(buffer)
      }

      return result
    },
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
    set: rejectSnapshotMutation,
    setPrototypeOf: rejectSnapshotMutation,
  })
}

function createReadOnlyDataViewSnapshot(target: DataView, buffer: BinaryBuffer): DataView {
  return new Proxy(target, {
    get(view, property, receiver) {
      if (property === SNAPSHOT_DATA) {
        return Object.freeze({
          buffer,
          byteLength: view.byteLength,
          byteOffset: view.byteOffset,
          kind: "DataView",
        } satisfies DataViewSnapshotData)
      }

      if (property === "buffer") {
        return buffer
      }

      if (typeof property === "string" && property.startsWith("set")) {
        return rejectSnapshotMutation
      }

      const descriptor = Object.getOwnPropertyDescriptor(DataView.prototype, property)

      if (descriptor?.get) {
        return Reflect.apply(descriptor.get, view, [])
      }

      const result = Reflect.get(view, property, receiver)

      if (
        typeof result === "function" &&
        property !== "constructor" &&
        descriptor &&
        "value" in descriptor &&
        result === descriptor.value
      ) {
        return result.bind(view)
      }

      return result
    },
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
    set: rejectSnapshotMutation,
    setPrototypeOf: rejectSnapshotMutation,
  })
}

function createReadOnlyTypedArraySnapshot(
  target: SupportedTypedArray,
  name: TypedArrayName,
  buffer: BinaryBuffer,
): SupportedTypedArray {
  return new Proxy(target, {
    get(typedArray, property, receiver) {
      if (property === SNAPSHOT_DATA) {
        return Object.freeze({
          buffer,
          byteOffset: readTypedArrayNumber(typedArray, "byteOffset"),
          kind: "TypedArray",
          length: readTypedArrayNumber(typedArray, "length"),
          name,
        } satisfies TypedArraySnapshotData)
      }

      if (property === "buffer") {
        return buffer
      }

      if (TYPED_ARRAY_MUTATORS.has(property)) {
        return rejectSnapshotMutation
      }

      const result = readProxyProperty(typedArray, property, receiver)

      if (typeof result !== "function" || property === "constructor") {
        return result
      }

      return (...args: unknown[]): unknown => {
        const working = cloneTypedArrayTarget(typedArray, name)
        const method = Reflect.get(working, property, working)

        if (typeof method !== "function") {
          throw new TypeError(`${String(property)} is not callable on ${name}`)
        }

        return Reflect.apply(method, working, args)
      }
    },
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
    set: rejectSnapshotMutation,
    setPrototypeOf: rejectSnapshotMutation,
  })
}

function readDateTime(source: Date): number {
  try {
    return Date.prototype.getTime.call(source)
  } catch {
    const data = readSnapshotData(source, "Date")

    if (typeof data.time !== "number") {
      throw new TypeError("Date snapshot data is malformed")
    }

    return data.time
  }
}

function readMapEntries(source: Map<unknown, unknown>): readonly (readonly [unknown, unknown])[] {
  try {
    const entries: (readonly [unknown, unknown])[] = []

    for (const [key, value] of Map.prototype.entries.call(source)) {
      entries.push([key, value])
    }

    return entries
  } catch {
    const data = readSnapshotData(source, "Map")
    const entries = assertDenseArray(data.entries, "Map snapshot entries")
    const parsed: (readonly [unknown, unknown])[] = []

    for (let index = 0; index < entries.length; index += 1) {
      const pair = assertDenseArray(entries[index], `Map snapshot entry at index ${index}`)

      if (pair.length !== 2) {
        throw new TypeError(`Map snapshot entry at index ${index} must contain two values`)
      }

      parsed.push([pair[0], pair[1]])
    }

    return parsed
  }
}

function readSetValues(source: Set<unknown>): readonly unknown[] {
  try {
    const values: unknown[] = []

    for (const value of Set.prototype.values.call(source)) {
      values.push(value)
    }

    return values
  } catch {
    const data = readSnapshotData(source, "Set")
    const values = assertDenseArray(data.values, "Set snapshot values")
    const parsed: unknown[] = []

    for (let index = 0; index < values.length; index += 1) {
      parsed.push(values[index])
    }

    return parsed
  }
}

function readRegExpState(source: RegExp): {
  readonly flags: string
  readonly lastIndex: number
  readonly source: string
} {
  try {
    const pattern = readBuiltInAccessor(RegExp.prototype, "source", source)
    const flags = readBuiltInAccessor(RegExp.prototype, "flags", source)

    if (typeof pattern !== "string" || typeof flags !== "string") {
      throw new TypeError("RegExp state is malformed")
    }

    return { flags, lastIndex: source.lastIndex, source: pattern }
  } catch {
    const data = readSnapshotData(source, "RegExp")

    if (
      typeof data.source !== "string" ||
      typeof data.flags !== "string" ||
      typeof data.lastIndex !== "number"
    ) {
      throw new TypeError("RegExp snapshot data is malformed")
    }

    return { flags: data.flags, lastIndex: data.lastIndex, source: data.source }
  }
}

function readBinaryBufferState(
  source: BinaryBuffer,
  kind: BinaryBufferKind,
): BinaryBufferSnapshotData {
  try {
    const prototype = kind === "ArrayBuffer" ? ArrayBuffer.prototype : SharedArrayBuffer.prototype
    const byteLength = readBuiltInAccessor(prototype, "byteLength", source)
    const maxByteLength = readBuiltInAccessor(prototype, "maxByteLength", source)
    const resizable = readBuiltInAccessor(
      prototype,
      kind === "ArrayBuffer" ? "resizable" : "growable",
      source,
    )

    if (
      typeof byteLength !== "number" ||
      typeof maxByteLength !== "number" ||
      typeof resizable !== "boolean"
    ) {
      throw new TypeError(`${kind} state is malformed`)
    }

    const bytes = new Uint8Array(byteLength)
    bytes.set(new Uint8Array(source))
    return { bytes, kind, maxByteLength, resizable }
  } catch {
    return parseBinaryBufferSnapshotData(readSnapshotData(source, kind), kind)
  }
}

function parseBinaryBufferSnapshotData(
  data: Record<PropertyKey, unknown>,
  kind: BinaryBufferKind,
): BinaryBufferSnapshotData {
  if (
    !(data.bytes instanceof Uint8Array) ||
    typeof data.maxByteLength !== "number" ||
    !Number.isSafeInteger(data.maxByteLength) ||
    data.maxByteLength < data.bytes.byteLength ||
    typeof data.resizable !== "boolean"
  ) {
    throw new TypeError(`${kind} snapshot data is malformed`)
  }

  let bytes: Uint8Array

  try {
    bytes = Uint8Array.prototype.slice.call(data.bytes) as Uint8Array
  } catch {
    throw new TypeError(`${kind} snapshot bytes are malformed`)
  }

  return {
    bytes,
    kind,
    maxByteLength: data.maxByteLength,
    resizable: data.resizable,
  }
}

function createBinaryBufferTarget(data: BinaryBufferSnapshotData): BinaryBuffer {
  const BufferConstructor = data.kind === "ArrayBuffer" ? ArrayBuffer : SharedArrayBuffer
  const args = data.resizable
    ? [data.bytes.byteLength, { maxByteLength: data.maxByteLength }]
    : [data.bytes.byteLength]
  const target = Reflect.construct(BufferConstructor, args) as BinaryBuffer
  new Uint8Array(target).set(data.bytes)
  return target
}

function readDataViewState(source: DataView): DataViewSnapshotData {
  try {
    const buffer = readBuiltInAccessor(DataView.prototype, "buffer", source)
    const byteLength = readBuiltInAccessor(DataView.prototype, "byteLength", source)
    const byteOffset = readBuiltInAccessor(DataView.prototype, "byteOffset", source)

    if (
      !(buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer) ||
      typeof byteLength !== "number" ||
      typeof byteOffset !== "number"
    ) {
      throw new TypeError("DataView state is malformed")
    }

    return { buffer, byteLength, byteOffset, kind: "DataView" }
  } catch {
    const data = readSnapshotData(source, "DataView")

    if (
      !(data.buffer instanceof ArrayBuffer || data.buffer instanceof SharedArrayBuffer) ||
      typeof data.byteLength !== "number" ||
      !Number.isSafeInteger(data.byteLength) ||
      data.byteLength < 0 ||
      typeof data.byteOffset !== "number" ||
      !Number.isSafeInteger(data.byteOffset) ||
      data.byteOffset < 0
    ) {
      throw new TypeError("DataView snapshot data is malformed")
    }

    return {
      buffer: data.buffer,
      byteLength: data.byteLength,
      byteOffset: data.byteOffset,
      kind: "DataView",
    }
  }
}

function getTypedArrayName(value: object): TypedArrayName | undefined {
  for (const name of Object.keys(TYPED_ARRAY_CONSTRUCTORS) as TypedArrayName[]) {
    if (value instanceof TYPED_ARRAY_CONSTRUCTORS[name]) {
      return name
    }
  }

  return undefined
}

function readTypedArrayState(
  source: SupportedTypedArray,
  name: TypedArrayName,
): TypedArraySnapshotData {
  try {
    const buffer = readBuiltInAccessor(TYPED_ARRAY_PROTOTYPE, "buffer", source)
    const byteOffset = readBuiltInAccessor(TYPED_ARRAY_PROTOTYPE, "byteOffset", source)
    const length = readBuiltInAccessor(TYPED_ARRAY_PROTOTYPE, "length", source)

    if (
      !(buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer) ||
      typeof byteOffset !== "number" ||
      typeof length !== "number"
    ) {
      throw new TypeError(`${name} state is malformed`)
    }

    return { buffer, byteOffset, kind: "TypedArray", length, name }
  } catch {
    const data = readSnapshotData(source, "TypedArray")

    if (
      data.name !== name ||
      !(data.buffer instanceof ArrayBuffer || data.buffer instanceof SharedArrayBuffer) ||
      typeof data.byteOffset !== "number" ||
      !Number.isSafeInteger(data.byteOffset) ||
      data.byteOffset < 0 ||
      typeof data.length !== "number" ||
      !Number.isSafeInteger(data.length) ||
      data.length < 0
    ) {
      throw new TypeError(`${name} snapshot data is malformed`)
    }

    return {
      buffer: data.buffer,
      byteOffset: data.byteOffset,
      kind: "TypedArray",
      length: data.length,
      name,
    }
  }
}

function createTypedArrayTarget(
  name: TypedArrayName,
  buffer: BinaryBuffer,
  byteOffset: number,
  length: number,
): SupportedTypedArray {
  const Constructor = TYPED_ARRAY_CONSTRUCTORS[name] as unknown as new (
    buffer: BinaryBuffer,
    byteOffset?: number,
    length?: number,
  ) => SupportedTypedArray
  return new Constructor(buffer, byteOffset, length)
}

function cloneTypedArrayTarget(
  source: SupportedTypedArray,
  name: TypedArrayName,
): SupportedTypedArray {
  const state = readTypedArrayState(source, name)
  const buffer = createBinaryBufferTarget(
    readBinaryBufferState(state.buffer, getBufferKind(state.buffer)),
  )
  const target = createTypedArrayTarget(name, buffer, state.byteOffset, state.length)
  Object.setPrototypeOf(target, Object.getPrototypeOf(source))
  return target
}

function readTypedArrayNumber(
  source: SupportedTypedArray,
  property: "byteOffset" | "length",
): number {
  const value = readBuiltInAccessor(TYPED_ARRAY_PROTOTYPE, property, source)

  if (typeof value !== "number") {
    throw new TypeError(`Typed array ${property} is malformed`)
  }

  return value
}

function getBufferKind(value: BinaryBuffer): BinaryBufferKind {
  return value instanceof ArrayBuffer ? "ArrayBuffer" : "SharedArrayBuffer"
}

function readBuiltInAccessor(prototype: object, property: PropertyKey, receiver: object): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, property)

  if (!descriptor?.get) {
    throw new TypeError(`${String(property)} accessor is unavailable`)
  }

  return Reflect.apply(descriptor.get, receiver, [])
}

function readProxyProperty(target: object, property: PropertyKey, receiver: object): unknown {
  try {
    return Reflect.get(target, property, receiver)
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error
    }

    return Reflect.get(target, property, target)
  }
}

function readSnapshotData(value: object, kind: string): Record<PropertyKey, unknown> {
  const data = Reflect.get(value, SNAPSHOT_DATA)

  if (!isRecord(data) || data.kind !== kind) {
    throw new TypeError(`${kind} snapshot data is malformed`)
  }

  return data
}

function createMapSnapshotData(target: Map<unknown, unknown>): Readonly<Record<string, unknown>> {
  const entries: (readonly [unknown, unknown])[] = []

  for (const [key, value] of Map.prototype.entries.call(target)) {
    entries.push(Object.freeze([key, value]))
  }

  return Object.freeze({ entries: Object.freeze(entries), kind: "Map" })
}

function createSetSnapshotData(target: Set<unknown>): Readonly<Record<string, unknown>> {
  const values: unknown[] = []

  for (const value of Set.prototype.values.call(target)) {
    values.push(value)
  }

  return Object.freeze({ kind: "Set", values: Object.freeze(values) })
}

function createRegExpSnapshotData(target: RegExp): Readonly<Record<string, unknown>> {
  return Object.freeze({
    flags: target.flags,
    kind: "RegExp",
    lastIndex: target.lastIndex,
    source: target.source,
  })
}

function isCanonicalArrayIndex(key: PropertyKey): boolean {
  if (typeof key !== "string" || key.length === 0) {
    return false
  }

  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === key
}

function isTypedArrayElementKey(key: PropertyKey): boolean {
  return isCanonicalArrayIndex(key)
}

function readSnapshotTypeName(tag: string): string {
  return tag.startsWith("[object ") && tag.endsWith("]") ? tag.slice(8, -1) : tag
}

function snapshotOwnProperties(
  source: object,
  target: object,
  snapshot: (value: unknown) => unknown,
  skip: ((key: PropertyKey) => boolean) | undefined = undefined,
): void {
  for (const key of Reflect.ownKeys(source)) {
    if (skip?.(key)) {
      continue
    }

    const descriptor = Object.getOwnPropertyDescriptor(source, key)

    if (!descriptor) {
      continue
    }

    if ("value" in descriptor) {
      Object.defineProperty(target, key, {
        ...descriptor,
        value: snapshot(descriptor.value),
      })
      continue
    }

    Object.defineProperty(target, key, {
      ...(descriptor.configurable !== undefined ? { configurable: descriptor.configurable } : {}),
      ...(descriptor.enumerable !== undefined ? { enumerable: descriptor.enumerable } : {}),
      ...(descriptor.get !== undefined ? { get: descriptor.get } : {}),
    })
  }
}

function rejectSnapshotMutation(): never {
  throw new TypeError("Cannot mutate a read-only snapshot")
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
