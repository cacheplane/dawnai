---
"@dawn-ai/devkit": patch
"create-dawn-ai-app": patch
---

Fix fresh scaffolds failing `npm install`: the app templates pinned `zod@^3.24.0` while `@dawn-ai/sdk` declares an optional peer of `zod@^4`, which npm's strict peer resolution rejects (ERESOLVE) on every new app. Templates now scaffold `zod@^4.0.0` (the template code uses only APIs present in both majors, and `@langchain/core` accepts `^3.25.76 || ^4`).
