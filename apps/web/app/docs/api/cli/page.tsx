import type { Metadata } from "next"
import Content from "../../../../content/docs/api/cli.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "@dawn-ai/cli" }

export default function Page() {
  return <DocsPage href="/docs/api/cli" Content={Content} />
}
