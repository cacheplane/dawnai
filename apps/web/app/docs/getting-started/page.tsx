import type { Metadata } from "next"
import GettingStarted from "../../../content/docs/getting-started.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = {
  title: "Getting Started",
}

export default function Page() {
  return (
    <DocsPage
      href="/docs/getting-started"
      Content={GettingStarted}
      promptSlug="scaffold"
      promptPitch="Copy a prompt that instructs Claude Code, Cursor, or any coding agent to scaffold a Dawn app and walk through the structure with you."
    />
  )
}
