import { join } from "node:path"
import { sqliteMemoryStore } from "@dawn-ai/memory"
import { browseSeedRecords } from "./seed"

/**
 * Write the fixture into `<appRoot>/.dawn/memory.sqlite`. Node-only.
 *
 * Deliberately NOT in `seed.ts`: this is a value import of the `@dawn-ai/memory` barrel,
 * which pulls `node:sqlite`, and `seed.ts` is imported by the jsdom components project —
 * which cannot bundle a builtin and would need `packages/memory/dist` built to try.
 * Keeping the two apart is what lets the component tests run with neither.
 *
 * Records are put in emission order, which is not id order (see `EMIT_STRIDE`), so
 * SQLite's rowid order cannot stand in for the `id ASC` terminator a browse window is
 * supposed to be made deterministic by.
 */
export async function writeBrowseSeed(appRoot: string): Promise<void> {
  const store = sqliteMemoryStore({ path: join(appRoot, ".dawn", "memory.sqlite") })
  for (const record of browseSeedRecords()) {
    await store.put(record)
  }
}
