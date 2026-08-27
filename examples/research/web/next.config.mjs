// CopilotKit's runtime builds a telemetry client at module scope and decides
// whether to send from `process.env` inside that constructor. ESM evaluates
// imports before the importing module's body, so setting this in the route
// handler would be too late — it has to be in place before anything imports
// `@copilotkit/runtime`, and `next.config.mjs` is the first thing Next
// evaluates for both `next build` and `next dev`/`next start`.
//
// Without it, a bare `next build` POSTs to https://telemetry.copilotkit.ai/ingest
// while collecting page data. `??=` so anyone who wants it on can still opt in.
process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true"

/** @type {import('next').NextConfig} */
const nextConfig = {
  agentRules: false,
  experimental: { useTypeScriptCli: true },
}
export default nextConfig
