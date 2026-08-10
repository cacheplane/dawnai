---
"@dawn-ai/postgres-storage": patch
---

Say which Vercel runtime the `/node` entry works on. The README listed "Vercel
functions" among the hosts where `pg` opens a raw TCP connection, which is true
of Vercel's Node.js runtime and false of its Edge runtime — the latter has no
raw TCP socket, exactly like workerd, and needs the injected
`@neondatabase/serverless` pool instead. The configuration docs carried the same
unqualified claim in a *Works* column and now also record that nothing here has
been run on Vercel: it is inference from the driver, not a measurement.
