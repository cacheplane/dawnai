# @dawn-ai/inspector

Dawn runtime inspector — a browser UI for inspecting a Dawn app, starting with its
long-term memory store. The inspector's Next.js server loads the app's
`dawn.config.ts` at runtime (via `loadDawnConfig` from `@dawn-ai/core`) and serves
the app's LIVE `config.memory.store`.

Run against an app by pointing `DAWN_APP_ROOT` at the app directory and starting
the packaged standalone server (`.next/standalone/packages/inspector/server.js`).
