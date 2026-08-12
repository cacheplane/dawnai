import { join, resolve } from "node:path"

export const WEB_CONTENT_ROOT_ENV = "DAWN_WEB_CONTENT_ROOT"

export function resolveWebContentRoot(cwd: string, override?: string): string {
  return override ? resolve(override) : join(cwd, "content")
}

export function webContentRoot(): string {
  return resolveWebContentRoot(process.cwd(), process.env[WEB_CONTENT_ROOT_ENV])
}
