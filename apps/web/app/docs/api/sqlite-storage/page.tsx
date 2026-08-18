import type { Metadata } from "next"
import Content from "../../../../content/docs/api/sqlite-storage.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "@dawn-ai/sqlite-storage" }

export default function Page() {
  return <DocsPage href="/docs/api/sqlite-storage" Content={Content} />
}
