import type { OffloadStore } from "./offload-store.js"
import { buildStub } from "./stub.js"

export interface OffloadToolOutputCtx {
  readonly toolName: string
  readonly thresholdChars: number
  readonly previewLines: number
  readonly store: Pick<OffloadStore, "write">
}

export async function offloadToolOutput(
  content: string,
  ctx: OffloadToolOutputCtx,
): Promise<string> {
  if (content.length <= ctx.thresholdChars) return content
  try {
    const relPath = await ctx.store.write(ctx.toolName, content)
    return buildStub({
      content,
      relPath,
      previewLines: ctx.previewLines,
      thresholdChars: ctx.thresholdChars,
    })
  } catch {
    // Never break a tool because offloading failed; keep the original content.
    return content
  }
}
