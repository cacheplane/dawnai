import type { Metadata } from "next"
import Content from "../../../content/docs/memory.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Memory" }

export default function Page() {
  return <DocsPage href="/docs/memory" Content={Content} />
}
