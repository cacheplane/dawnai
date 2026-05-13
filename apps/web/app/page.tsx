import { Ecosystem } from "./components/landing/Ecosystem"
import { Faq } from "./components/landing/Faq"
import { FeatureDevLoop } from "./components/landing/FeatureDevLoop"
import { FeatureRouting } from "./components/landing/FeatureRouting"
import { FeatureTools } from "./components/landing/FeatureTools"
import { FeatureTypes } from "./components/landing/FeatureTypes"
import { FinalCta } from "./components/landing/FinalCta"
import { Hero } from "./components/landing/Hero"
import { KeepTheRuntime } from "./components/landing/KeepTheRuntime"
import { ProofStrip } from "./components/landing/ProofStrip"
import { Quickstart } from "./components/landing/Quickstart"
import { WhyDawn } from "./components/landing/WhyDawn"

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
