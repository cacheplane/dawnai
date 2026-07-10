// Minimal aimock server for the full-arc sandbox smoke.
//
// Mirrors how the Dawn test harness starts aimock (see
// packages/testing/src/aimock-runner.ts): construct an @copilotkit/aimock
// `LLMock`, load the committed fixture via `addFixturesFromJSON`, and `start()`.
// The container serves an OpenAI-compatible `/v1/chat/completions` endpoint
// backed entirely by the baked fixture — no real model, fully deterministic.
//
// The Dawn app talks to this server via `OPENAI_BASE_URL=http://<host>:4010/v1`.
import { readFileSync } from "node:fs"
import { LLMock } from "@copilotkit/aimock"

const host = process.env.AIMOCK_HOST ?? "0.0.0.0"
// NOTE: `|| 4010`, not `?? "4010"`. A Kubernetes Service named `aimock` makes the
// kubelet auto-inject a legacy docker-link env var `AIMOCK_PORT=tcp://<clusterIP>:4010`,
// so `AIMOCK_PORT` is *defined* (?? wouldn't fall back) but non-numeric → Number(...)
// is NaN → ERR_SOCKET_BAD_PORT. `Number(...) || 4010` falls back to the real port for
// the tcp:// form, an unset var, or any other non-numeric value.
const port = Number(process.env.AIMOCK_PORT) || 4010
const fixturePath = process.env.AIMOCK_FIXTURE ?? "/app/smoke.json"

const raw = JSON.parse(readFileSync(fixturePath, "utf8"))
// The committed fixture is `{ "fixtures": [...] }`; aimock's addFixturesFromJSON
// wants the bare array (same shape the harness passes it).
const fixtures = Array.isArray(raw) ? raw : raw.fixtures

const mock = new LLMock({ host, port, chunkSize: 4096 })
mock.addFixturesFromJSON(fixtures)
await mock.start()

console.log(`aimock listening on ${mock.url} (fixture: ${fixturePath})`)
