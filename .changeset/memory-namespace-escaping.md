---
"@dawn-ai/memory": patch
---

`serializeNamespace` now percent-encodes the reserved delimiters (`%`, `|`, `=`) in scope dimension values, so a `tenant`/`user`/`agent` value (from `resolveScope`) or an oddly-named workspace/route containing a delimiter can no longer corrupt the namespace or collide across scopes. Ordinary values (no reserved chars) are unchanged, so existing stored memories and persisted permission patterns keep matching byte-for-byte.
