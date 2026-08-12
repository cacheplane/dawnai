import type { Metadata } from "next"
import Content from "../../../../content/docs/api/testing.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "@dawn-ai/testing" }

export default function Page() {
  return <DocsPage href="/docs/api/testing" Content={Content} />
}
