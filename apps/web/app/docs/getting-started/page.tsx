import type { Metadata } from "next"
import GettingStarted from "../../../content/docs/getting-started.mdx"

export const metadata: Metadata = {
  title: "Getting Started",
}

export default function GettingStartedPage() {
  return (
    <article className="prose-dawn">
      <GettingStarted />
    </article>
  )
}
