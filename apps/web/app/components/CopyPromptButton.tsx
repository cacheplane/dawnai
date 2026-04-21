"use client"

import { useState } from "react"

const DAWN_AGENT_PROMPT = `I want to build an AI agent using Dawn — a TypeScript-first framework for graph-based AI systems with the ergonomics of Next.js. Please help me:

1. Scaffold a new Dawn app:
   \`\`\`
   npx create-dawn-app my-agent
   cd my-agent
   pnpm install
   \`\`\`

2. Walk me through the \`src/app/\` structure. Routes are directories with an \`index.ts\` that exports one of: \`workflow\` (async function), \`graph\` (LangGraph graph), or \`chain\` (LangChain LCEL Runnable). State types live in \`state.ts\`. Tools live in a \`tools/\` directory and their input/output types are auto-generated into \`dawn.generated.d.ts\` via the TypeScript compiler API — no manual Zod schemas, no type wiring.

3. Build a route from the template. Explain dynamic segments (\`[tenant]\`), route groups (\`(public)\`), and co-located tools. Route pathnames are computed from the filesystem path, excluding route groups.

4. Show me how to run a route end-to-end:
   - \`dawn run '/hello/acme'\` — single invocation with JSON stdin/stdout
   - \`dawn dev\` — local dev server with hot reload, speaks the LangGraph Platform protocol natively (\`/runs/wait\`, \`/runs/stream\`, \`assistant_id\`)
   - \`dawn test\` — run colocated \`run.test.ts\` scenarios
   - \`dawn check\`, \`dawn routes\`, \`dawn typegen\` — validate and inspect

5. Then help me add a new route with its own tool, wire it up, and iterate.

Key Dawn packages: \`@dawn/sdk\` (backend-neutral contract), \`@dawn/langgraph\` (LangGraph adapter), \`@dawn/langchain\` (LCEL adapter), \`@dawn/cli\` (the CLI).

Reference: https://github.com/cacheplane/dawnai`

export function CopyPromptButton() {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(DAWN_AGENT_PROMPT)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable — silent no-op
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="px-6 py-2.5 bg-accent-amber text-bg-primary rounded-md text-sm font-semibold hover:bg-accent-amber-deep transition-colors inline-flex items-center gap-2"
      aria-label="Copy agent-ready prompt for getting started with Dawn"
    >
      {copied ? (
        <>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            role="img"
          >
            <title>Copied</title>
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            role="img"
          >
            <title>Copy</title>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          Copy prompt
        </>
      )}
    </button>
  )
}
