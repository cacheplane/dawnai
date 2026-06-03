import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { LLMock } from "@copilotkit/aimock"

export interface AimockHandle {
  readonly port: number
  readonly baseUrl: string
  stop(): Promise<void>
}

type FixtureEntry = Record<string, unknown>

function loadEntries(fixturePath: string): FixtureEntry[] {
  const out: FixtureEntry[] = []
  const read = (full: string): void => {
    const parsed = JSON.parse(readFileSync(full, "utf-8")) as { fixtures: FixtureEntry[] }
    for (const fx of parsed.fixtures) out.push(fx)
  }
  if (statSync(fixturePath).isDirectory()) {
    for (const f of readdirSync(fixturePath).filter((n) => n.endsWith(".json")).sort()) {
      read(join(fixturePath, f))
    }
  } else {
    read(fixturePath)
  }
  return out
}

export async function startAimock(opts: { fixturePath: string }): Promise<AimockHandle> {
  const entries = loadEntries(opts.fixturePath)
  const mock = new LLMock({ port: 0, chunkSize: 4096 })
  if (entries.length > 0) mock.addFixturesFromJSON(entries as never)
  await mock.start()
  let stopped = false
  return {
    port: mock.port,
    baseUrl: `${mock.url}/v1`,
    async stop() {
      if (stopped) return
      stopped = true
      await mock.stop()
    },
  }
}
