// Discoverable Dawn app (package.json + config) whose /notes route has a
// memory.ts that throws at load time — exercises the approve route's
// propagate-on-broken-memory.ts discipline (500, never silent fallback).
export default {
  appDir: "src/app",
}
