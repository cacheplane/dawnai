import type { BaseEvent } from "@ag-ui/core"
import { EventEncoder } from "@ag-ui/encoder"

/** Encode one AG-UI event as an SSE frame (`data: <json>\n\n`). */
export function encodeAgUiSse(event: BaseEvent, accept?: string): string {
  const encoder = new EventEncoder(accept ? { accept } : {})
  return encoder.encode(event)
}
