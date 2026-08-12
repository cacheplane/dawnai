import type { Metadata } from "next"
import Content from "../../../../content/docs/api/generated-routes.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "dawn:routes" }

export default function Page() {
  return <DocsPage href="/docs/api/generated-routes" Content={Content} />
}
