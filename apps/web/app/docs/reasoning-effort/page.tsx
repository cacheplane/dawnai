import type { Metadata } from "next"
import Content from "../../../content/docs/reasoning-effort.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Reasoning Effort" }

export default function Page() {
  return <DocsPage href="/docs/reasoning-effort" Content={Content} />
}
