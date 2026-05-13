import { Ecosystem } from "./components/landing-v2/Ecosystem"
import { Faq } from "./components/landing-v2/Faq"
import { FeatureDevLoop } from "./components/landing-v2/FeatureDevLoop"
import { FeatureRouting } from "./components/landing-v2/FeatureRouting"
import { FeatureTools } from "./components/landing-v2/FeatureTools"
import { FeatureTypes } from "./components/landing-v2/FeatureTypes"
import { FinalCta } from "./components/landing-v2/FinalCta"
import { Hero } from "./components/landing-v2/Hero"
import { KeepTheRuntime } from "./components/landing-v2/KeepTheRuntime"
import { ProofStrip } from "./components/landing-v2/ProofStrip"
import { Quickstart } from "./components/landing-v2/Quickstart"
import { WhyDawn } from "./components/landing-v2/WhyDawn"

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
