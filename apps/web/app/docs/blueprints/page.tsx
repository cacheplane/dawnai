import type { Metadata } from "next"
import Content from "../../../content/docs/blueprints.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/blueprints"))

export default function Page() {
  return <DocsPage href="/docs/blueprints" Content={Content} />
}
