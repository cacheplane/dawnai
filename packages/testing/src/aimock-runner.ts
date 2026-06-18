import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { LLMock } from "@copilotkit/aimock"
import type { AimockFixture, AimockResponse } from "./fixture-builder.js"
import type { Recording } from "./record-fixtures.js"

export interface Aimock {
  readonly port: number
  /** Base URL with the `/v1` suffix the OpenAI SDK expects. */
  readonly baseUrl: string
  /** Append more fixtures onto the live mock without restarting it. */
  addFixtures(fixtures: readonly AimockFixture[]): void
  /** Remove all registered fixtures (the mock keeps running). */
  clearFixtures(): void
  /** All requests the mock has received (aimock's journal). */
  getRequests(): ReadonlyArray<{
    body: { messages?: Array<{ role: string; content: unknown }> } | null
  }>
  /** Current count of registered fixtures (snapshot point for getRecordingsSince). */
  getFixtureCount(): number
  /**
   * Recordings captured since the given journal length and fixture count — pairs
   * proxied journal entries (request) with newly-recorded fixtures (response),
   * both windowed to a single run so multi-run reuse can't cross-align.
   */
  getRecordingsSince(journalStart: number, fixtureStart: number): readonly Recording[]
  /** Ordered recordings (request + baked response) for proxied calls captured in record mode. */
  getRecordings(): readonly Recording[]
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export async function createAimock(opts: {
  readonly fixtures: readonly AimockFixture[]
  /** When set, proxy unmatched requests to the given upstream providers. */
  readonly proxy?: { openai: string }
  /** With proxy: capture (record) proxied responses so getRecordings() returns them. */
  readonly record?: boolean
}): Promise<Aimock> {
  // When recording, use a private temp dir so aimock writes fixtures there
  // instead of ./fixtures/recorded in the caller's CWD.
  const recordTmpDir =
    opts.proxy && opts.record === true
      ? fs.mkdtempSync(path.join(os.tmpdir(), "dawn-aimock-record-"))
      : null

  const mock = new LLMock(
    opts.proxy
      ? {
          port: 0,
          chunkSize: 4096,
          record: {
            providers: { openai: opts.proxy.openai },
            proxyOnly: opts.record !== true,
            ...(recordTmpDir !== null ? { fixturePath: recordTmpDir } : {}),
          },
        }
      : { port: 0, chunkSize: 4096 },
  )
  if (opts.fixtures.length > 0) {
    mock.addFixturesFromJSON(opts.fixtures as never)
  }
  await mock.start()

  // Capture the fixture count at start so getRecordings() can diff against it.
  const initialFixtureCount = mock.getFixtures().length

  // Local helper — windowed to [journalStart, fixtureStart) so multi-run reuse
  // can't cross-align recorded responses with the wrong requests.
  const getRecordingsSince = (journalStart: number, fixtureStart: number): readonly Recording[] => {
    const newFixtures = mock.getFixtures().slice(fixtureStart)
    if (newFixtures.length === 0) return []
    const proxyEntries = (
      mock.getRequests() as ReadonlyArray<{
        body: { messages?: Array<{ role: string; content: unknown }> } | null
        response?: { source?: string }
      }>
    )
      .slice(journalStart)
      .filter((e) => e.response?.source === "proxy")
    return newFixtures.map((fixture, i): Recording => {
      const messages = proxyEntries[i]?.body?.messages
      const response = (fixture as { response: AimockResponse }).response
      return { request: messages !== undefined ? { messages } : {}, response }
    })
  }

  let stopped = false
  const handle: Aimock = {
    port: mock.port,
    baseUrl: `${mock.url}/v1`,
    addFixtures(fixtures: readonly AimockFixture[]) {
      if (fixtures.length > 0) {
        mock.addFixturesFromJSON(fixtures as never)
      }
    },
    clearFixtures() {
      mock.clearFixtures()
    },
    getRequests() {
      return mock.getRequests() as ReadonlyArray<{
        body: { messages?: Array<{ role: string; content: unknown }> } | null
      }>
    },
    getFixtureCount() {
      return mock.getFixtures().length
    },
    getRecordingsSince(journalStart: number, fixtureStart: number): readonly Recording[] {
      return getRecordingsSince(journalStart, fixtureStart)
    },
    getRecordings(): readonly Recording[] {
      return getRecordingsSince(0, initialFixtureCount)
    },
    async close() {
      if (stopped) return
      stopped = true
      await mock.stop()
      if (recordTmpDir !== null) {
        fs.rmSync(recordTmpDir, { recursive: true, force: true })
      }
    },
    [Symbol.asyncDispose](): Promise<void> {
      return this.close()
    },
  }
  return handle
}
