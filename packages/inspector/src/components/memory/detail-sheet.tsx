"use client"
import type { MemoryRecord } from "@dawn-ai/memory"
import { type ReactNode, useCallback, useEffect, useState } from "react"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { type MemoryVerb, mutateMemory } from "./actions"

/** Overlays the table's right side (fixed, not in-flow — list-page renders the
 *  sheet outside its flex row). Focus-trap is deferred: this is a local dev
 *  tool, Escape + the close button cover the interaction. */
const sheetClass =
  "fixed inset-y-0 right-0 z-20 flex w-96 flex-col border-l border-zinc-200 bg-white shadow-xl"

export function DetailSheet({
  id,
  onClose,
  onMutated,
}: {
  id: string
  onClose: () => void
  onMutated: () => void
}) {
  const [rec, setRec] = useState<MemoryRecord | undefined>()
  const [conflict, setConflict] = useState<MemoryRecord | undefined>()
  // Probe hit the list limit — actives beyond it were never compared, so "no
  // conflict found" would be a lie; render an "unverified" note instead.
  const [probeTruncated, setProbeTruncated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    let alive = true
    void (async () => {
      // Mirrors act(): a network-level rejection or non-JSON body must land in
      // the error aside, not escape as an unhandled rejection (sheet stuck at null).
      try {
        const res = await fetch(`/api/memory/${encodeURIComponent(id)}`)
        if (!res.ok) {
          if (alive) setError(`load failed (${res.status})`)
          return
        }
        const r = (await res.json()) as MemoryRecord
        if (!alive) return
        setRec(r)
        // Candidate? Probe same-namespace actives for an identity conflict so the
        // Approve button can warn BEFORE the action. Display-only heuristic using
        // the DEFAULT semantic identity (subject/predicate) — the server resolves
        // the route's real identity on approve; the server response is authoritative.
        if (r.status === "candidate") {
          const q = new URLSearchParams({
            namespacePrefix: r.namespace,
            status: "active",
            limit: "1000",
          })
          const lres = await fetch(`/api/memory/list?${q}`)
          if (!lres.ok || !alive) return
          const { records, total } = (await lres.json()) as {
            records: MemoryRecord[]
            total: number
          }
          if (!alive) return
          if (records.length < total) {
            setProbeTruncated(true)
            return
          }
          // JSON.stringify equality is key-order sensitive: identical data with
          // differently-ordered keys reads as a conflict. Acceptable for a
          // display-only warning (records written by the same route serialize
          // consistently); the server decides the real outcome.
          const twin = records.find(
            (a) =>
              a.namespace === r.namespace &&
              JSON.stringify([a.data.subject, a.data.predicate]) ===
                JSON.stringify([r.data.subject, r.data.predicate]) &&
              JSON.stringify(a.data) !== JSON.stringify(r.data),
          )
          setConflict(twin)
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => {
      alive = false
    }
  }, [id])

  // The sheet overlays content, so Escape must always dismiss it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  const act = useCallback(
    async (verb: MemoryVerb) => {
      setBusy(true)
      setError(undefined)
      const { error: failure } = await mutateMemory(id, verb)
      setBusy(false)
      if (failure) {
        setError(failure)
        return
      }
      onMutated()
    },
    [id, onMutated],
  )

  if (!rec) {
    return error ? (
      <aside className={`${sheetClass} p-4`} role="alert">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm text-red-600">{error}</span>
          <Button variant="outline" aria-label="Close detail" onClick={onClose}>
            ✕
          </Button>
        </div>
      </aside>
    ) : null
  }
  return (
    <aside className={sheetClass} data-testid="detail-sheet" aria-label="Memory detail">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 p-4">
        <Badge variant={rec.status}>{rec.status}</Badge>
        <Badge>{rec.kind}</Badge>
        <Badge className="font-mono">{rec.namespace}</Badge>
        <span className="w-full font-mono text-[10px] text-zinc-400">{rec.id}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
        <Field label="content">{rec.content}</Field>
        <Field label="data">
          <pre className="overflow-auto rounded-md border border-zinc-100 bg-zinc-50 p-2 font-mono text-xs">
            {JSON.stringify(rec.data, null, 2)}
          </pre>
        </Field>
        <Field label="tags">{rec.tags.length > 0 ? rec.tags.join(", ") : "—"}</Field>
        <Field label="source">{`${rec.source.type} · ${rec.source.id}`}</Field>
        <Field label="confidence">{String(rec.confidence)}</Field>
        <Field label="timestamps">
          {`created ${new Date(rec.createdAt).toLocaleString()} · updated ${new Date(rec.updatedAt).toLocaleString()}`}
        </Field>
        {rec.supersedes?.length ? (
          <Field label="supersedes">{rec.supersedes.join(", ")}</Field>
        ) : null}
        {conflict ? (
          <div
            className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3"
            data-testid="supersede-callout"
          >
            <p className="text-xs font-semibold text-amber-800">
              ⚠ Approving will supersede an active memory
            </p>
            <pre className="mt-1 overflow-auto font-mono text-xs">
              <span className="text-red-700">
                {`– active: ${JSON.stringify(conflict.data)}  (${conflict.id})`}
              </span>
              {"\n"}
              <span className="text-green-700">{`+ this:   ${JSON.stringify(rec.data)}`}</span>
            </pre>
          </div>
        ) : probeTruncated ? (
          <div
            className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600"
            data-testid="probe-unverified"
          >
            Conflict check unverified — too many active memories to probe. Approving may still
            supersede an active record.
          </div>
        ) : null}
        {error ? (
          <p className="mt-3 text-xs text-red-600" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2 border-t border-zinc-100 p-4">
        {rec.status === "candidate" ? (
          <>
            <Button disabled={busy} onClick={() => act("approve")}>
              {conflict ? "Approve & supersede" : "Approve"}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Reject (delete) this candidate?")) void act("reject")
              }}
            >
              Reject
            </Button>
          </>
        ) : null}
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() => {
            if (window.confirm("Permanently forget this memory?")) void act("forget")
          }}
        >
          Forget
        </Button>
        <span className="flex-1" />
        <Button
          variant="outline"
          onClick={() => {
            if (!navigator.clipboard) return
            void navigator.clipboard
              .writeText(JSON.stringify(rec, null, 2))
              .then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
              .catch(() => {})
          }}
        >
          {copied ? "Copied" : "Copy JSON"}
        </Button>
        <Button variant="outline" aria-label="Close detail" onClick={onClose}>
          ✕
        </Button>
      </div>
    </aside>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
        {label}
      </div>
      <div className="text-zinc-800">{children}</div>
    </div>
  )
}
