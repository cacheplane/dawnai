---
"@dawn-ai/ag-ui": patch
"@dawn-ai/devkit": patch
"create-dawn-ai-app": patch
---

Expose Dawn planning and subagent progress as bounded standard AG-UI activity
snapshots. The research web example renders plan checklists and delegated-work
status from those snapshots, which exclude child prose, prompts, tool inputs,
tool outputs, and final child answers. Ordinary root tool events remain a
separate surface, and the generated research starter now points users to that
activity-aware web recipe.
