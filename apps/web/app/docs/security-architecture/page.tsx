import type { Metadata } from "next"
import Content from "../../../content/docs/security-architecture.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Security Architecture" }

export default function Page() {
  return <DocsPage href="/docs/security-architecture" Content={Content} />
}
