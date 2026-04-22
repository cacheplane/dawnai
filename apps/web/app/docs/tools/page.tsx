import type { Metadata } from "next"
import Content from "../../../content/docs/tools.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Tools" }

export default function Page() {
  return <DocsPage href="/docs/tools" Content={Content} promptSlug="add-a-tool" />
}
