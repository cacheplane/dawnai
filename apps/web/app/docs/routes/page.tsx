import type { Metadata } from "next"
import Content from "../../../content/docs/routes.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Routes" }

export default function Page() {
  return <DocsPage href="/docs/routes" Content={Content} promptSlug="write-a-route" />
}
