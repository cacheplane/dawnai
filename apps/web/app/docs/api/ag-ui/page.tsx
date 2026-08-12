import type { Metadata } from "next"
import Content from "../../../../content/docs/api/ag-ui.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "@dawn-ai/ag-ui" }

export default function Page() {
  return <DocsPage href="/docs/api/ag-ui" Content={Content} />
}
