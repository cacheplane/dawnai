import type { Metadata } from "next"
import Content from "../../../content/docs/testing.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Testing" }

export default function Page() {
  return <DocsPage href="/docs/testing" Content={Content} promptSlug="write-a-test" />
}
