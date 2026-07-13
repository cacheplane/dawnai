import { describe, expect, test } from "vitest"

import type { Docker } from "../src/docker/docker-cli.js"
import { dockerSandbox } from "../src/docker/docker-sandbox.js"

const signal = () => new AbortController().signal

describe("sandbox unavailable errors carry the DAWN_E2001 code", () => {
  test("a failed container creation throws an error tagged DAWN_E2001", async () => {
    const docker: Docker = {
      run: async (args: readonly string[]) => {
        // Fail only the detached container creation (`run -d …`).
        if (args[0] === "run" && args.includes("-d")) {
          return { stdout: "", stderr: "no space left on device", exitCode: 1 }
        }
        return { stdout: "", stderr: "", exitCode: 0 }
      },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    }
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await expect(
      p.acquire({ threadId: "t1", policy: { network: { mode: "deny" } }, signal: signal() }),
    ).rejects.toMatchObject({ code: "DAWN_E2001" })
  })
})
