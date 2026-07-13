import type { Metadata } from "next"
import Content from "../../../content/docs/ag-ui.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "AG-UI & Web Clients" }

export default function Page() {
  return <DocsPage href="/docs/ag-ui" Content={Content} />
}
