import type { ToolDefinition } from "../src/tool.js"

type DefaultToolRun = ToolDefinition["run"]

const validDefaultToolContextUsage: DefaultToolRun = async (_input, context) =>
  context.signal.aborted

// @ts-expect-error Default tool context should not expose route-level tools.
const invalidDefaultToolContextUsage: DefaultToolRun = async (_input, context) => context.tools

void validDefaultToolContextUsage
void invalidDefaultToolContextUsage
