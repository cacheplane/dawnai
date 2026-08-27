import type { Metadata } from "next"
import Content from "../../../content/docs/security-architecture.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/security-architecture"))

export default function Page() {
  return <DocsPage href="/docs/security-architecture" Content={Content} />
}
