import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { ConnectScreen } from "./ConnectScreen"

describe("ConnectScreen", () => {
  test("names the server URL it tried to reach", () => {
    const html = renderToStaticMarkup(<ConnectScreen serverUrl="http://127.0.0.1:3002" />)
    expect(html).toContain("http://127.0.0.1:3002")
  })

  test("shows the command that starts the server", () => {
    const html = renderToStaticMarkup(<ConnectScreen serverUrl="http://127.0.0.1:3002" />)
    expect(html).toContain("pnpm dev")
  })

  test("reminds the reader the server needs a real API key", () => {
    const html = renderToStaticMarkup(<ConnectScreen serverUrl="http://127.0.0.1:3002" />)
    expect(html).toContain("OPENAI_API_KEY")
  })

  test("renders the brand mark, same as the empty state", () => {
    const html = renderToStaticMarkup(<ConnectScreen serverUrl="http://127.0.0.1:3002" />)
    expect(html).toContain("wb-brand-mark")
  })

  test("names the override env var for a non-default server URL", () => {
    const html = renderToStaticMarkup(<ConnectScreen serverUrl="http://127.0.0.1:3002" />)
    expect(html).toContain("DAWN_SERVER_URL")
  })
})
