import { CodeExample } from "./components/landing/CodeExample"
import { ComparisonTable } from "./components/landing/ComparisonTable"
import { CtaSection } from "./components/landing/CtaSection"
import { DeploySection } from "./components/landing/DeploySection"
import { EcosystemSection } from "./components/landing/EcosystemSection"
import { FeatureGrid } from "./components/landing/FeatureGrid"
import { HeroSection } from "./components/landing/HeroSection"
import { HowItWorks } from "./components/landing/HowItWorks"
import { ProblemSection } from "./components/landing/ProblemSection"
import { SolutionSection } from "./components/landing/SolutionSection"

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <ProblemSection />
      <ComparisonTable />
      <SolutionSection />
      <CodeExample />
      <DeploySection />
      <FeatureGrid />
      <HowItWorks />
      <EcosystemSection />
      <CtaSection />
    </>
  )
}
