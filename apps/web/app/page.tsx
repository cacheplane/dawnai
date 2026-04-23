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
import { ProblemSection } from "./components/landing/ProblemSection"
import { SolutionSection } from "./components/landing/SolutionSection"
import { StatsStrip } from "./components/landing/StatsStrip"

export default function HomePage() {
  return (
    <div className="relative isolate">
      <LandingAmbient />
      <HeroSection />
      <StatsStrip />
      <ProblemSection />
      <ComparisonTable />
      <SolutionSection />
      <ArchitectureSection />
      <CodeExample />
      <DeploySection />
      <FeatureGrid />
      <HowItWorks />
      <EcosystemSection />
      <CtaSection />
    </div>
  )
}
