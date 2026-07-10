import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import type { BuildEmitContext, BuildTarget } from "./index.js"

/**
 * server.mjs lives at `<appRoot>/.dawn/build/server.mjs`, so the app root is
 * two directories up from the module's own location. Verified against
 * `buildDir = <appRoot>/.dawn/build`.
 */
const SERVER_ENTRY = `import { serveRuntime } from "@dawn-ai/cli"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

// server.mjs lives at <appRoot>/.dawn/build/server.mjs → appRoot is two dirs up
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

await serveRuntime({ appRoot })
`

/**
 * Hardened production Dockerfile.
 *
 * Circular-build decision: we deliberately do NOT `RUN npx dawn build` inside
 * the image. The host already ran `dawn build` to produce this Dockerfile (and
 * therefore a fresh `.dawn/build/`), and `COPY . .` brings that prebuilt output
 * — including `server.mjs` — into the image. Running the build again in-image
 * would (a) require the `dawn` CLI, which is typically a devDependency and thus
 * absent after `npm ci --omit=dev`, and (b) needlessly re-run typegen against
 * the copied context. Relying on the copied `.dawn/build/` is both simpler and
 * avoids any risk of recursive re-emission.
 */
const DOCKERFILE = `# syntax=docker/dockerfile:1
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
# .dawn/build/ (incl. server.mjs) is copied from the host build context above;
# no in-image \`dawn build\` needed. See node.ts for the rationale.
RUN chown -R 1000:1000 /app/.dawn
USER 1000:1000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \\
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", ".dawn/build/server.mjs"]
`

/**
 * The Node/Docker deploy target. Emits a runnable `server.mjs` entry (which
 * boots {@link serveRuntime}) and a hardened `Dockerfile`.
 */
export const nodeTarget: BuildTarget = {
  name: "node",
  async emit({ appRoot, buildDir }: BuildEmitContext) {
    const artifacts: string[] = []

    const serverPath = join(buildDir, "server.mjs")
    await writeFile(serverPath, SERVER_ENTRY, "utf8")
    artifacts.push(serverPath)

    // Never clobber a user's Dockerfile: only write to the app root if none
    // exists there; otherwise emit into the build dir.
    const appRootDockerfile = resolve(appRoot, "Dockerfile")
    const dockerfilePath = existsSync(appRootDockerfile)
      ? join(buildDir, "Dockerfile")
      : appRootDockerfile
    await writeFile(dockerfilePath, DOCKERFILE, "utf8")
    artifacts.push(dockerfilePath)

    return { artifacts }
  },
}
