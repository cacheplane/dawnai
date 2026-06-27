import { describe, expect, it } from "vitest"
import { runAddCommand } from "../src/commands/add.js"
import { CliError } from "../src/lib/output.js"

function fakeIo() {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { stdout: (m: string) => out.push(m), stderr: (m: string) => err.push(m) },
    out,
    err,
  }
}

const CATALOG = JSON.stringify([
  { name: "opentelemetry", category: "observability", description: "OTel tracing." },
  { name: "pgvector", category: "retrieval", description: "pgvector search." },
])

function fetchStub(routes: Record<string, { status: number; body: string }>): typeof fetch {
  return (async (url: string | URL) => {
    const key = String(url)
    const hit = routes[key]
    if (!hit) {
      return new Response("not found", { status: 404 })
    }
    return new Response(hit.body, { status: hit.status })
  }) as unknown as typeof fetch
}

const BASE = "https://dawnai.org"

describe("runAddCommand()", () => {
  it("lists the catalog grouped by category when no target is given", async () => {
    const { io, out } = fakeIo()
    const fetchImpl = fetchStub({
      [`${BASE}/blueprints/index.json`]: { status: 200, body: CATALOG },
    })
    await runAddCommand({ fetchImpl }, io)
    const text = out.join("\n")
    expect(text).toContain("observability:")
    expect(text).toContain("opentelemetry — OTel tracing.")
    expect(text).toContain("retrieval:")
  })

  it("prints the guide body for a known name", async () => {
    const { io, out } = fakeIo()
    const fetchImpl = fetchStub({
      [`${BASE}/blueprints/opentelemetry.md`]: {
        status: 200,
        body: "# Add OpenTelemetry\n\nDo it.\n",
      },
    })
    await runAddCommand({ target: "opentelemetry", fetchImpl }, io)
    const text = out.join("\n")
    expect(text).toContain("Apply this Dawn blueprint: opentelemetry")
    expect(text).toContain("# Add OpenTelemetry")
  })

  it("errors with the catalog list on an unknown name", async () => {
    const { io, err } = fakeIo()
    const fetchImpl = fetchStub({
      [`${BASE}/blueprints/nope.md`]: { status: 404, body: "" },
      [`${BASE}/blueprints/index.json`]: { status: 200, body: CATALOG },
    })
    await expect(runAddCommand({ target: "nope", fetchImpl }, io)).rejects.toBeInstanceOf(CliError)
    expect(err.join("\n")).toContain("opentelemetry")
  })

  it("fetches an absolute URL verbatim", async () => {
    const { io, out } = fakeIo()
    const url = "https://example.com/my-blueprint.md"
    const fetchImpl = fetchStub({ [url]: { status: 200, body: "# Custom\n" } })
    await runAddCommand({ target: url, fetchImpl }, io)
    expect(out.join("\n")).toContain("# Custom")
  })

  it("honors an explicit baseUrl override", async () => {
    const { io, out } = fakeIo()
    const base = "http://localhost:4321"
    const fetchImpl = fetchStub({
      [`${base}/blueprints/opentelemetry.md`]: { status: 200, body: "# X\n" },
    })
    await runAddCommand({ target: "opentelemetry", baseUrl: base, fetchImpl }, io)
    expect(out.join("\n")).toContain("# X")
  })

  it("throws on a non-200/non-404 server error", async () => {
    const { io } = fakeIo()
    const fetchImpl = fetchStub({
      [`${BASE}/blueprints/opentelemetry.md`]: { status: 500, body: "" },
    })
    await expect(runAddCommand({ target: "opentelemetry", fetchImpl }, io)).rejects.toBeInstanceOf(
      CliError,
    )
  })

  it("rejects an invalid (path-y) blueprint name", async () => {
    const { io } = fakeIo()
    const fetchImpl = fetchStub({})
    await expect(runAddCommand({ target: "../../admin", fetchImpl }, io)).rejects.toBeInstanceOf(
      CliError,
    )
  })

  it("errors when the catalog is not an array", async () => {
    const { io } = fakeIo()
    const fetchImpl = fetchStub({
      [`${BASE}/blueprints/index.json`]: { status: 200, body: '{"oops":true}' },
    })
    await expect(runAddCommand({ fetchImpl }, io)).rejects.toBeInstanceOf(CliError)
  })
})
