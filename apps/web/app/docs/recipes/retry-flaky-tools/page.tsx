import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/retry-flaky-tools.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(
  resolveStaticSeoPage("/docs/recipes/retry-flaky-tools"),
)

export default function Page() {
  return <DocsPage href="/docs/recipes/retry-flaky-tools" Content={Content} />
}
