---
"@dawn-ai/cli": patch
---

Record an AG-UI turn that parks on a permission prompt as `interrupted` rather
than `idle`. A parked turn takes the same completion path as one that finishes,
so the thread reported that the agent was done while it was still waiting on a
human, and a client that reloaded never re-rendered the prompt. The status now
holds on every path out of the turn, including a turn that parked and then
failed and one whose client disconnected after the park.
