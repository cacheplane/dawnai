import type { Metadata } from "next"
import Content from "../../../../content/docs/api/permissions.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "@dawn-ai/permissions" }

export default function Page() {
  return <DocsPage href="/docs/api/permissions" Content={Content} />
}
