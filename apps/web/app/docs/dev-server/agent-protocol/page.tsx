import type { Metadata } from "next"
import Content from "../../../../content/docs/dev-server/agent-protocol.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(
  resolveStaticSeoPage("/docs/dev-server/agent-protocol"),
)

export default function Page() {
  return <DocsPage href="/docs/dev-server/agent-protocol" Content={Content} />
}
