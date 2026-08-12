import type { Metadata } from "next"
import Content from "../../../../content/docs/memory/distillation.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Distillation" }

export default function Page() {
  return <DocsPage href="/docs/memory/distillation" Content={Content} />
}
