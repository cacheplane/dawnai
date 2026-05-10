import type { Metadata } from "next"
import Content from "../../../content/docs/agents.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Agents" }

export default function Page() {
  return <DocsPage href="/docs/agents" Content={Content} />
}
