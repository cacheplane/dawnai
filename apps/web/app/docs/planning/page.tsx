import type { Metadata } from "next"
import Content from "../../../content/docs/planning.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Planning" }

export default function Page() {
  return <DocsPage href="/docs/planning" Content={Content} />
}
