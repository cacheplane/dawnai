import type { Metadata } from "next"
import Content from "../../../../content/docs/api/sdk.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "@dawn-ai/sdk" }

export default function Page() {
  return <DocsPage href="/docs/api/sdk" Content={Content} />
}
