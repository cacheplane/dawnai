import type { IncomingMessage } from "node:http"

export function parseHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers[key] = value
    } else if (Array.isArray(value)) {
      headers[key] = value.join(", ")
    }
  }
  return headers
}

export function extractRouteParams(routeId: string, input: unknown): Record<string, string> {
  const params: Record<string, string> = {}
  const matches = routeId.matchAll(/\[(\w+)\]/g)
  const inputRecord = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >

  for (const match of matches) {
    const name = match[1]
    if (name && name in inputRecord) {
      params[name] = String(inputRecord[name])
    }
  }

  return params
}
