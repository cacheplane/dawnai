import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/research-web-ui.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Research assistant web UI" }

export default function Page() {
  return <DocsPage href="/docs/recipes/research-web-ui" Content={Content} />
}
