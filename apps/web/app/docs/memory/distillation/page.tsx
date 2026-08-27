import type { Metadata } from "next"
import Content from "../../../../content/docs/memory/distillation.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/memory/distillation"))

export default function Page() {
  return <DocsPage href="/docs/memory/distillation" Content={Content} />
}
