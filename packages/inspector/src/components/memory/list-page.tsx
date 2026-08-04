"use client"
import type { MemoryRecord, MemoryStats } from "@dawn-ai/memory"
import { useCallback, useEffect, useState } from "react"
import { Badge } from "../ui/badge"
import { Input } from "../ui/input"
import { usePolling } from "../use-polling"
import { DetailSheet } from "./detail-sheet"
import { FacetRail } from "./facet-rail"
import { MemoryGrid } from "./memory-grid"

interface ListResponse {
  readonly records: readonly MemoryRecord[]
  readonly total: number
}
interface SearchResponse {
  readonly groups: readonly {
    readonly namespace: string
    readonly records: readonly MemoryRecord[]
  }[]
  readonly hybrid?: boolean
}

/** Each fetcher owns its own error slot — a stats success must not clear a
 *  search failure's banner (they poll on independent cadences). */
type ErrorSource = "stats" | "list" | "search"

const KINDS = ["semantic", "episodic", "procedural", "reflection"] as const
const STATUSES = ["candidate", "active", "superseded"] as const

const selectClass =
  "h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-300"

export function ListPage() {
  const [namespace, setNamespace] = useState<string>()
  const [status, setStatus] = useState("")
  const [kind, setKind] = useState("")
  const [query, setQuery] = useState("")
  const [live, setLive] = useState(true)
  const [selectedId, setSelectedId] = useState<string>()
  const [refreshKey, setRefreshKey] = useState(0)
  const [errors, setErrors] = useState<Partial<Record<ErrorSource, string>>>({})
  const [search, setSearch] = useState<SearchResponse>()

  const setError = useCallback((source: ErrorSource, message: string | undefined) => {
    setErrors((prev) => (prev[source] === message ? prev : { ...prev, [source]: message }))
  }, [])

  /** Fetch JSON; on failure surface the API's {error} body in this source's
   *  banner slot, on success clear only that slot. */
  const fetchJson = useCallback(
    async <T,>(source: ErrorSource, url: string): Promise<T> => {
      let res: Response
      try {
        res = await fetch(url)
      } catch (err) {
        setError(source, err instanceof Error ? err.message : String(err))
        throw err
      }
      const body: unknown = await res.json().catch(() => undefined)
      if (!res.ok) {
        const message =
          body &&
          typeof body === "object" &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `request failed (${res.status})`
        setError(source, message)
        throw new Error(message)
      }
      setError(source, undefined)
      return body as T
    },
    [setError],
  )

  const statsFn = useCallback(
    () => fetchJson<MemoryStats>("stats", "/api/memory/stats"),
    [fetchJson],
  )

  const pageFn = useCallback(() => {
    // refreshKey exists only to change this callback's identity after a
    // mutation, so usePolling re-runs its immediate tick.
    void refreshKey
    const params = new URLSearchParams({ limit: "200" })
    if (namespace) params.set("namespacePrefix", namespace)
    if (status) params.set("status", status)
    if (kind) params.set("kind", kind)
    return fetchJson<ListResponse>("list", `/api/memory/list?${params}`)
  }, [fetchJson, namespace, status, kind, refreshKey])

  const stats = usePolling(statsFn, 2000, live)
  const page = usePolling(pageFn, 2000, live && !query)

  // Search is fetched once per (debounced) query change, never polled — a
  // hybrid store would call the embedder on every search request.
  useEffect(() => {
    if (!query) {
      setSearch(undefined)
      setError("search", undefined)
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query })
      if (namespace) params.set("namespace", namespace)
      fetchJson<SearchResponse>("search", `/api/memory/search?${params}`)
        .then((result) => {
          if (alive) setSearch(result)
        })
        .catch(() => {
          // Drop stale results — showing matches for a previous query beside a
          // failure banner would misattribute them to the current one.
          if (alive) setSearch(undefined)
        })
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query, namespace, fetchJson, setError])

  const byStatus = stats?.byStatus ?? {}
  const searching = query.length > 0
  // Keyed by source, not message — two fetchers failing with the same message
  // must not produce duplicate React keys (or stacked repeats).
  const errorEntries = Object.entries(errors).filter((entry): entry is [ErrorSource, string] =>
    Boolean(entry[1]),
  )

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-3">
        <h1 className="text-sm font-semibold">Memory Inspector</h1>
        <div className="flex items-center gap-1.5">
          {STATUSES.map((s) => (
            <Badge key={s} variant={s}>
              {byStatus[s] ?? 0} {s}
            </Badge>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Input
            type="search"
            aria-label="Search memories"
            placeholder="Search memories…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-64"
          />
          <select
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className={selectClass}
          >
            <option value="">any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            aria-label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className={selectClass}
          >
            <option value="">any kind</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm text-zinc-600">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            live
          </label>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <FacetRail stats={stats} selected={namespace} onSelect={setNamespace} />
        <main className="min-w-0 flex-1 overflow-y-auto p-4">
          {errorEntries.length > 0 ? (
            <div
              role="alert"
              className="mb-3 space-y-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {errorEntries.map(([source, message]) => (
                <div key={source}>{message}</div>
              ))}
            </div>
          ) : null}
          {searching ? (
            search && search.groups.length > 0 ? (
              <div className="space-y-4">
                {search.groups.map((group) => (
                  <section key={group.namespace}>
                    <h2 className="mb-1.5 font-mono text-xs font-medium text-zinc-500">
                      {group.namespace}
                    </h2>
                    <MemoryGrid records={group.records} onSelect={setSelectedId} />
                  </section>
                ))}
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-zinc-400">No matches.</p>
            )
          ) : page && page.records.length > 0 ? (
            <MemoryGrid records={page.records} onSelect={setSelectedId} />
          ) : (
            <p className="py-8 text-center text-sm text-zinc-400">
              No memories yet — run your agent and watch them appear.
            </p>
          )}
        </main>
      </div>
      {selectedId ? (
        <DetailSheet
          id={selectedId}
          onClose={() => setSelectedId(undefined)}
          onMutated={() => {
            setSelectedId(undefined)
            setRefreshKey((k) => k + 1)
          }}
        />
      ) : null}
    </div>
  )
}
