import type { Metadata } from "next"
import Image from "next/image"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Brand Assets",
  description:
    "Download official Dawn AI logos, icons, favicons, social images, and machine-readable asset metadata.",
}

const downloads = [
  {
    label: "Horizontal logo",
    format: "SVG",
    href: "/brand/dawn-logo-horizontal-white.svg",
    note: "White horizontal logo for dark backgrounds, website headers, and documentation.",
  },
  {
    label: "Icon",
    format: "SVG",
    href: "/brand/dawn-icon-white.svg",
    note: "Compact mark for logo grids, integrations, and small UI surfaces.",
  },
  {
    label: "Social avatar",
    format: "PNG",
    href: "/social/dawn-social-avatar-white-on-black-1024.png",
    note: "Square 1024px avatar for profiles, marketplaces, and social surfaces.",
  },
  {
    label: "Favicon",
    format: "ICO",
    href: "/favicon.ico",
    note: "Browser favicon file for web projects and references.",
  },
  {
    label: "Web manifest",
    format: "JSON",
    href: "/site.webmanifest",
    note: "Installable web app metadata for browsers and app surfaces.",
  },
  {
    label: "Asset manifest",
    format: "JSON",
    href: "/brand/assets.json",
    note: "Machine-readable index for coding agents and automation.",
  },
] as const

const dos = [
  "Use the official files as provided.",
  "Use white assets on dark backgrounds and black assets on light backgrounds.",
  "Keep clear space around the logo and icon.",
] as const

const donts = [
  "Do not stretch, recolor, redraw, or modify the mark.",
  "Do not place the logo on low-contrast backgrounds.",
  "Do not use Dawn marks in a way that implies endorsement.",
] as const

export default function BrandPage() {
  return (
    <div className="px-6 py-14 sm:px-8 sm:py-20">
      <section className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-center">
        <div>
          <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-accent-amber">
            Brand Assets
          </p>
          <h1
            className="font-display text-5xl font-semibold tracking-tight text-text-primary md:text-6xl"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
          >
            Dawn Brand Assets
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-text-secondary">
            Official Dawn AI logos, icons, favicons, social images, and machine-readable metadata
            for developers, documentation, and coding agents.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="/brand/dawn-ai-brand-assets.zip"
              className="rounded-md bg-accent-amber px-5 py-2.5 text-sm font-semibold text-bg-primary transition-colors hover:bg-accent-amber-deep"
            >
              Download full brand kit
            </a>
            <a
              href="/brand/assets.json"
              className="rounded-md border border-border px-5 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-text-muted hover:text-text-primary"
            >
              View asset manifest
            </a>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-bg-card/60 p-6 sm:p-8">
          <div className="rounded-md bg-black p-7 sm:p-8">
            <Image
              src="/brand/dawn-logo-horizontal-white.svg"
              alt="Dawn AI horizontal logo"
              width={720}
              height={220}
              className="h-auto w-full"
              priority
            />
          </div>
          <p className="mt-4 text-sm leading-relaxed text-text-muted">
            Use the horizontal logo when space allows. Use the icon for compact placements.
          </p>
        </div>
      </section>

      <section className="mx-auto mt-16 max-w-6xl">
        <div className="mb-6">
          <h2 className="text-2xl font-semibold text-text-primary">Common Downloads</h2>
          <p className="mt-2 text-sm text-text-muted">
            Direct links for the files developers and agents most often need.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {downloads.map((asset) => (
            <a
              key={asset.href}
              href={asset.href}
              className="rounded-lg border border-border bg-bg-card/50 p-4 transition-colors hover:border-accent-amber/50"
            >
              <span className="text-[11px] font-semibold uppercase tracking-widest text-accent-amber">
                {asset.format}
              </span>
              <h3 className="mt-3 text-base font-semibold text-text-primary">{asset.label}</h3>
              <p className="mt-2 text-sm leading-relaxed text-text-muted">{asset.note}</p>
            </a>
          ))}
        </div>
      </section>

      <section className="mx-auto mt-16 grid max-w-6xl gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-bg-card/40 p-6">
          <h2 className="text-xl font-semibold text-text-primary">Usage Guidance</h2>
          <div className="mt-5 grid gap-6 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Do</h3>
              <ul className="mt-3 space-y-3">
                {dos.map((item) => (
                  <li key={item} className="text-sm leading-relaxed text-text-secondary">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Don't</h3>
              <ul className="mt-3 space-y-3">
                {donts.map((item) => (
                  <li key={item} className="text-sm leading-relaxed text-text-secondary">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-bg-card/40 p-6">
          <h2 className="text-xl font-semibold text-text-primary">For Coding Agents</h2>
          <p className="mt-4 text-sm leading-relaxed text-text-secondary">
            Use <code className="text-text-primary">/brand/assets.json</code> as the canonical
            machine-readable index. It lists the full ZIP, common direct URLs, formats, dimensions,
            background guidance, and recommended use cases without requiring HTML scraping.
          </p>
          <div className="mt-5 flex flex-wrap gap-3 text-sm">
            <a href="/brand/assets.json" className="text-accent-amber hover:text-accent-amber-deep">
              Open assets.json
            </a>
            <Link href="/llms.txt" className="text-accent-amber hover:text-accent-amber-deep">
              llms.txt
            </Link>
            <Link href="/llms-full.txt" className="text-accent-amber hover:text-accent-amber-deep">
              llms-full.txt
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
