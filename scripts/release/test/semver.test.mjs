import assert from "node:assert/strict"
import test from "node:test"

import { compareSemver, isExactSemver, parseSemver } from "../semver.mjs"

test("parseSemver parses exact stable, prerelease, and build syntax", () => {
  assert.deepEqual(parseSemver("1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: [],
    build: [],
  })
  assert.deepEqual(parseSemver("1.2.3-beta.2+linux.x64"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: ["beta", 2],
    build: ["linux", "x64"],
  })
})

test("exact SemVer rejects prefixes, ranges, whitespace, and leading zeroes", () => {
  for (const value of [
    "v1.2.3",
    "^1.2.3",
    " 1.2.3",
    "1.2.3 ",
    "1.2",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-beta.01",
    "1.2.3-",
    "1.2.3+",
    "1.2.3+build..1",
  ]) {
    assert.equal(isExactSemver(value), false, value)
    assert.throws(() => parseSemver(value), /Invalid exact SemVer/u)
  }
  assert.equal(isExactSemver("0.0.0"), true)
  assert.equal(isExactSemver("1.2.3-0.alpha+001"), true)
  assert.equal(isExactSemver(123), false)
})

test("compareSemver orders stable versions and prereleases", () => {
  assert.equal(compareSemver("0.8.21", "0.8.22"), -1)
  assert.equal(compareSemver("2.0.0", "1.99.99"), 1)
  assert.equal(compareSemver("1.0.0-beta.2", "1.0.0-beta.10"), -1)
  assert.equal(compareSemver("1.0.0-alpha", "1.0.0-alpha.1"), -1)
  assert.equal(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1)
  assert.equal(compareSemver("1.0.0-beta", "1.0.0"), -1)
})

test("compareSemver ignores build metadata for precedence", () => {
  assert.equal(compareSemver("1.0.0+build.1", "1.0.0+build.2"), 0)
  assert.equal(compareSemver("1.0.0-beta+build.9", "1.0.0-beta+build.1"), 0)
})

test("SemVer accepts and exactly compares core identifiers above MAX_SAFE_INTEGER", () => {
  const lower = "9007199254740992.0.0"
  const higher = "9007199254740993.0.0"

  assert.equal(isExactSemver(lower), true)
  assert.equal(isExactSemver(higher), true)
  assert.equal(parseSemver(higher).major, 9007199254740993n)
  assert.equal(compareSemver(lower, higher), -1)
  assert.equal(compareSemver(higher, lower), 1)
})

test("SemVer exactly compares very large prereleases while rejecting leading zeroes", () => {
  const lower = "1.0.0-beta.90071992547409920000000000000000000000"
  const higher = "1.0.0-beta.90071992547409930000000000000000000000"

  assert.equal(isExactSemver(lower), true)
  assert.equal(isExactSemver(higher), true)
  assert.equal(compareSemver(lower, higher), -1)
  assert.equal(isExactSemver("1.0.0-beta.090071992547409920000000000000000000000"), false)
})
