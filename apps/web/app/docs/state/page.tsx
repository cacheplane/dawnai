import type { Metadata } from "next"
import Content from "../../../content/docs/state.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "State" }

export default function Page() {
  return <DocsPage href="/docs/state" Content={Content} />
}
