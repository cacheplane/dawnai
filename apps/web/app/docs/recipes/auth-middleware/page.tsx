import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/auth-middleware.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Auth middleware" }

export default function Page() {
  return <DocsPage href="/docs/recipes/auth-middleware" Content={Content} />
}
