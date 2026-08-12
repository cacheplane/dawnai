import type { Metadata } from "next"
import Content from "../../../../content/docs/deployment/edge.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Edge and Hono" }

export default function Page() {
  return <DocsPage href="/docs/deployment/edge" Content={Content} />
}
