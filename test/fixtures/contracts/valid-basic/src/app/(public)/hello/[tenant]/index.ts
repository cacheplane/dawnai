import type { HelloTenantState } from "./state.js"

export async function workflow(state: HelloTenantState): Promise<HelloTenantState> {
  return state
}
