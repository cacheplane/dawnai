import type { Metadata } from "next"
import Content from "../../../content/docs/workspace.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Workspace Filesystem" }

export default function Page() {
  return <DocsPage href="/docs/workspace" Content={Content} />
}
