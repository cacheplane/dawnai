import { isAbsolute, join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveEnvPath } from "../src/lib/dev/resolve-env-path.js"

const APP = "/work/app"

describe("resolveEnvPath", () => {
  it("defaults to <appRoot>/.env", () => {
    const r = resolveEnvPath({ appRoot: APP })
    expect(r.source).toBe("default")
    expect(r.absPath).toBe(join(APP, ".env"))
  })

  it("uses config.env relative to appRoot", () => {
    const r = resolveEnvPath({ appRoot: APP, configEnv: "../.env" })
    expect(r.source).toBe("config")
    expect(r.absPath).toBe(join(APP, "../.env"))
  })

  it("flag wins over config", () => {
    const r = resolveEnvPath({ appRoot: APP, configEnv: "../.env", flag: "custom.env" })
    expect(r.source).toBe("flag")
    expect(r.absPath).toBe(join(APP, "custom.env"))
  })

  it("absolute flag passes through unchanged", () => {
    const r = resolveEnvPath({ appRoot: APP, flag: "/etc/secrets/.env" })
    expect(r.source).toBe("flag")
    expect(isAbsolute(r.absPath)).toBe(true)
    expect(r.absPath).toBe("/etc/secrets/.env")
  })

  it("absolute config.env passes through unchanged", () => {
    const r = resolveEnvPath({ appRoot: APP, configEnv: "/abs/.env" })
    expect(r.absPath).toBe("/abs/.env")
  })
})
