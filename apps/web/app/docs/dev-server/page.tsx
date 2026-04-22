import type { Metadata } from "next"
import Content from "../../../content/docs/dev-server.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Dev Server" }

export default function Page() {
  return <DocsPage href="/docs/dev-server" Content={Content} />
}
