import { describe, expect, it } from "vitest"

import { createExecutionErrorBody, createRequestErrorBody } from "../src/lib/dev/server-errors.js"

describe("server error bodies with an error code", () => {
  it("populates code + docsUrl when a coded error is caught", () => {
    const body = createExecutionErrorBody("Sandbox unavailable: docker run failed", undefined, {
      code: "DAWN_E2001",
    })
    expect(body.error.kind).toBe("execution_error")
    expect(body.error.code).toBe("DAWN_E2001")
    expect(body.error.docsUrl).toBe("https://dawnai.org/docs/sandbox#what-it-is--and-isnt")
  })

  it("omits code + docsUrl when no code is given (unchanged shape)", () => {
    const body = createRequestErrorBody("Malformed request body")
    expect(body.error.message).toBe("Malformed request body")
    expect(body.error).not.toHaveProperty("code")
    expect(body.error).not.toHaveProperty("docsUrl")
  })

  it("includes code but omits docsUrl for a code without a docsPath", () => {
    const body = createRequestErrorBody("Import mismatch", undefined, { code: "DAWN_E5001" })
    expect(body.error.code).toBe("DAWN_E5001")
    expect(body.error).not.toHaveProperty("docsUrl")
  })

  it("retains details alongside a code", () => {
    const body = createRequestErrorBody("boom", { thread: "t1" }, { code: "DAWN_E2001" })
    expect(body.error.details).toEqual({ thread: "t1" })
    expect(body.error.code).toBe("DAWN_E2001")
  })
})
