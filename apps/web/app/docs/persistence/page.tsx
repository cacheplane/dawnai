import type { Metadata } from "next"
import Content from "../../../content/docs/persistence.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Persistence and Tenancy" }

export default function Page() {
  return <DocsPage href="/docs/persistence" Content={Content} />
}
