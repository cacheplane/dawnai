import type { Metadata } from "next"
import Content from "../../../../content/docs/deployment/kubernetes.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/deployment/kubernetes"))

export default function Page() {
  return <DocsPage href="/docs/deployment/kubernetes" Content={Content} />
}
