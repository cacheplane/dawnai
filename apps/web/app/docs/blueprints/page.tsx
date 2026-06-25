import type { Metadata } from "next"
import Content from "../../../content/docs/blueprints.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Blueprints" }

export default function Page() {
  return <DocsPage href="/docs/blueprints" Content={Content} />
}
