import type { ReactNode } from "react"
import { DocsSidebar } from "../components/docs/DocsSidebar"
import { DocsTOC } from "../components/docs/DocsTOC"
import { DOCS_INDEX } from "../components/docs/search-index"

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-7xl mx-auto px-8 py-12 flex gap-12">
      <DocsSidebar searchIndex={DOCS_INDEX} />
      <section className="flex-1 min-w-0 max-w-3xl">{children}</section>
      <DocsTOC />
    </div>
  )
}
