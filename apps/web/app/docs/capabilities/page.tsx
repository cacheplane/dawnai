import type { Metadata } from "next"
import Content from "../../../content/docs/capabilities.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Capabilities" }

export default function Page() {
  return <DocsPage href="/docs/capabilities" Content={Content} />
}
