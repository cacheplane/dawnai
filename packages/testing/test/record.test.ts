import { expect, it, vi } from "vitest"

const spawnSync = vi.fn(() => ({ status: 0 }))
vi.mock("node:child_process", () => ({ spawnSync }))

it("invokes the aimock recorder with the right argv", async () => {
  const { record } = await import("../src/record.js")
  record({ out: "/tmp/x.fixture.json", provider: "https://api.openai.com" })
  expect(spawnSync).toHaveBeenCalledWith(
    "npx",
    [
      "-p",
      "@copilotkit/aimock",
      "llmock",
      "--record",
      "--provider-openai",
      "https://api.openai.com",
      "--out",
      "/tmp/x.fixture.json",
    ],
    expect.objectContaining({ stdio: "inherit" }),
  )
})

it("defaults provider to OpenAI", async () => {
  spawnSync.mockClear()
  const { record } = await import("../src/record.js")
  record({ out: "/tmp/y.json" })
  const call = spawnSync.mock.calls[0]
  expect(call?.[1]).toContain("https://api.openai.com")
})

it("throws on non-zero recorder exit", async () => {
  spawnSync.mockReturnValueOnce({ status: 2 } as never)
  const { record } = await import("../src/record.js")
  expect(() => record({ out: "/tmp/z.json" })).toThrow()
})
