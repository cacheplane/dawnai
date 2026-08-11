import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/retry-flaky-tools.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Retry Transient Model Calls" }

export default function Page() {
  return <DocsPage href="/docs/recipes/retry-flaky-tools" Content={Content} />
}
