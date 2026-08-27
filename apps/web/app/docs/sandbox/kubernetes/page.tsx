import type { Metadata } from "next"
import Content from "../../../../content/docs/sandbox/kubernetes.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/sandbox/kubernetes"))

export default function Page() {
  return <DocsPage href="/docs/sandbox/kubernetes" Content={Content} />
}
