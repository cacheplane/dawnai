import { LLMock } from "@copilotkit/aimock"
import type { AimockFixture } from "./fixture-builder.js"

export interface Aimock {
  readonly port: number
  /** Base URL with the `/v1` suffix the OpenAI SDK expects. */
  readonly baseUrl: string
  /** Append more fixtures onto the live mock without restarting it. */
  addFixtures(fixtures: readonly AimockFixture[]): void
  /** Remove all registered fixtures (the mock keeps running). */
  clearFixtures(): void
  /** All requests the mock has received (aimock's journal). */
  getRequests(): ReadonlyArray<{
    body: { messages?: Array<{ role: string; content: unknown }> } | null
  }>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export async function createAimock(opts: {
  readonly fixtures: readonly AimockFixture[]
  /** When set, proxy unmatched requests to the given upstream providers. */
  readonly proxy?: { openai: string }
}): Promise<Aimock> {
  const mock = new LLMock(
    opts.proxy
      ? {
          port: 0,
          chunkSize: 4096,
          record: { providers: { openai: opts.proxy.openai }, proxyOnly: true },
        }
      : { port: 0, chunkSize: 4096 },
  )
  if (opts.fixtures.length > 0) {
    mock.addFixturesFromJSON(opts.fixtures as never)
  }
  await mock.start()
  let stopped = false
  const handle: Aimock = {
    port: mock.port,
    baseUrl: `${mock.url}/v1`,
    addFixtures(fixtures: readonly AimockFixture[]) {
      if (fixtures.length > 0) {
        mock.addFixturesFromJSON(fixtures as never)
      }
    },
    clearFixtures() {
      mock.clearFixtures()
    },
    getRequests() {
      return mock.getRequests() as ReadonlyArray<{
        body: { messages?: Array<{ role: string; content: unknown }> } | null
      }>
    },
    async close() {
      if (stopped) return
      stopped = true
      await mock.stop()
    },
    [Symbol.asyncDispose](): Promise<void> {
      return this.close()
    },
  }
  return handle
}
