import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/add-a-tool.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Add a tool" }

export default function Page() {
  return <DocsPage href="/docs/recipes/add-a-tool" Content={Content} />
}
