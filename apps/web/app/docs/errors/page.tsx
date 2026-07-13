import type { Metadata } from "next"
import Content from "../../../content/docs/errors.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Error Codes" }

export default function Page() {
  return <DocsPage href="/docs/errors" Content={Content} />
}
