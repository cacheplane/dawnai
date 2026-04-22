import type { Metadata } from "next"
import Content from "../../../content/docs/cli.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "CLI Reference" }

export default function Page() {
  return <DocsPage href="/docs/cli" Content={Content} />
}
