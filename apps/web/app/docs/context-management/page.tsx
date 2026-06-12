import type { Metadata } from "next"
import Content from "../../../content/docs/context-management.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Context Management" }

export default function Page() {
  return <DocsPage href="/docs/context-management" Content={Content} />
}
