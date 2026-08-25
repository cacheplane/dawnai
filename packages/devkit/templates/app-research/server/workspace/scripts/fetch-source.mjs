#!/usr/bin/env node
// Offline seam for "fetch an external source". The default scaffold has no
// network access, so this prints a deterministic stub. It is intentionally NOT
// on the dawn.config.ts allow-list, so invoking it pauses the run for human
// approval (the HITL permissions demo). Replace the body with a real fetch —
// and add it to permissions.allow.bash — when you wire up an external source.
const topic = process.argv.slice(2).join(" ").trim() || "(no topic)"
process.stdout.write(
  `No external source configured for "${topic}". ` +
    `Edit workspace/scripts/fetch-source.mjs to fetch real content.\n`,
)
