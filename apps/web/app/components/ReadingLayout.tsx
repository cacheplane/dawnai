import type { ReactNode } from "react"

interface ReadingLayoutProps {
  readonly left: ReactNode
  readonly right: ReactNode
  readonly children: ReactNode
}

export function ReadingLayout({ left, right, children }: ReadingLayoutProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)_240px] xl:grid-cols-[280px_minmax(0,1fr)_240px]">
      <aside className="hidden md:block sticky self-start overflow-y-auto px-6 py-8 border-r border-divider top-[var(--header-h)] h-[calc(100vh-var(--header-h))]">
        {left}
      </aside>
      <section className="min-w-0 px-6 md:px-12 py-12 max-w-[760px] mx-auto w-full">
        {children}
      </section>
      <aside className="hidden lg:block sticky self-start overflow-y-auto px-6 py-8 border-l border-divider top-[var(--header-h)] h-[calc(100vh-var(--header-h))]">
        {right}
      </aside>
    </div>
  )
}
