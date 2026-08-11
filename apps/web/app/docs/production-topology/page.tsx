import type { Metadata } from "next"
import Content from "../../../content/docs/production-topology.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Production Topology" }

export default function Page() {
  return <DocsPage href="/docs/production-topology" Content={Content} />
}
