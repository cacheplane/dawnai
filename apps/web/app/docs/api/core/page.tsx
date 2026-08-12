import type { Metadata } from "next"
import Content from "../../../../content/docs/api/core.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "@dawn-ai/core" }

export default function Page() {
  return <DocsPage href="/docs/api/core" Content={Content} />
}
