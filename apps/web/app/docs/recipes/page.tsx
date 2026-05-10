import type { Metadata } from "next"
import Content from "../../../content/docs/recipes/index.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Recipes" }

export default function Page() {
  return <DocsPage href="/docs/recipes" Content={Content} />
}
