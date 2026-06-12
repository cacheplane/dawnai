import type { Metadata } from "next"
import Content from "../../../content/docs/configuration.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "dawn.config.ts Reference" }

export default function Page() {
  return <DocsPage href="/docs/configuration" Content={Content} />
}
