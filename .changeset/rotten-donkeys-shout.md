---
"@dawn-ai/cli": patch
"@dawn-ai/core": patch
---

Add `server.cors`, off by default.

A Dawn server sends no `Access-Control-*` header unless `dawn.config.ts` sets
`server.cors`. With the block absent the runtime answers exactly as it did
before — no header on any response, and `OPTIONS` still falling through the
route table to its 404. Opening a server to other origins is a deployment
decision, so nothing is inferred.

```ts
server: { cors: { origins: ["https://app.example.com"] } }
```

Set it when a browser client talks to Dawn directly rather than through a
same-origin proxy. Origins are compared exactly after normalizing case and a
trailing slash; note that `localhost` and `127.0.0.1` are different origins to
a browser, so list both if your dev client may be opened at either.

Every response carries the headers, including error responses and the shutdown
503 — a browser that cannot read a 404 reports an opaque CORS failure instead,
which is the most confusing way to debug this. A request from an origin that
is not on the list is still served normally and simply carries no CORS header;
answering 403 there would break non-browser clients that happen to send an
`Origin`. A preflight from a disallowed origin does get a 403.

The policy is validated once at boot, so a malformed origin list fails on
startup rather than on the first cross-origin request. `origins: "*"` combined
with `credentials: true` is rejected outright: browsers refuse a wildcard
allow-origin on a credentialed request, so accepting it would produce a server
that looks configured and fails only in the console.

Defaults for the rest: `credentials` false; `methods` `GET, POST, DELETE,
OPTIONS`; `headers` echoes the browser's own `Access-Control-Request-Headers`;
`exposeHeaders` empty; `maxAgeSeconds` 600.

CORS controls which origins a browser will let read a response. It does not
decide who may call the server — pair it with `defineThreadAccess`.
