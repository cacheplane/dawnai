import type { Metadata } from "next"
import Content from "../../../content/docs/deployment.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Deployment" }

export default function Page() {
  return <DocsPage href="/docs/deployment" Content={Content} promptSlug="deploy" />
}
