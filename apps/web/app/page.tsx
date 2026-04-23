import { ArchitectureSection } from "./components/landing/ArchitectureSection"
import { CodeExample } from "./components/landing/CodeExample"
import { ComparisonTable } from "./components/landing/ComparisonTable"
import { CtaSection } from "./components/landing/CtaSection"
import { DeploySection } from "./components/landing/DeploySection"
import { EcosystemSection } from "./components/landing/EcosystemSection"
import { FeatureGrid } from "./components/landing/FeatureGrid"
import { HeroSection } from "./components/landing/HeroSection"
import { HowItWorks } from "./components/landing/HowItWorks"
import { LandingAmbient } from "./components/landing/LandingAmbient"
import { LogoWall } from "./components/landing/LogoWall"
import { ProblemSection } from "./components/landing/ProblemSection"
import { SolutionSection } from "./components/landing/SolutionSection"
import { StatsStrip } from "./components/landing/StatsStrip"
import { ScrollReveal } from "./components/ScrollReveal"

export default function HomePage() {
  return (
    <div className="relative isolate">
      <LandingAmbient />
      {/* Hero / Stats / Problem aren't wrapped — the seamless navy bleed across them
          would break if their bgs faded in independently. Reveals begin at ComparisonTable. */}
      <HeroSection />
      <StatsStrip />
      <LogoWall />
      <ProblemSection />
      <ScrollReveal>
        <ComparisonTable />
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
        <FeatureGrid />
      </ScrollReveal>
      <ScrollReveal>
        <HowItWorks />
      </ScrollReveal>
      <ScrollReveal>
        <EcosystemSection />
      </ScrollReveal>
      <ScrollReveal>
        <CtaSection />
      </ScrollReveal>
    </div>
  )
}
