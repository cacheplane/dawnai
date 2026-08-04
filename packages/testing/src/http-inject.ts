import { createRuntimeFetchHandler } from "@dawn-ai/cli/runtime"

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
  const core = await createRuntimeFetchHandler({ appRoot: options.appRoot })

  const injector: AgentProtocolInjector = {
    async inject(opts) {
      const requestHeaders = new Headers({
        "content-type": "application/json",
        ...opts.headers,
      })
      const request = new Request(new URL(opts.url, "http://localhost"), {
        headers: requestHeaders,
        method: opts.method,
        ...(opts.payload !== undefined ? { body: JSON.stringify(opts.payload) } : {}),
      })

      const response = await core.fetch(request)
      // Read the (possibly SSE) body to completion — the harness's `inject`
      // contract is synchronous-style, matching the pre-refactor
      // light-my-request behavior of returning the fully buffered body.
      const body = await response.text()

      const headers: Record<string, unknown> = {}
      for (const [key, value] of response.headers) {
        // `getSetCookie` preserves multiple Set-Cookie headers, which
        // `Headers` iteration would otherwise join into one comma-separated
        // value.
        if (key.toLowerCase() === "set-cookie") continue
        headers[key] = value
      }
      const setCookie = response.headers.getSetCookie?.() ?? []
      if (setCookie.length > 0) headers["set-cookie"] = setCookie

      return {
        body,
        headers,
        statusCode: response.status,
      }
    },
    close: core.close,
    [Symbol.asyncDispose](): Promise<void> {
      return this.close()
    },
  }
  return injector
}
