import type { Metadata } from "next"
import Content from "../../../content/docs/embedding.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Embed the Runtime" }

export default function Page() {
  return <DocsPage href="/docs/embedding" Content={Content} />
}
