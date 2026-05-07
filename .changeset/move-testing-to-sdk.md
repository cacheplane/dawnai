---
"@dawn-ai/sdk": patch
"@dawn-ai/cli": patch
---

Move testing helpers to `@dawn-ai/sdk/testing`.

`expectError`, `expectMeta`, `expectOutput`, and the `RuntimeExecutionResult` type family now live at `@dawn-ai/sdk/testing` — the canonical home users have been intuitively reaching for. The old `@dawn-ai/cli/testing` subpath continues to work as a re-export for back-compat (and is now JSDoc-deprecated).

```ts
// Preferred
import { expectError, expectMeta, expectOutput } from "@dawn-ai/sdk/testing"

// Still works (re-exports from sdk)
import { expectError, expectMeta, expectOutput } from "@dawn-ai/cli/testing"
```

No behavior change. The packed runtime contract test now exercises both subpaths.
