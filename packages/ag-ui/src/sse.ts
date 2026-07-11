import { EventEncoder } from "@ag-ui/encoder"
import type { AgUiEvent } from "./types.js"

/** Encode one AG-UI event as an SSE frame (`data: <json>\n\n`). */
export function encodeAgUiSse(event: AgUiEvent, accept?: string): string {
  const encoder = new EventEncoder(accept ? { accept } : {})
  return encoder.encode(event)
}
