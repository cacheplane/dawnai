import type { Metadata } from "next"
import Content from "../../../content/docs/api.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "API Reference" }

export default function Page() {
  return <DocsPage href="/docs/api" Content={Content} />
}
