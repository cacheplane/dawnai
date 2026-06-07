import type { Metadata } from "next"
import Content from "../../../content/docs/evals.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Evals" }

export default function Page() {
  return <DocsPage href="/docs/evals" Content={Content} />
}
