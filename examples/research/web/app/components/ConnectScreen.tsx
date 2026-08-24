export interface ConnectScreenProps {
  /**
   * The URL this client is (or would be) proxying to. Not read from an env
   * var here — `DAWN_SERVER_URL` is server-side only (`api/copilotkit/route.ts`,
   * `api/dawn/[...path]/route.ts`), and a client component cannot read it. The
   * app has no `NEXT_PUBLIC_` twin for it, and adding one just to label this
   * screen would be a second source of truth that can drift from the real
   * one — so the caller passes the same default those routes fall back to,
   * and the copy below is honest about it being a default rather than a
   * confirmed value.
   */
  readonly serverUrl: string
}

/**
 * Full-viewport first impression for "the Dawn server is not running yet".
 *
 * Without this, the likeliest first run of this example — open the web app
 * before the agent server — showed an empty workbench and, on send, a run
 * error row that names a CopilotKit error code, not "start the server". This
 * replaces the whole shell (see `AppShell`) rather than living inside the
 * transcript: `RunError` stays for a transient failure mid-conversation,
 * where the conversation above it is still real. Here there is no
 * conversation to show — nothing in the shell works — so the guidance gets
 * the full screen instead of competing with a rail and an empty transcript
 * for attention.
 *
 * Pure props, no CopilotKit import: `AppShell.test.tsx` covers the connection
 * predicate against a fake; this file's own test renders it standalone with
 * `renderToStaticMarkup`.
 */
export function ConnectScreen({ serverUrl }: ConnectScreenProps) {
  return (
    <div className="flex h-dvh items-center justify-center bg-wb-bg px-6">
      <div className="max-w-md text-center">
        <span className="wb-brand-mark text-[15px] font-semibold tracking-tight">
          Dawn research
        </span>
        <h1 className="mt-6 text-xl font-semibold tracking-tight">Can’t reach the Dawn server</h1>
        <p className="mt-3 text-sm leading-6 text-wb-muted">
          This client expects the research agent at{" "}
          <code className="rounded-wb border border-wb-border bg-wb-surface px-1.5 py-0.5 text-[13px]">
            {serverUrl}
          </code>{" "}
          (the default; set <code className="text-[13px]">DAWN_SERVER_URL</code> in{" "}
          <code className="text-[13px]">web/.env</code> if yours listens elsewhere) and nothing
          answered.
        </p>
        <p className="mt-6 text-sm leading-6 text-wb-muted">
          Start it from <code className="text-[13px]">examples/research</code>:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-wb border border-wb-border bg-wb-surface px-3.5 py-3 text-left text-[13px] leading-5">
          <code>pnpm dev</code>
        </pre>
        <p className="mt-6 text-sm leading-6 text-wb-muted">
          It needs a real <code className="text-[13px]">OPENAI_API_KEY</code> in{" "}
          <code className="text-[13px]">server/.env</code> — there is no keyless demo mode.
        </p>
      </div>
    </div>
  )
}
