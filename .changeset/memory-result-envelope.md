---
"@dawn-ai/core": patch
---

Memory `remember`/`recall` tools now return the `{ result }` wrapper shape (like other capability tools) instead of a bare string. Previously the langchain bridge JSON-stringified their returns, so the agent saw quoted, backslash-escaped content — most visibly `recall`'s multi-line list arriving as one quoted string with literal `\n`. The wrapper makes the string the ToolMessage content verbatim.
