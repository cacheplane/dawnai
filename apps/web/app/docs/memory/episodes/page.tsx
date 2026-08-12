import type { Metadata } from "next"
import Content from "../../../../content/docs/memory/episodes.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Episodes" }

export default function Page() {
  return <DocsPage href="/docs/memory/episodes" Content={Content} />
}
