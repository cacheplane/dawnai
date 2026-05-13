import { Hero } from "./components/landing-v2/Hero"
import { ProofStrip } from "./components/landing-v2/ProofStrip"
import { WhyDawn } from "./components/landing-v2/WhyDawn"
import { FeatureRouting } from "./components/landing-v2/FeatureRouting"
import { FeatureTools } from "./components/landing-v2/FeatureTools"
import { FeatureTypes } from "./components/landing-v2/FeatureTypes"
import { FeatureDevLoop } from "./components/landing-v2/FeatureDevLoop"
import { KeepTheRuntime } from "./components/landing-v2/KeepTheRuntime"
import { Ecosystem } from "./components/landing-v2/Ecosystem"
import { Quickstart } from "./components/landing-v2/Quickstart"
import { Faq } from "./components/landing-v2/Faq"
import { FinalCta } from "./components/landing-v2/FinalCta"

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
      <Faq />
      <FinalCta />
    </>
  )
}
