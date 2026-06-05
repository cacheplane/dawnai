import { LLMock } from "@copilotkit/aimock"
import type { AimockFixture } from "./fixture-builder.js"

export interface AimockHandle {
  readonly port: number
  /** Base URL with the `/v1` suffix the OpenAI SDK expects. */
  readonly baseUrl: string
  stop(): Promise<void>
}

export async function startAimock(opts: {
  readonly fixtures: readonly AimockFixture[]
}): Promise<AimockHandle> {
  const mock = new LLMock({ port: 0, chunkSize: 4096 })
  if (opts.fixtures.length > 0) {
    mock.addFixturesFromJSON(opts.fixtures as never)
  }
  await mock.start()
  let stopped = false
  return {
    port: mock.port,
    baseUrl: `${mock.url}/v1`,
    async stop() {
      if (stopped) return
      stopped = true
      await mock.stop()
    },
  }
}
