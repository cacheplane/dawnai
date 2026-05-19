import type { Metadata } from "next"
import Content from "../../../content/docs/skills.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Skills" }

export default function Page() {
  return <DocsPage href="/docs/skills" Content={Content} />
}
