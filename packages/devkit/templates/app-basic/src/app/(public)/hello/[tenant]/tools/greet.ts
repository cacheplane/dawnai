/**
 * Look up information about a tenant.
 */
export default async (input: { readonly tenant: string }) => {
  return {
    name: input.tenant,
    plan: "starter",
  }
}
