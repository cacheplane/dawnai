import type { ReactNode } from "react"
import { DocsSidebar } from "../components/docs/DocsSidebar"
import { DocsTOC } from "../components/docs/DocsTOC"
import { DOCS_INDEX } from "../components/docs/search-index"
import { ReadingLayout } from "../components/ReadingLayout"

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <ReadingLayout left={<DocsSidebar searchIndex={DOCS_INDEX} />} right={<DocsTOC />}>
      {children}
    </ReadingLayout>
  )
}
