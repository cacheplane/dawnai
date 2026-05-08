import type { Metadata } from "next"
import Content from "../../../content/docs/retry.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Retry" }

export default function Page() {
  return <DocsPage href="/docs/retry" Content={Content} />
}
