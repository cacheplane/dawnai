import type { Metadata } from "next"
import Content from "../../../content/docs/permissions.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Permissions" }

export default function Page() {
  return <DocsPage href="/docs/permissions" Content={Content} />
}
