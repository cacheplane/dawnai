import { neutralButton } from "./ui"

export interface ConnectScreenProps {
  /**
   * The URL this client proxies to by default. Not read from an env var
   * here — `DAWN_SERVER_URL` is server-side only (`api/copilotkit/[...path]/route.ts`,
   * `api/dawn/[...path]/route.ts`), and a client component cannot read it.
   * The app has no `NEXT_PUBLIC_` twin for it, and adding one just to label
   * this screen would be a second source of truth that can drift from the
   * real one — so the caller passes the same default those routes fall back
   * to, and the copy below leads with that being a default, not a diagnosis
   * of what is actually configured.
   */
  readonly serverUrl: string
  /**
   * Re-probe now, instead of waiting for `AppShell`'s poll. The probe can
   * genuinely succeed and clear this screen without a reload — unlike the
   * predicate this replaced (`useCopilotKit().runtimeConnectionStatus`,
   * which latches on `"error"` with no way back) — so a button here is a
   * real shortcut for someone who just started the server, not a decoration
   * in front of a reload instruction.
   */
  readonly onRetry: () => void
}

/** Exported so `ConnectScreen.test.tsx` asserts against the same string this renders, not a copy of it. */
export const CONNECT_SCREEN_HEADING = "Can’t reach the Dawn server"

/**
 * Full-viewport first impression for "the Dawn server is not running yet".
 *
 * Without this, the likeliest first run of this example — open the web app
 * before the agent server — showed an empty workbench and, on send, a run
 * error row that names a CopilotKit error code, not "start the server". This
 * is surface 1 — see the error-surface note at the top of `AppShell.tsx` for
 * why it replaces the whole shell instead of sharing the transcript with the
 * `RunError` row.
 *
 * Pure props, no CopilotKit import: `AppShell.test.tsx` covers the polling
 * predicate against a fake `fetch`; this file's own test renders it
 * standalone with `renderToStaticMarkup`.
 */
export function ConnectScreen({ serverUrl, onRetry }: ConnectScreenProps) {
  return (
    <div className="flex h-dvh items-center justify-center bg-wb-bg px-6">
      <div className="max-w-md text-center">
        <span className="wb-brand-mark text-[15px] font-semibold tracking-tight">
          Dawn research
        </span>
        <h1 className="mt-6 text-xl font-semibold tracking-tight">{CONNECT_SCREEN_HEADING}</h1>
        <p className="mt-3 text-sm leading-6 text-wb-muted">
          If you haven&rsquo;t set <code className="text-[13px]">DAWN_SERVER_URL</code>, this client
          proxies to{" "}
          <code className="rounded-wb border border-wb-border bg-wb-surface px-1.5 py-0.5 text-[13px]">
            {serverUrl}
          </code>
          , and nothing there answered.
        </p>
        <p className="mt-6 text-sm leading-6 text-wb-muted">Start it from the app root:</p>
        <pre className="mt-2 overflow-x-auto rounded-wb border border-wb-border bg-wb-surface px-3.5 py-3 text-left text-[13px] leading-5">
          <code>{"cp server/.env.example server/.env\nnpm run dev:server"}</code>
        </pre>
        <p className="mt-6 text-sm leading-6 text-wb-muted">
          Set a real <code className="text-[13px]">OPENAI_API_KEY</code> in that{" "}
          <code className="text-[13px]">server/.env</code> — there is no keyless demo mode.
        </p>
        <button type="button" onClick={onRetry} className={`${neutralButton("md")} mt-8`}>
          Try again
        </button>
      </div>
    </div>
  )
}
