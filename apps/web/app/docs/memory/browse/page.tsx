import type { Metadata } from "next"
import Content from "../../../../content/docs/memory/browse.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Browse and Manage Memory" }

export default function Page() {
  return <DocsPage href="/docs/memory/browse" Content={Content} />
}
