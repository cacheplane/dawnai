import type { Metadata } from "next"
import Content from "../../../../content/docs/sandbox/kubernetes.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Kubernetes Sandbox" }

export default function Page() {
  return <DocsPage href="/docs/sandbox/kubernetes" Content={Content} />
}
