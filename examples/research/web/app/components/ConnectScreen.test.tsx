import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { CONNECT_SCREEN_HEADING, ConnectScreen } from "./ConnectScreen"

function render(): string {
  return renderToStaticMarkup(
    <ConnectScreen serverUrl="http://127.0.0.1:3002" onRetry={() => {}} />,
  )
}

describe("ConnectScreen", () => {
  test("renders its heading once, and the tests below assert against the same exported string", () => {
    const html = render()
    expect(html).toContain(CONNECT_SCREEN_HEADING)
  })

  test("frames the server URL as a default, not a diagnosis", () => {
    const html = render()
    expect(html).toContain("http://127.0.0.1:3002")
    expect(html).toContain("DAWN_SERVER_URL")
  })

  test("shows the env copy step before the command that starts the server", () => {
    const html = render()
    expect(html).toContain("cp server/.env.example server/.env")
    expect(html).toContain("pnpm dev:server")
  })

  test("does not suggest the combined pnpm dev, which EADDRINUSEs against the running web client", () => {
    const html = render()
    expect(html).not.toMatch(/>pnpm dev<\/code>/)
  })

  test("reminds the reader the server needs a real API key", () => {
    const html = render()
    expect(html).toContain("OPENAI_API_KEY")
  })

  test("renders the brand mark, same as the empty state", () => {
    const html = render()
    expect(html).toContain("wb-brand-mark")
  })

  test("renders a retry button", () => {
    const html = render()
    expect(html).toContain("Try again")
    expect(html).toContain("<button")
  })
})
