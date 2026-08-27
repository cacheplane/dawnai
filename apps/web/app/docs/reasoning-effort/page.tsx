import type { Metadata } from "next"
import Content from "../../../content/docs/reasoning-effort.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/reasoning-effort"))

export default function Page() {
  return <DocsPage href="/docs/reasoning-effort" Content={Content} />
}
