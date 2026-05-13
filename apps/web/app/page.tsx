import { ArchitectureSection } from "./components/landing/ArchitectureSection"
import { BigReveal } from "./components/landing/BigReveal"
import { ComicStrip } from "./components/landing/ComicStrip"
import { ComparisonTable } from "./components/landing/ComparisonTable"
import { CtaSection } from "./components/landing/CtaSection"
import { DeploySection } from "./components/landing/DeploySection"
import { EcosystemSection } from "./components/landing/EcosystemSection"
import { HowItWorks } from "./components/landing/HowItWorks"
import { MigrateCta } from "./components/landing/MigrateCta"
import { NotAReplacement } from "./components/landing/NotAReplacement"
import { StarsSection } from "./components/landing/StarsSection"
import { FeatureDevLoop } from "./components/landing-v2/FeatureDevLoop"
import { FeatureRouting } from "./components/landing-v2/FeatureRouting"
import { FeatureTools } from "./components/landing-v2/FeatureTools"
import { FeatureTypes } from "./components/landing-v2/FeatureTypes"
import { Hero } from "./components/landing-v2/Hero"
import { ProofStrip } from "./components/landing-v2/ProofStrip"
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
      <div className="landing-dark relative isolate">
        <PaletteScroller />
        <ScrollReveal>
          <ComicStrip />
        </ScrollReveal>
        <ScrollReveal>
          <ComparisonTable />
        </ScrollReveal>
        <ScrollReveal>
          <BigReveal />
        </ScrollReveal>
        <ScrollReveal>
          <ArchitectureSection />
        </ScrollReveal>
        <ScrollReveal>
          <DeploySection />
        </ScrollReveal>
        <ScrollReveal>
          <EcosystemSection />
        </ScrollReveal>
        <ScrollReveal>
          <HowItWorks />
        </ScrollReveal>
        <ScrollReveal>
          <StarsSection />
        </ScrollReveal>
        <ScrollReveal>
          <NotAReplacement />
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
