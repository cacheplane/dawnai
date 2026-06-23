/** Search the workspace index for a query and return matching snippets. */
export default async function search(input: { query: string }): Promise<{ results: string[] }> {
  return { results: [`stub result for ${input.query}`] }
}
