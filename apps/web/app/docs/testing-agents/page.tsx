import type { Metadata } from "next"
import Content from "../../../content/docs/testing-agents.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = {
  title: "Agent Test Harness",
  description: "Test Dawn agents deterministically with the in-process harness.",
}

export default function Page() {
  return <DocsPage href="/docs/testing-agents" Content={Content} />
}
