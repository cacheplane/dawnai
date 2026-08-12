import type { Metadata } from "next"
import Content from "../../../../content/docs/memory/retrieval.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Recall and Retrieval" }

export default function Page() {
  return <DocsPage href="/docs/memory/retrieval" Content={Content} />
}
