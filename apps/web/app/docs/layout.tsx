import type { ReactNode } from "react"
import { ReadingLayout } from "../components/ReadingLayout"
import { DocsSidebar } from "../components/docs/DocsSidebar"
import { DocsTOC } from "../components/docs/DocsTOC"
import { DOCS_INDEX } from "../components/docs/search-index"

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <ReadingLayout left={<DocsSidebar searchIndex={DOCS_INDEX} />} right={<DocsTOC />}>
      {children}
    </ReadingLayout>
  )
}
