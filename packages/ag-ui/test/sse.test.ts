import { EventType } from "@ag-ui/core"
import { expect, test } from "vitest"
import { encodeAgUiSse } from "../src/sse.js"

test("encodes events from the focused SSE module", () => {
  expect(encodeAgUiSse({ type: EventType.RUN_STARTED, threadId: "t", runId: "r" })).toContain(
    '"type":"RUN_STARTED"',
  )
})
