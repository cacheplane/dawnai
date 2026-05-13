import { BigReveal } from "./components/landing/BigReveal"
import { ComicStrip } from "./components/landing/ComicStrip"
import { CtaSection } from "./components/landing/CtaSection"
import { MigrateCta } from "./components/landing/MigrateCta"
import { StarsSection } from "./components/landing/StarsSection"
import { Ecosystem } from "./components/landing-v2/Ecosystem"
import { FeatureDevLoop } from "./components/landing-v2/FeatureDevLoop"
import { FeatureRouting } from "./components/landing-v2/FeatureRouting"
import { FeatureTools } from "./components/landing-v2/FeatureTools"
import { FeatureTypes } from "./components/landing-v2/FeatureTypes"
import { Hero } from "./components/landing-v2/Hero"
import { KeepTheRuntime } from "./components/landing-v2/KeepTheRuntime"
import { ProofStrip } from "./components/landing-v2/ProofStrip"
import { Quickstart } from "./components/landing-v2/Quickstart"
import { WhyDawn } from "./components/landing-v2/WhyDawn"
import { PaletteScroller } from "./components/PaletteScroller"
import { ScrollReveal } from "./components/ScrollReveal"

export default function HomePage() {
  return (
    <>
      <Hero />
      <ProofStrip />
      <WhyDawn />
      <FeatureRouting />
      <FeatureTools />
      <FeatureTypes />
      <FeatureDevLoop />
      <KeepTheRuntime />
      <Ecosystem />
      <Quickstart />
      <div className="landing-dark relative isolate">
        <PaletteScroller />
        <ScrollReveal>
          <ComicStrip />
        </ScrollReveal>
        <ScrollReveal>
          <BigReveal />
        </ScrollReveal>
        <ScrollReveal>
          <StarsSection />
        </ScrollReveal>
        <ScrollReveal>
          <MigrateCta />
        </ScrollReveal>
        <ScrollReveal>
          <CtaSection />
        </ScrollReveal>
      </div>
    </>
  )
}
