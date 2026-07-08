# Chat UI on CopilotKit (AG-UI) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Rebuild `examples/chat/web` as a CopilotKit v2 app that connects to the Dawn chat server over AG-UI (`POST /agui/{routeId}`), replacing the throwaway hand-rolled SSE UI — the canonical "web client → Dawn" reference.

**Architecture:** Next.js App Router. A `/api/copilotkit` route hosts a `CopilotRuntime` registering an `HttpAgent` pointed at Dawn's `/agui/<chat>` endpoint; the page uses `@copilotkit/react-core/v2` (`CopilotKitProvider` + `CopilotSidebar`) with thin Dawn wrappers (`PermissionInterrupt` via `useInterrupt`, `TodosPanel` via `useCoAgent`). Runs live (no aimock); the deterministic connection proof is PR #322's `/agui` e2e.

**Tech stack:** Next 16, React 19, `@copilotkit/react-core`+`react-ui`+`runtime` (^1.62.2, v2 API), `@ag-ui/client` 0.0.57.

**Base:** `blove/ag-ui-capability` (PR #322). Spec: `docs/superpowers/specs/2026-07-07-chat-copilotkit-web-design.md`.

**Verification constraint:** No `OPENAI_API_KEY` is available in the build environment, so automated verification is `pnpm install` + `turbo build` + `typecheck` only. Runtime behavior (streaming, todos, approve/deny) is a **documented live smoke the maintainer runs** with a key. Do NOT claim runtime works from typecheck alone.

---

## Task 1: Dependencies, cleanup, layout

**Files:**
- Modify: `examples/chat/web/package.json`, `examples/chat/web/app/layout.tsx`
- Delete: `examples/chat/web/app/page.tsx`, `examples/chat/web/app/api/chat/route.ts`, `examples/chat/web/app/api/permission-resume/route.ts` (and empty dirs)

- [ ] **Step 1: Update `package.json` dependencies.** Set `dependencies` to:
```json
"dependencies": {
  "@ag-ui/client": "0.0.57",
  "@copilotkit/react-core": "^1.62.2",
  "@copilotkit/react-ui": "^1.62.2",
  "@copilotkit/runtime": "^1.62.2",
  "next": "16.2.9",
  "react": "19.2.7",
  "react-dom": "19.2.7"
}
```
Keep `devDependencies`, `scripts`, `name`, `type` unchanged.

- [ ] **Step 2: Delete the throwaway files.**
```bash
cd examples/chat/web
rm app/page.tsx app/api/chat/route.ts app/api/permission-resume/route.ts
rmdir app/api/chat app/api/permission-resume 2>/dev/null || true
```

- [ ] **Step 3: Import CopilotKit styles in `app/layout.tsx`.** Replace file contents with:
```tsx
import type { ReactNode } from "react"
import "@copilotkit/react-ui/styles.css"

export const metadata = { title: "Dawn chat — CopilotKit + AG-UI" }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  )
}
```

- [ ] **Step 4: Install.** From repo root: `pnpm install`. Expected: resolves the CopilotKit + `@ag-ui/client` packages, links the workspace. If any `@copilotkit/*@^1.62.2` version is unavailable, run `npm view @copilotkit/react-core version` and pin all three to the actual current `1.62.x` (report the version used).

- [ ] **Step 5: Commit.**
```bash
git add examples/chat/web/package.json examples/chat/web/app/layout.tsx pnpm-lock.yaml
git commit -m "chore(chat-web): add CopilotKit v2 deps, drop hand-rolled SSE UI"
```

---

## Task 2: CopilotKit runtime route

**Files:** Create `examples/chat/web/app/api/copilotkit/route.ts`

- [ ] **Step 1: Verify the runtime API against installed types.** Read `examples/chat/web/node_modules/@copilotkit/runtime/dist` (or its `package.json` `exports`/`.d.ts`) to confirm `CopilotRuntime`, `ExperimentalEmptyAdapter`, and `copilotRuntimeNextJSAppRouterEndpoint` are exported from the package root. Confirm `HttpAgent` is exported from `@ag-ui/client`. If `ExperimentalEmptyAdapter` isn't at the root, find the correct empty/passthrough adapter export and use it (report the deviation).

- [ ] **Step 2: Write `app/api/copilotkit/route.ts`:**
```ts
import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime"
import { HttpAgent } from "@ag-ui/client"
import type { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const dawnUrl = process.env.DAWN_SERVER_URL ?? "http://127.0.0.1:3001"
const agUiUrl = `${dawnUrl}/agui/${encodeURIComponent("/chat#agent")}`

const copilotRuntime = new CopilotRuntime({
  agents: { chat: new HttpAgent({ url: agUiUrl }) },
})

export const POST = async (req: NextRequest): Promise<Response> => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime: copilotRuntime,
    serviceAdapter: new ExperimentalEmptyAdapter(),
    endpoint: "/api/copilotkit",
  })
  return handleRequest(req)
}
```

- [ ] **Step 3: Typecheck.** `pnpm --filter @dawn-example/chat-web typecheck`. Fix any signature mismatch against the real installed types (adapt to reality; report deviations). Expected: exit 0.

- [ ] **Step 4: Commit.**
```bash
git add examples/chat/web/app/api/copilotkit/route.ts
git commit -m "feat(chat-web): CopilotKit runtime route → Dawn /agui HttpAgent"
```

---

## Task 3: Page + Dawn wrapper components

**Files:** Create `examples/chat/web/app/page.tsx`, `app/components/PermissionInterrupt.tsx`, `app/components/TodosPanel.tsx`

- [ ] **Step 1: Verify v2 hook/exports.** Read the installed `@copilotkit/react-core` `package.json` `exports` and the `./v2` `.d.ts` to confirm `CopilotKitProvider`, `useInterrupt`, `useCoAgent` are exported from `@copilotkit/react-core/v2`, and `CopilotSidebar` from `@copilotkit/react-ui` (or its `/v2`). Confirm the `useInterrupt` render callback signature (`{ event, resolve }`) and `useCoAgent` return (`{ state }`). Adapt imports to the real subpaths; report what you used.

- [ ] **Step 2: Write `app/components/TodosPanel.tsx`:**
```tsx
"use client"
import { useCoAgent } from "@copilotkit/react-core/v2"

type Todo = { content?: string; status?: string }
type ChatState = { todos?: Todo[] }

export function TodosPanel() {
  const { state } = useCoAgent<ChatState>({ name: "chat", initialState: {} })
  const todos = state?.todos ?? []
  if (todos.length === 0) return null
  return (
    <aside style={{ padding: 16, borderRight: "1px solid #eee", minWidth: 240 }}>
      <h2 style={{ fontSize: 14, textTransform: "uppercase", color: "#666" }}>Plan</h2>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {todos.map((t, i) => (
          <li key={i} style={{ padding: "4px 0" }}>
            <span>{t.status === "completed" ? "☑" : "☐"}</span> {t.content ?? ""}
          </li>
        ))}
      </ul>
    </aside>
  )
}
```

- [ ] **Step 3: Write `app/components/PermissionInterrupt.tsx`.** Dawn emits `CUSTOM{ name:"on_interrupt", value }` where `value` is the interrupt data (may include `interruptId`, `kind`, `detail`). Resume rides on `forwardedProps.command.resume` — `resolve(payload)` sets it; `mapRunInput` accepts `{ decision, interruptId? }`. So resolve with a decision object.
```tsx
"use client"
import { useInterrupt } from "@copilotkit/react-core/v2"

type InterruptValue = { interruptId?: string; kind?: string; detail?: unknown }

export function PermissionInterrupt() {
  useInterrupt({
    render: ({ event, resolve }: { event: { value?: InterruptValue }; resolve: (r: unknown) => void }) => {
      const value = event?.value ?? {}
      const interruptId = value.interruptId
      const decide = (decision: "once" | "always" | "deny") =>
        resolve(interruptId ? { decision, interruptId } : { decision })
      return (
        <div style={{ border: "1px solid #f0c000", background: "#fffbe6", borderRadius: 8, padding: 12, margin: "8px 0" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Permission required</p>
          <p style={{ margin: "4px 0", fontSize: 13, color: "#665" }}>
            {value.kind ? `${value.kind}: ` : ""}
            <code>{typeof value.detail === "string" ? value.detail : JSON.stringify(value.detail ?? {})}</code>
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => decide("once")}>Allow once</button>
            <button type="button" onClick={() => decide("always")}>Allow always</button>
            <button type="button" onClick={() => decide("deny")}>Deny</button>
          </div>
        </div>
      )
    },
  })
  return null
}
```
If Step 1 shows `useInterrupt`'s render prop has a different signature, adapt (keep the resolve payload `{ decision, interruptId? }`). Report the real signature.

- [ ] **Step 4: Write `app/page.tsx`:**
```tsx
"use client"
import { CopilotKitProvider } from "@copilotkit/react-core/v2"
import { CopilotSidebar } from "@copilotkit/react-ui"
import { PermissionInterrupt } from "./components/PermissionInterrupt"
import { TodosPanel } from "./components/TodosPanel"

export default function Home() {
  return (
    <CopilotKitProvider runtimeUrl="/api/copilotkit" agent="chat">
      <PermissionInterrupt />
      <div style={{ display: "flex", height: "100vh" }}>
        <TodosPanel />
        <main style={{ flex: 1 }}>
          <CopilotSidebar defaultOpen labels={{ title: "Dawn chat" }} />
        </main>
      </div>
    </CopilotKitProvider>
  )
}
```
Adapt `CopilotKitProvider` props / `CopilotSidebar` import path to the verified installed API (Step 1). Report deviations.

- [ ] **Step 5: Typecheck + build.**
```bash
pnpm --filter @dawn-example/chat-web typecheck
pnpm --filter @dawn-example/chat-web build
```
Both exit 0. `next build` compiles the app (it may warn about no static params — fine). If build fails on a real API misuse, fix against installed types.

- [ ] **Step 6: Commit.**
```bash
git add examples/chat/web/app/page.tsx examples/chat/web/app/components
git commit -m "feat(chat-web): CopilotKit page + Dawn interrupt/todos wrappers"
```

---

## Task 4: Env, README, final gate

**Files:** Create `examples/chat/web/.env.example`; rewrite `examples/chat/web/README.md`; check `examples/chat/README.md`

- [ ] **Step 1: `.env.example`:**
```bash
# The web app talks to the Dawn dev server; the OPENAI_API_KEY lives on the
# SERVER (examples/chat/server/.env), not here.
DAWN_SERVER_URL=http://127.0.0.1:3001
```

- [ ] **Step 2: `README.md`** documenting: what it is (canonical CopilotKit → Dawn/AG-UI web client), how to run (`pnpm install`; set `OPENAI_API_KEY` in `server/.env`; `pnpm dev` starts server :3001 + web :3000), the architecture (CopilotKit runtime → `HttpAgent` → Dawn `/agui/chat`), and the **live smoke checklist** (below). Note this connects to `/chat` only; `/coordinator` is a follow-up. Note there is no no-key demo mode by design.

- [ ] **Step 3: If `examples/chat/README.md` (root) describes the old web UI, update the web bullet** to reflect the CopilotKit rebuild. Leave the server section alone.

- [ ] **Step 4: Final automated gate.**
```bash
pnpm exec turbo run typecheck build --filter=@dawn-example/chat-web
```
Expected: both succeed. This is the full automated proof available without a key.

- [ ] **Step 5: Commit.**
```bash
git add examples/chat/web/.env.example examples/chat/web/README.md examples/chat/README.md
git commit -m "docs(chat-web): env, README, live-smoke checklist"
```

---

## Live smoke checklist (maintainer runs with a key — NOT part of CI)

1. `cp examples/chat/server/.env.example examples/chat/server/.env` and set `OPENAI_API_KEY`.
2. `cd examples/chat && pnpm dev` (server :3001, web :3000).
3. Open http://localhost:3000. Send "list the files in the workspace" → observe a streamed assistant reply in the sidebar.
4. Send a prompt that triggers a non-allowlisted `runBash` (e.g. "run `npm install left-pad`") → observe the **PermissionInterrupt** card → click Allow once → the run resumes and the command runs. **This confirms the `useInterrupt` ↔ `on_interrupt` ↔ `forwardedProps.command.resume` path.** If the card never appears, the v2 `useInterrupt` does not consume our `CUSTOM{on_interrupt}` — fall back to v1 `useLangGraphInterrupt`, or extend the translator (on the #322 base) to also emit `RUN_FINISHED{outcome:{type:"interrupt"}}`. Record the outcome.
5. Send a multi-step prompt that plans → observe **TodosPanel** populate from `plan_update`/state.

## Self-Review
- Spec coverage: runtime route (T2), provider+chat+interrupt+todos (T3), env/README/live-smoke (T4), deps/cleanup (T1). ✓
- Placeholder scan: all code blocks concrete; adaptation points are explicit "verify against installed types" steps, not TBDs. ✓
- Types: `chat` agent name consistent (route registration ↔ provider `agent="chat"` ↔ `useCoAgent({name:"chat"})`); resume payload `{decision, interruptId?}` matches `mapRunInput`. ✓
- Honesty: automated gate = build+typecheck; runtime = maintainer live smoke (no key here). ✓
