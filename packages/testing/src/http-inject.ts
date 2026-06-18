import type { IncomingMessage, ServerResponse } from "node:http"
import { createRuntimeRequestListener } from "@dawn-ai/cli/runtime"

// light-my-request uses `export =` which conflicts with exactOptionalPropertyTypes.
// We import at runtime and type the minimal surface we need.
// biome-ignore lint/suspicious/noExplicitAny: third-party CJS-interop boundary
const lmr = (await import("light-my-request")) as any

type LmrInjectFn = (
  dispatch: (req: IncomingMessage, res: ServerResponse) => void,
  opts: {
    method: string
    url: string
    headers?: Record<string, string>
    payload?: string
  },
) => Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }>

const lmrInject: LmrInjectFn = lmr.default ?? lmr

export interface InjectResult {
  readonly statusCode: number
  readonly body: string
  readonly headers: Record<string, unknown>
}

export interface AgentProtocolInjector {
  inject(opts: {
    method: string
    url: string
    payload?: unknown
    headers?: Record<string, string>
  }): Promise<InjectResult>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export async function createAgentProtocolInjector(options: {
  appRoot: string
}): Promise<AgentProtocolInjector> {
  const { listener, close } = await createRuntimeRequestListener({ appRoot: options.appRoot })

  const injector: AgentProtocolInjector = {
    async inject(opts) {
      const res = await lmrInject(listener, {
        method: opts.method,
        url: opts.url,
        headers: { "content-type": "application/json", ...opts.headers },
        ...(opts.payload !== undefined ? { payload: JSON.stringify(opts.payload) } : {}),
      })
      return {
        statusCode: res.statusCode,
        body: res.body,
        headers: res.headers,
      }
    },
    close,
    [Symbol.asyncDispose](): Promise<void> {
      return this.close()
    },
  }
  return injector
}
