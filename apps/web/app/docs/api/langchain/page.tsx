import type { Metadata } from "next"
import Content from "../../../../content/docs/api/langchain.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "@dawn-ai/langchain" }

export default function Page() {
  return <DocsPage href="/docs/api/langchain" Content={Content} />
}
