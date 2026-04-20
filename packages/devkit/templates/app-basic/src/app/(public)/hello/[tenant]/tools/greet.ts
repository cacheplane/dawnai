export default async (input: { readonly tenant: string }) => {
  return { greeting: `Hello, ${input.tenant}!` }
}
