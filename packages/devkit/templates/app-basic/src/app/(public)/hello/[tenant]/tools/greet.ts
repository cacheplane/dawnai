/**
 * Look up information about a tenant and generate a greeting.
 */
export default async (input: { readonly tenant: string }) => {
  return {
    greeting: `Hello, ${input.tenant}!`,
    tenant: input.tenant,
  }
}
