/** Apply a structured filter to records and return how many matched, echoing the input back. */
export default async function applyFilter(input: {
  filter: { status: "open" | "closed"; tags: string[] }
  pagination?: { limit: number; cursor?: string }
  labels?: Record<string, string>
  sort: { by: "date"; dir: "asc" | "desc" } | { by: "name" }
}): Promise<{ matched: number; echo: unknown }> {
  return { matched: input.filter.tags.length, echo: input }
}
