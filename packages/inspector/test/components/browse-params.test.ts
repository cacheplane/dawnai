import { describe, expect, it } from "vitest"
import { isBrowseQueryError, parseBrowseQuery } from "../../src/store/browse-params"

const parse = (qs: string, now?: string) =>
  parseBrowseQuery(new URLSearchParams(qs), now === undefined ? {} : { now })

describe("parseBrowseQuery", () => {
  it("defaults to limit 50 and no filters", () => {
    expect(parse("")).toEqual({ limit: 50, offset: 0 })
  })
  it("keeps the existing scalar and repeated params working", () => {
    expect(
      parse(
        "status=active&status=candidate&kind=episodic&sourceType=human&namespacePrefix=route%3D%2Fx&limit=200&offset=10",
      ),
    ).toEqual({
      namespacePrefix: "route=/x",
      status: ["active", "candidate"],
      kind: ["episodic"],
      sourceType: "human",
      limit: 200,
      offset: 10,
    })
  })
  it("normalizes instants to full ISO-Z before validating", () => {
    expect(parse("since=2026-08-09T00:00:00%2B02:00").since).toBe("2026-08-08T22:00:00.000Z")
  })
  it("threads `now` so expired rows are hidden unless includeExpired=1", () => {
    expect(parse("", "2026-08-09T00:00:00.000Z").now).toBe("2026-08-09T00:00:00.000Z")
    expect(parse("includeExpired=1", "2026-08-09T00:00:00.000Z").now).toBeUndefined()
  })
  it("lets the caller pin `now` so one walk holds it across every page", () => {
    // `now` is part of the cursor fingerprint, so a `now` stamped per request would
    // reject every continuation the previous request issued.
    expect(parse("now=2026-01-02T03:04:05.000Z", "2026-08-09T00:00:00.000Z").now).toBe(
      "2026-01-02T03:04:05.000Z",
    )
    expect(parse("now=2026-01-02T03:04:05%2B02:00", "2026-08-09T00:00:00.000Z").now).toBe(
      "2026-01-02T01:04:05.000Z",
    )
    expect(parse("now=2026-01-02T03:04:05.000Z&includeExpired=1").now).toBeUndefined()
  })
  it("decodes the new JSON params", () => {
    const filters = [{ field: "content", op: "contains", value: "acme" }]
    const orderBy = [{ field: "confidence", dir: "desc" }]
    const query = parse(
      `namespace=route%3D%2Fx&cursor=abc&filters=${encodeURIComponent(JSON.stringify(filters))}&orderBy=${encodeURIComponent(JSON.stringify(orderBy))}`,
    )
    expect(query.namespace).toBe("route=/x")
    expect(query.cursor).toBe("abc")
    expect(query.filters).toEqual(filters)
    expect(query.orderBy).toEqual(orderBy)
  })
  it("omits offset entirely when a cursor is supplied", () => {
    expect(parse("cursor=abc").offset).toBeUndefined()
  })
  it("dedupes a repeated enum value so one narrowing has one spelling", () => {
    expect(parse("status=active&status=active&status=candidate").status).toEqual([
      "active",
      "candidate",
    ])
  })
})

describe("parseBrowseQuery — rejections", () => {
  const rejects = (qs: string, match: RegExp) => {
    try {
      parse(qs)
      expect.unreachable(`expected ${qs} to be rejected`)
    } catch (error) {
      expect(isBrowseQueryError(error)).toBe(true)
      expect((error as Error).message).toMatch(match)
    }
  }
  it("rejects unknown enum values", () => rejects("status=bogus", /invalid status "bogus"/))
  it("rejects unparseable instants with the message the e2e pins", () =>
    rejects("since=notadate", /invalid since "notadate"/))
  it("rejects an unparseable pinned now", () => rejects("now=notadate", /invalid now "notadate"/))
  it("rejects malformed JSON params", () =>
    rejects("filters=%7Bnot-json", /filters must be valid JSON/))
  it("hands a falsy JSON param to the validator rather than dropping it", () => {
    rejects("filters=0", /filters must be an array/)
    rejects("filters=null", /filters must be an array/)
    rejects("orderBy=false", /orderBy must be an array/)
  })
  it("rejects a cursor sent with a non-zero offset instead of ignoring the offset", () =>
    rejects("cursor=abc&offset=50", /cursor and a non-zero offset cannot be combined/))
  it("rejects a non-numeric limit", () => rejects("limit=abc", /limit must be a number/))
  it("enforces the 1000 ceiling that in-process callers are exempt from", () =>
    rejects("limit=5000", /limit must be at most 1000/))
  it("rejects an unknown sort field", () =>
    rejects(
      `orderBy=${encodeURIComponent(JSON.stringify([{ field: "content", dir: "asc" }]))}`,
      /unknown sort field/,
    ))
})
