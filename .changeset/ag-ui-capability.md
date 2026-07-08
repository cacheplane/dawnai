---
"@dawn-ai/ag-ui": patch
"@dawn-ai/cli": patch
---

Add `@dawn-ai/ag-ui`: translate Dawn's runtime stream to the AG-UI protocol and
serve it at `POST /agui/{routeId}`, so CopilotKit and other AG-UI clients can
drive Dawn agents. Additive — the existing Agent-Protocol endpoints are unchanged.
