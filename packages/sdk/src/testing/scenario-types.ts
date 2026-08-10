import type { RuntimeExecutionResult } from "../runtime-result.js"
import type { RuntimeErrorExpectation, RuntimeMetaExpectation } from "./index.js"

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T

export interface ScenarioToolMockDescriptor {
  readonly implementation: (input: unknown) => unknown
  readonly name: string
}

export interface ScenarioToolCallRecord {
  readonly args: unknown
  readonly name: string
  readonly sequence: number
}

export interface ScenarioToolCallExpectationDescriptor {
  readonly argumentMatchers: readonly unknown[]
  readonly count?:
    | { readonly kind: "at-least"; readonly value: 1 }
    | { readonly kind: "exact"; readonly value: number }
  readonly name: string
}

export interface ScenarioDescriptor {
  readonly assert?: (result: RuntimeExecutionResult) => unknown | Promise<unknown>
  readonly execution: "in-process" | { readonly serverUrl: string }
  readonly expectedError?: RuntimeErrorExpectation
  readonly expectedMeta?: RuntimeMetaExpectation
  readonly expectedOutput?: unknown
  readonly expectedStatus: "failed" | "passed"
  readonly input: unknown
  readonly name: string
  readonly toolCallExpectations: readonly ScenarioToolCallExpectationDescriptor[]
  readonly toolMocks: readonly ScenarioToolMockDescriptor[]
}

export interface ScenarioSuiteDescriptor {
  readonly route: string
  readonly scenarios: readonly ScenarioDescriptor[]
}

type NoMethods = Record<never, never>

type ToolName<TTools> = Extract<
  {
    [K in keyof TTools]: TTools[K] extends (...args: never[]) => unknown ? K : never
  }[keyof TTools],
  string
>

type MockFor<T> = T extends (...args: infer TArgs) => infer TResult
  ? (...args: TArgs) => Awaited<TResult> | Promise<Awaited<TResult>>
  : never

type ToolArgs<T> = T extends (...args: infer TArgs) => unknown ? TArgs : never
type FirstArg<T> = ToolArgs<T>[0]
type HasArgs<T> = ToolArgs<T> extends [] ? false : true
type PartialFirstArg<T> = DeepPartial<FirstArg<T>>

declare const scenarioCompletion: unique symbol
declare const toolCallExpectationCompletion: unique symbol

interface CompletedScenarioBuilder {
  readonly [scenarioCompletion]: true
}

interface CompletedToolCallExpectationBuilder {
  readonly [toolCallExpectationCompletion]: true
}

type ScenarioCompletionMarker<
  TInputSet extends boolean,
  TStatus extends "failed" | "passed" | "unset",
> = TInputSet extends true
  ? TStatus extends "unset"
    ? NoMethods
    : CompletedScenarioBuilder
  : NoMethods

type ToolCallExpectationCompletionMarker<THasAssertion extends boolean> = THasAssertion extends true
  ? CompletedToolCallExpectationBuilder
  : NoMethods

type ToolCallCountMethods<
  TTool,
  TCountSet extends boolean,
  THasArgumentMatcher extends boolean,
> = TCountSet extends true
  ? NoMethods
  : {
      called(): ToolCallExpectationBuilder<TTool, true, true, THasArgumentMatcher, false>
      calledOnce(): ToolCallExpectationBuilder<TTool, true, true, THasArgumentMatcher, false>
      calledTimes(
        count: number,
      ): ToolCallExpectationBuilder<TTool, true, true, THasArgumentMatcher, false>
    } & (THasArgumentMatcher extends true
      ? NoMethods
      : {
          notCalled(): ToolCallExpectationBuilder<TTool, true, true, false, true>
        })

type ToolCallArgumentMethods<TTool, TCountSet extends boolean, TNotCalled extends boolean> =
  HasArgs<TTool> extends true
    ? TNotCalled extends true
      ? NoMethods
      : {
          withArgs(
            value: PartialFirstArg<TTool>,
          ): ToolCallExpectationBuilder<TTool, true, TCountSet, true, false>
        }
    : NoMethods

type ToolCallExpectationBuilder<
  TTool,
  THasAssertion extends boolean = false,
  TCountSet extends boolean = false,
  THasArgumentMatcher extends boolean = false,
  TNotCalled extends boolean = false,
> = ToolCallCountMethods<TTool, TCountSet, THasArgumentMatcher> &
  ToolCallArgumentMethods<TTool, TCountSet, TNotCalled> &
  ToolCallExpectationCompletionMarker<THasAssertion>

type ScenarioCommonMethods<
  TTools,
  TInputSet extends boolean,
  TStatus extends "failed" | "passed" | "unset",
  TExecution extends "in-process" | "mocked" | "server",
  TMocked extends ToolName<TTools>,
> = {
  assert(
    callback: (result: RuntimeExecutionResult) => unknown | Promise<unknown>,
  ): ScenarioBuilder<TTools, TInputSet, TStatus, TExecution, TMocked>
  expectMeta(
    expectation: RuntimeMetaExpectation,
  ): ScenarioBuilder<TTools, TInputSet, TStatus, TExecution, TMocked>
}

type ScenarioInputMethods<
  TTools,
  TInputSet extends boolean,
  TStatus extends "failed" | "passed" | "unset",
  TExecution extends "in-process" | "mocked" | "server",
  TMocked extends ToolName<TTools>,
> = TInputSet extends true
  ? NoMethods
  : {
      input(value: unknown): ScenarioBuilder<TTools, true, TStatus, TExecution, TMocked>
    }

type ScenarioStatusMethods<
  TTools,
  TInputSet extends boolean,
  TStatus extends "failed" | "passed" | "unset",
  TExecution extends "in-process" | "mocked" | "server",
  TMocked extends ToolName<TTools>,
> = TStatus extends "unset"
  ? {
      expectFailed(): ScenarioBuilder<TTools, TInputSet, "failed", TExecution, TMocked>
      expectPassed(): ScenarioBuilder<TTools, TInputSet, "passed", TExecution, TMocked>
    }
  : NoMethods

type ScenarioExecutionMethods<
  TTools,
  TInputSet extends boolean,
  TStatus extends "failed" | "passed" | "unset",
  TExecution extends "in-process" | "mocked" | "server",
  TMocked extends ToolName<TTools>,
> = (TExecution extends "server"
  ? NoMethods
  : {
      mockTool<K extends Exclude<ToolName<TTools>, TMocked>>(
        name: K,
        implementation: MockFor<TTools[K]>,
      ): ScenarioBuilder<TTools, TInputSet, TStatus, "mocked", TMocked | K>
    }) &
  (TExecution extends "in-process"
    ? {
        server(url: string): ScenarioBuilder<TTools, TInputSet, TStatus, "server", TMocked>
      }
    : NoMethods)

type ScenarioExpectationMethods<
  TTools,
  TInputSet extends boolean,
  TStatus extends "failed" | "passed" | "unset",
  TExecution extends "in-process" | "mocked" | "server",
  TMocked extends ToolName<TTools>,
> = (TStatus extends "passed"
  ? {
      expectOutput(
        expectation: unknown,
      ): ScenarioBuilder<TTools, TInputSet, TStatus, TExecution, TMocked>
    }
  : NoMethods) &
  (TStatus extends "failed"
    ? {
        expectError(
          expectation: RuntimeErrorExpectation,
        ): ScenarioBuilder<TTools, TInputSet, TStatus, TExecution, TMocked>
      }
    : NoMethods) &
  (TExecution extends "server"
    ? NoMethods
    : [TMocked] extends [never]
      ? NoMethods
      : {
          expectTool<K extends TMocked>(
            name: K,
            configure: (
              call: ToolCallExpectationBuilder<TTools[K]>,
            ) => CompletedToolCallExpectationBuilder,
          ): ScenarioBuilder<TTools, TInputSet, TStatus, TExecution, TMocked>
        })

export type ScenarioBuilder<
  TTools,
  TInputSet extends boolean = false,
  TStatus extends "failed" | "passed" | "unset" = "unset",
  TExecution extends "in-process" | "mocked" | "server" = "in-process",
  TMocked extends ToolName<TTools> = never,
> = ScenarioCommonMethods<TTools, TInputSet, TStatus, TExecution, TMocked> &
  ScenarioInputMethods<TTools, TInputSet, TStatus, TExecution, TMocked> &
  ScenarioStatusMethods<TTools, TInputSet, TStatus, TExecution, TMocked> &
  ScenarioExecutionMethods<TTools, TInputSet, TStatus, TExecution, TMocked> &
  ScenarioExpectationMethods<TTools, TInputSet, TStatus, TExecution, TMocked> &
  ScenarioCompletionMarker<TInputSet, TStatus>

export interface ScenarioSuiteBuilder<TTools> {
  scenario(
    name: string,
    configure: (builder: ScenarioBuilder<TTools>) => CompletedScenarioBuilder,
  ): ScenarioSuiteBuilder<TTools>
}
