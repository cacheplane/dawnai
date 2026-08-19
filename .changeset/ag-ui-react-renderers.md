---
"@dawn-ai/ag-ui": patch
---

Ship the plan and subagent activity renderers as `@dawn-ai/ag-ui/react`. A
CopilotKit client can now render Dawn's built-in orchestration by passing
`dawnActivityRenderers` to `renderActivityMessages`, instead of copying React
components out of an example. The card components, the content schemas, and
the parsed subagent content type are exported too, for clients that want their
own presentation. React and `@copilotkit/react-core` are optional peer
dependencies, so server-only consumers install nothing extra.
