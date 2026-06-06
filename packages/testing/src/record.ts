import { spawnSync } from "node:child_process"

export interface RecordOptions {
  readonly out: string
  /** Upstream provider base, default OpenAI. */
  readonly provider?: string
}

/**
 * Records a real provider interaction into an aimock fixture file. LOCAL ONLY —
 * requires a real OPENAI_API_KEY in env. Never run in CI (CI replays strict
 * read-only). Throws on a non-zero recorder exit.
 */
export function record(opts: RecordOptions): void {
  const provider = opts.provider ?? "https://api.openai.com"
  const result = spawnSync(
    "npx",
    [
      "-p",
      "@copilotkit/aimock",
      "llmock",
      "--record",
      "--provider-openai",
      provider,
      "--out",
      opts.out,
    ],
    { stdio: "inherit", env: process.env },
  )
  if (result.status !== 0) {
    throw new Error(`aimock recorder exited with status ${result.status ?? "null"}`)
  }
}
