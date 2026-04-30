import type { RuntimeContext } from "@dawn-ai/sdk"
import type { RouteTools } from "dawn:routes"

import type { HelloState } from "./state.js"

export async function workflow(
  state: HelloState,
  context: RuntimeContext<RouteTools<"/hello/[tenant]">>,
): Promise<HelloState> {
  const result = await context.tools.greet({ tenant: state.tenant })

  return {
    ...state,
    greeting: result.greeting,
  }
}
