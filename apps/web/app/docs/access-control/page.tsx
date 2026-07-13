import type { Metadata } from "next"
import Content from "../../../content/docs/access-control.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Access Control" }

export default function Page() {
  return <DocsPage href="/docs/access-control" Content={Content} />
}
