import type { Metadata } from "next"
import Content from "../../../content/docs/subagents.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Subagents" }

export default function Page() {
  return <DocsPage href="/docs/subagents" Content={Content} />
}
