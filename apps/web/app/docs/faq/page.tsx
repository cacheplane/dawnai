import type { Metadata } from "next"
import Content from "../../../content/docs/faq.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "FAQ" }

export default function Page() {
  return <DocsPage href="/docs/faq" Content={Content} />
}
