import assert from "node:assert/strict"
import test from "node:test"

import { internalDependencies, orderReleasePackages } from "../topology.mjs"

test("internalDependencies returns sorted runtime and peer workspace dependencies", () => {
  const packageJson = {
    name: "middle",
    dependencies: { base: "workspace:*", external: "^1.0.0" },
    optionalDependencies: { optional: "workspace:^" },
    peerDependencies: { peer: "workspace:~" },
    devDependencies: { dev: "workspace:*" },
  }

  assert.deepEqual(
    internalDependencies(packageJson, ["middle", "base", "optional", "peer", "dev"]),
    ["base", "optional", "peer"],
  )
})

test("internalDependencies rejects workspace dependencies outside the canonical inventory", () => {
  assert.throws(
    () =>
      internalDependencies({ name: "middle", dependencies: { missing: "workspace:*" } }, [
        "middle",
      ]),
    /missing.*canonical release inventory/u,
  )
})

test("orderReleasePackages is dependency-first and puts create-dawn-ai-app final", () => {
  const packages = [
    { name: "create-dawn-ai-app", dependencies: { middle: "workspace:*" } },
    { name: "middle", dependencies: { base: "workspace:*" } },
    { name: "base" },
  ]

  assert.deepEqual(orderReleasePackages(packages), ["base", "middle", "create-dawn-ai-app"])
})

test("orderReleasePackages breaks ready-package ties alphabetically", () => {
  const packages = [
    { name: "zeta" },
    { name: "alpha" },
    { name: "middle", dependencies: { alpha: "workspace:*" } },
  ]

  assert.deepEqual(orderReleasePackages(packages, { gateOrder: [] }), ["alpha", "middle", "zeta"])
})

test("orderReleasePackages delays gate packages while preserving dependencies", () => {
  const packages = [
    { name: "create-dawn-ai-app", dependencies: { middle: "workspace:*" } },
    { name: "middle", dependencies: { base: "workspace:*" } },
    { name: "base" },
    { name: "unrelated" },
  ]

  assert.deepEqual(orderReleasePackages(packages, { gateOrder: ["create-dawn-ai-app"] }), [
    "base",
    "middle",
    "unrelated",
    "create-dawn-ai-app",
  ])
})

test("orderReleasePackages rejects cycles", () => {
  assert.throws(
    () =>
      orderReleasePackages([
        { name: "a", dependencies: { b: "workspace:*" } },
        { name: "b", dependencies: { a: "workspace:*" } },
      ]),
    /cycle.*a, b/u,
  )
})

test("orderReleasePackages rejects duplicate or invalid package identities", () => {
  assert.throws(() => orderReleasePackages([{ name: "a" }, { name: "a" }]), /duplicate.*a/u)
  assert.throws(() => orderReleasePackages([{ name: "" }]), /non-empty name/u)
})
