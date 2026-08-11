import type { Metadata } from "next"
import Content from "../../../../content/docs/dev-server/agent-protocol.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Agent Protocol" }

export default function Page() {
  return <DocsPage href="/docs/dev-server/agent-protocol" Content={Content} />
}
