import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/dispatch-from-route.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Dispatch from a Route" }

export default function Page() {
  return <DocsPage href="/docs/recipes/dispatch-from-route" Content={Content} />
}
