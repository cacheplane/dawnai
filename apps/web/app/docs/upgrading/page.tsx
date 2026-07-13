import type { Metadata } from "next"
import Content from "../../../content/docs/upgrading.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Upgrading" }

export default function Page() {
  return <DocsPage href="/docs/upgrading" Content={Content} />
}
