import type { Metadata } from "next"
import Content from "../../../content/docs/observability.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Observability" }

export default function Page() {
  return <DocsPage href="/docs/observability" Content={Content} />
}
