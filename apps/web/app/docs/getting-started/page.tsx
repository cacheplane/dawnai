import type { Metadata } from "next"
import GettingStarted from "../../../content/docs/getting-started.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/getting-started"))

export default function Page() {
  return (
    <DocsPage
      href="/docs/getting-started"
      Content={GettingStarted}
      promptSlug="scaffold"
      promptPitch="Copy a prompt that instructs your coding agent to scaffold a Dawn app and walk through the structure with you."
    />
  )
}
