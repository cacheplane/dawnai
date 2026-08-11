import type { Metadata } from "next"
import Content from "../../../../content/docs/deployment/node.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Node and Docker" }

export default function Page() {
  return <DocsPage href="/docs/deployment/node" Content={Content} />
}
