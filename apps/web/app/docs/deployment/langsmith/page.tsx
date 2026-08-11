import type { Metadata } from "next"
import Content from "../../../../content/docs/deployment/langsmith.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "LangSmith" }

export default function Page() {
  return <DocsPage href="/docs/deployment/langsmith" Content={Content} />
}
