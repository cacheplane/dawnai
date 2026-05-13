import Link from "next/link"
import type { ReactNode } from "react"
import { Eyebrow } from "../ui/Eyebrow"

interface FeatureBlockProps {
  readonly eyebrow: string
  readonly heading: string
  readonly paragraph: string
  readonly bullets: readonly string[]
  readonly link?: { readonly href: string; readonly label: string }
  readonly visual: ReactNode
  readonly imageSide?: "left" | "right"
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
      className="w-4 h-4 mt-1 text-accent-saas shrink-0"
    >
      <path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function FeatureBlock({
  eyebrow,
  heading,
  paragraph,
  bullets,
  link,
  visual,
  imageSide = "right",
}: FeatureBlockProps) {
  const textColumn = (
    <div>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h3
        className="font-display font-semibold text-ink mt-3 text-[28px] leading-[34px] md:text-[36px] md:leading-[42px]"
        style={{
          fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
          letterSpacing: "-0.01em",
        }}
      >
        {heading}
      </h3>
      <p className="mt-5 text-base text-ink-muted leading-[26px] max-w-[52ch]">
        {paragraph}
      </p>
      <ul className="mt-6 space-y-2.5">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-2.5 text-sm text-ink leading-[22px]">
            <CheckIcon />
            <span>{b}</span>
          </li>
        ))}
      </ul>
      {link !== undefined ? (
        <Link
          href={link.href}
          className="mt-7 inline-flex items-center gap-1.5 text-sm font-medium text-accent-saas hover:opacity-80 transition-opacity"
        >
          {link.label} <span aria-hidden="true">→</span>
        </Link>
      ) : null}
    </div>
  )

  const visualColumn = <div className="w-full">{visual}</div>

  return (
    <section className="bg-page border-b border-divider">
      <div className="max-w-[1200px] mx-auto px-6 md:px-8 py-20 md:py-28">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {imageSide === "left" ? (
            <>
              <div className="lg:order-1 order-2">{visualColumn}</div>
              <div className="lg:order-2 order-1">{textColumn}</div>
            </>
          ) : (
            <>
              {textColumn}
              {visualColumn}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
