import type { Metadata } from "next"
import Content from "../../../content/docs/sandbox.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Execution Sandbox" }

export default function Page() {
  return <DocsPage href="/docs/sandbox" Content={Content} />
}
