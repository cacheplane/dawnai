import type { Metadata } from "next"
import Content from "../../../content/docs/testing-agents.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Testing Agents" }

export default function Page() {
  return <DocsPage href="/docs/testing-agents" Content={Content} />
}
