import type { Metadata } from "next"
import Content from "../../../content/docs/thread-access.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Thread Access" }

export default function Page() {
  return <DocsPage href="/docs/thread-access" Content={Content} />
}
