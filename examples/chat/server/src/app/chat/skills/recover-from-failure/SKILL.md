---
description: How to recover when a tool call fails — diagnose, not blindly retry.
---

# Recover from a failed tool call

When a tool call returns an error:

1. **Read the error message first.** Most Dawn tool errors are self-explanatory:
   path-jail violations, file-too-large, command exit codes.
2. **Don't retry the exact same call.** If `readFile({ path: "missing.txt" })`
   returned "ENOENT", calling it again won't help. Either list the directory to
   find the right name, or use `writeFile` to create the file.
3. **Check `AGENTS.md` for known conventions before improvising.** The memory
   file often documents the right approach the previous session figured out.
4. **If three different approaches fail in a row, stop and ask the user.** Don't
   keep flailing — explain what you tried and what went wrong.
5. **Record what worked in `AGENTS.md`** (via `writeFile`) when you find a fix
   that wasn't already documented. Future-you will thank you.
