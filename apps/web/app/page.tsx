import { Hero } from "./components/landing-v2/Hero"
import { ArchitectureSection } from "./components/landing/ArchitectureSection"
import { BigReveal } from "./components/landing/BigReveal"
import { CodeExample } from "./components/landing/CodeExample"
import { ComicStrip } from "./components/landing/ComicStrip"
import { ComparisonTable } from "./components/landing/ComparisonTable"
import { CtaSection } from "./components/landing/CtaSection"
import { DeploySection } from "./components/landing/DeploySection"
import { EcosystemSection } from "./components/landing/EcosystemSection"
import { FeatureGrid } from "./components/landing/FeatureGrid"
import { HowItWorks } from "./components/landing/HowItWorks"
import { MigrateCta } from "./components/landing/MigrateCta"
import { NotAReplacement } from "./components/landing/NotAReplacement"
import { ProblemSection } from "./components/landing/ProblemSection"
import { SolutionSection } from "./components/landing/SolutionSection"
import { StarsSection } from "./components/landing/StarsSection"
import { WhoItsFor } from "./components/landing/WhoItsFor"
import { PaletteScroller } from "./components/PaletteScroller"
import { ScrollReveal } from "./components/ScrollReveal"

export default function HomePage() {
  return (
    <>
      <Hero />
      <div className="landing-dark relative isolate">
        <PaletteScroller />
        <ProblemSection />
        <ScrollReveal>
          <WhoItsFor />
        </ScrollReveal>
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
          <SolutionSection />
        </ScrollReveal>
        <ScrollReveal>
          <ArchitectureSection />
        </ScrollReveal>
        <ScrollReveal>
          <CodeExample />
        </ScrollReveal>
        <ScrollReveal>
          <DeploySection />
        </ScrollReveal>
        <ScrollReveal>
          <EcosystemSection />
        </ScrollReveal>
        <ScrollReveal>
          <FeatureGrid />
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
