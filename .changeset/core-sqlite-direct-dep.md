---
"@dawn-ai/core": patch
---

Move `@dawn-ai/sqlite-storage` from `peerDependencies` to `dependencies`. It backs the default SQLite checkpointer/threads store that `@dawn-ai/core` ships, so a direct dependency reflects the real relationship and avoids requiring consumers to install it separately.
