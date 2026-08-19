---
"@dawn-ai/ag-ui": patch
---

Present each built-in orchestration action once. A `writeTodos` call whose plan
activity was emitted, and a `task` call whose subagent activity was emitted, no
longer also produce generic tool-call events, so activity-aware AG-UI clients
stop showing a duplicate card for the same work. Every other tool is unchanged,
and the generic events return as a fallback whenever the activity cannot be
produced. An interrupt now also carries the tool-call ID it belongs to, taken
from the Dawn envelope's call ID.
