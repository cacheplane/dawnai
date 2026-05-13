import type { Metadata } from "next"
import Link from "next/link"
import { Eyebrow } from "./components/ui/Eyebrow"

export const metadata: Metadata = {
  title: "Page not found",
  description: "We couldn't find that page. Try the docs, blog, or the homepage.",
}

interface DestinationProps {
  readonly href: string
  readonly label: string
}

function Destination({ href, label }: DestinationProps) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-saas hover:opacity-80 transition-opacity"
    >
      {label} <span aria-hidden="true">→</span>
    </Link>
  )
}

export default function NotFound() {
  return (
    <section className="bg-page">
      <div className="max-w-[820px] mx-auto px-6 md:px-8 py-24 md:py-32">
        <Eyebrow>404</Eyebrow>
        <h1
          className="font-display font-semibold text-ink mt-3 text-[40px] leading-[44px] md:text-[56px] md:leading-[60px] text-balance"
          style={{
            fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
            letterSpacing: "-0.015em",
          }}
        >
          We couldn't find that page.
        </h1>
        <p className="mt-5 text-lg text-ink-muted leading-[30px] max-w-[52ch]">
          The page may have moved, or the link you followed is out of date. Try one of these
          instead:
        </p>
        <ul className="mt-8 flex flex-wrap gap-x-8 gap-y-3">
          <li>
            <Destination href="/" label="Home" />
          </li>
          <li>
            <Destination href="/docs/getting-started" label="Read the docs" />
          </li>
          <li>
            <Destination href="/blog" label="Latest from the blog" />
          </li>
          <li>
            <Destination href="/brand" label="Brand assets" />
          </li>
        </ul>
      </div>
    </section>
  )
}
