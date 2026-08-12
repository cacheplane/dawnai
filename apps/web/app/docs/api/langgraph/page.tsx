import type { Metadata } from "next"
import Content from "../../../../content/docs/api/langgraph.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "@dawn-ai/langgraph" }

export default function Page() {
  return <DocsPage href="/docs/api/langgraph" Content={Content} />
}
