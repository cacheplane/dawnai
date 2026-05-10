import type { Metadata } from "next"
import Content from "../../../content/docs/migrating-from-langgraph.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Migrating from LangGraph" }

export default function Page() {
  return <DocsPage href="/docs/migrating-from-langgraph" Content={Content} />
}
