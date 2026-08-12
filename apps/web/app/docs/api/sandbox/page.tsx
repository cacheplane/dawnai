import type { Metadata } from "next"
import Content from "../../../../content/docs/api/sandbox.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "@dawn-ai/sandbox" }

export default function Page() {
  return <DocsPage href="/docs/api/sandbox" Content={Content} />
}
