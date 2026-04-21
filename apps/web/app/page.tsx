import { HeroSection } from "./components/landing/HeroSection"
import { ProblemSection } from "./components/landing/ProblemSection"
import { ComparisonTable } from "./components/landing/ComparisonTable"
import { SolutionSection } from "./components/landing/SolutionSection"

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <ProblemSection />
      <ComparisonTable />
      <SolutionSection />
    </>
  )
}
