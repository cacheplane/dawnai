import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/typed-state.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Typed state" }

export default function Page() {
  return <DocsPage href="/docs/recipes/typed-state" Content={Content} />
}
