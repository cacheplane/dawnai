import type { Metadata } from "next"
import Content from "../../../../content/docs/api/postgres-storage.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "@dawn-ai/postgres-storage" }

export default function Page() {
  return <DocsPage href="/docs/api/postgres-storage" Content={Content} />
}
