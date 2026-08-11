import type { Metadata } from "next"
import Content from "../../../../content/docs/memory/long-term.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Long-term Memory" }

export default function Page() {
  return <DocsPage href="/docs/memory/long-term" Content={Content} />
}
