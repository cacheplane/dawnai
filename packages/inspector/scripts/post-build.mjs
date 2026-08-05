// Standalone output does not include static assets — copy them in, per Next docs.
import { cpSync, existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const pkg = fileURLToPath(new URL("..", import.meta.url))
const appDirInStandalone = join(pkg, ".next/standalone/packages/inspector")
if (!existsSync(appDirInStandalone)) {
  throw new Error(`post-build: ${appDirInStandalone} missing — did outputFileTracingRoot change?`)
}
cpSync(join(pkg, ".next/static"), join(appDirInStandalone, ".next/static"), { recursive: true })
if (existsSync(join(pkg, "public"))) {
  cpSync(join(pkg, "public"), join(appDirInStandalone, "public"), { recursive: true })
}
console.log("[post-build] static assets copied into standalone bundle")
