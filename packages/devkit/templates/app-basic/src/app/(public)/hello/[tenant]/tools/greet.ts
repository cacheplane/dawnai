import { z } from "zod"

export const schema = z.object({
  tenant: z.string().describe("The tenant identifier to look up"),
})

/**
 * Look up information about a tenant.
 */
export default async (input: { readonly tenant: string }) => {
  return {
    name: input.tenant,
    greeting: `Welcome, ${input.tenant}!`,
    plan: "starter",
  }
}
