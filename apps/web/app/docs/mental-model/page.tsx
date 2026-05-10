import type { Metadata } from "next"
import Content from "../../../content/docs/mental-model.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Mental Model" }

export default function Page() {
  return <DocsPage href="/docs/mental-model" Content={Content} />
}
