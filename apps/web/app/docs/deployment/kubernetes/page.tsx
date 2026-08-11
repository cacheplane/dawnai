import type { Metadata } from "next"
import Content from "../../../../content/docs/deployment/kubernetes.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Kubernetes" }

export default function Page() {
  return <DocsPage href="/docs/deployment/kubernetes" Content={Content} />
}
