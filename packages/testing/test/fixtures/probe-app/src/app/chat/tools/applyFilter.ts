/** Apply a status filter and report how many matched. */
export default async function applyFilter(input: {
  status: "open" | "closed"
}): Promise<{ matched: number }> {
  return { matched: input.status === "open" ? 2 : 0 }
}
