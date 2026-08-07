/**
 * The node lane's `loadDawnConfig`.
 *
 * `@dawn-ai/core`'s config memo dispatches through a REGISTERED loader so the
 * request path stays free of `node:fs`/`tsx`; the disk loader ships from
 * `@dawn-ai/core/node`. Importing this module registers it.
 *
 * Every CLI module that reads `dawn.config.ts` imports `loadDawnConfig` FROM
 * HERE rather than from `@dawn-ai/core`, so the registration travels with the
 * function and cannot be forgotten at a new entry point. That matters more
 * than usual: the resolvers below it (`resolve-memory`, `resolve-sandbox`)
 * swallow a config-load failure and fall back to defaults, so a missed
 * registration would degrade silently rather than fail loudly.
 */

import { loadDawnConfig } from "@dawn-ai/core"
import { registerNodeConfigLoader } from "@dawn-ai/core/node"

registerNodeConfigLoader()

export { loadDawnConfig }
