---
"@dawn-ai/ag-ui": patch
"@dawn-ai/devkit": patch
"create-dawn-ai-app": patch
---

Expose Dawn planning and subagent progress as bounded standard AG-UI activity
snapshots. The research web example renders plan checklists and delegated-work
status from those snapshots, which exclude child prose, prompts, tool inputs,
tool outputs, and final child answers. The generated research starter renders these
activities in the web client it ships.
