import type { Metadata } from "next"
import Content from "../../../../content/docs/api/evals.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "@dawn-ai/evals" }

export default function Page() {
  return <DocsPage href="/docs/api/evals" Content={Content} />
}
