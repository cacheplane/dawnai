import { DriveTheModel } from "./components/landing/DriveTheModel"
import { DurableByDefault } from "./components/landing/DurableByDefault"
import { Ecosystem } from "./components/landing/Ecosystem"
import { Faq } from "./components/landing/Faq"
import { FeatureDevLoop } from "./components/landing/FeatureDevLoop"
import { FeatureRouting } from "./components/landing/FeatureRouting"
import { FeatureTools } from "./components/landing/FeatureTools"
import { FeatureTypes } from "./components/landing/FeatureTypes"
import { FinalCta } from "./components/landing/FinalCta"
import { Hero } from "./components/landing/Hero"
import { KeepTheRuntime } from "./components/landing/KeepTheRuntime"
import { ProofStrip } from "./components/landing/ProofStrip"
import { Quickstart } from "./components/landing/Quickstart"
import { WhyDawn } from "./components/landing/WhyDawn"
import { JsonLd } from "./seo/JsonLd"
import { resolveStaticSeoPage, toMetadata } from "./seo/resolve"
import { webPageJsonLd } from "./seo/structured-data"

const resolvedSeoPage = resolveStaticSeoPage("/")

if (resolvedSeoPage?.kind !== "WebPage") {
  throw new Error("Homepage SEO page is not registered")
}

const seoPage = resolvedSeoPage

export const metadata = toMetadata(seoPage)

export default function HomePage() {
  return (
    <>
      <JsonLd data={webPageJsonLd(seoPage)} />
      <Hero />
      <ProofStrip />
      <WhyDawn />
      <DriveTheModel />
      <FeatureRouting />
      <FeatureTools />
      <FeatureTypes />
      <FeatureDevLoop />
      <DurableByDefault />
      <KeepTheRuntime />
      <Ecosystem />
      <Quickstart />
      <Faq />
      <FinalCta />
    </>
  )
}
