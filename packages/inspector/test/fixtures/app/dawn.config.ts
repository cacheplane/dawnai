// Fixture proves the inspector loads USER TS config at runtime. The store is the
// default sqlite one but configured EXPLICITLY so the config file must be executed.
import { join } from "node:path"
import { sqliteMemoryStore } from "@dawn-ai/memory"

export default {
  appDir: "src/app",
  memory: {
    writes: "candidate",
    store: sqliteMemoryStore({ path: join(import.meta.dirname, ".dawn", "memory.sqlite") }),
  },
}
