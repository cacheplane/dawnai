import type { ReactNode } from "react"
import { DocsSidebar } from "../components/docs/DocsSidebar"
import { DocsTOC } from "../components/docs/DocsTOC"
import { DOCS_INDEX } from "../components/docs/search-index"

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)_240px] xl:grid-cols-[280px_minmax(0,1fr)_240px]">
      <aside className="hidden md:block sticky top-16 self-start h-[calc(100vh-4rem)] overflow-y-auto px-6 py-8 border-r border-border-subtle">
        <DocsSidebar searchIndex={DOCS_INDEX} />
      </aside>
      <section className="min-w-0 px-6 md:px-12 py-12 max-w-[760px] mx-auto w-full">
        {children}
      </section>
      <aside className="hidden lg:block sticky top-16 self-start h-[calc(100vh-4rem)] overflow-y-auto px-6 py-8 border-l border-border-subtle">
        <DocsTOC />
      </aside>
    </div>
  )
}
