import type { Metadata } from "next"
import Content from "../../../../content/docs/testing-agents/fixtures.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Fixtures and Recording" }

export default function Page() {
  return <DocsPage href="/docs/testing-agents/fixtures" Content={Content} />
}
