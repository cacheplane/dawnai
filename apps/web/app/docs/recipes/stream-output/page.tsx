import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/stream-output.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Stream output" }

export default function Page() {
  return <DocsPage href="/docs/recipes/stream-output" Content={Content} />
}
