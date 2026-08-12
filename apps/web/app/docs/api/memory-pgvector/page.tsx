import type { Metadata } from "next"
import Content from "../../../../content/docs/api/memory-pgvector.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "@dawn-ai/memory-pgvector" }

export default function Page() {
  return <DocsPage href="/docs/api/memory-pgvector" Content={Content} />
}
