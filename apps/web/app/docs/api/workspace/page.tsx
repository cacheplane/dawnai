import type { Metadata } from "next"
import Content from "../../../../content/docs/api/workspace.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "@dawn-ai/workspace" }

export default function Page() {
  return <DocsPage href="/docs/api/workspace" Content={Content} />
}
