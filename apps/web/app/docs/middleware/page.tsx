import type { Metadata } from "next"
import Content from "../../../content/docs/middleware.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Middleware" }

export default function Page() {
  return <DocsPage href="/docs/middleware" Content={Content} />
}
