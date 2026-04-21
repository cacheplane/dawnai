import { HeroSection } from "./components/landing/HeroSection"
import { ProblemSection } from "./components/landing/ProblemSection"
import { ComparisonTable } from "./components/landing/ComparisonTable"
import { SolutionSection } from "./components/landing/SolutionSection"
import { CodeExample } from "./components/landing/CodeExample"
import { DeploySection } from "./components/landing/DeploySection"
import { FeatureGrid } from "./components/landing/FeatureGrid"
import { HowItWorks } from "./components/landing/HowItWorks"
import { EcosystemSection } from "./components/landing/EcosystemSection"
import { CtaSection } from "./components/landing/CtaSection"

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
