import type { Metadata } from "next"
import Content from "../../../content/docs/skills.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/skills"))

export default function Page() {
  return <DocsPage href="/docs/skills" Content={Content} />
}
