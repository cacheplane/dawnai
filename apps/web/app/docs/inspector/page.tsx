import type { Metadata } from "next"
import Content from "../../../content/docs/inspector.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Inspector" }

export default function Page() {
  return <DocsPage href="/docs/inspector" Content={Content} />
}
