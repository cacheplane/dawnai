/**
 * Look up information about a tenant.
 * @param tenant - The tenant identifier to look up
 */
export default async (input: { readonly tenant: string }) => {
  return {
    name: input.tenant,
    greeting: `Welcome, ${input.tenant}!`,
    plan: "starter",
  }
}
