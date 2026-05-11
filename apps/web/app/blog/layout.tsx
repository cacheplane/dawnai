import type { Metadata } from "next"
import type { ReactNode } from "react"

export const metadata: Metadata = {
  title: { default: "Blog", template: "%s | Dawn Blog" },
  description: "Writing on the agent stack, type-safety, and the tools we're building.",
  alternates: {
    types: { "application/rss+xml": "/blog/rss.xml" },
  },
}

export default function BlogLayout({ children }: { children: ReactNode }) {
  return <>{children}</>
}
