// Compile-time tripwire: @dawn-ai/core's structural MemoryStoreLike (config-facing)
// and @dawn-ai/memory's MemoryStore (runtime contract) must stay mutually
// assignable. Core cannot import memory (node:sqlite barrel), so the duplicated
// literal unions live in both packages — this file is where drift fails LOCALLY
// and legibly instead of as an assignability wall in resolve-memory.ts.
import type {
  MemoryKindLike,
  MemorySourceTypeLike,
  MemoryStatusLike,
  MemoryStoreLike,
} from "@dawn-ai/core"
import type { MemoryKind, MemorySource, MemoryStatus, MemoryStore } from "@dawn-ai/memory"
import { expect, it } from "vitest"

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

const kind: Mutual<MemoryKind, MemoryKindLike> = true
const status: Mutual<MemoryStatus, MemoryStatusLike> = true
const sourceType: Mutual<MemorySource["type"], MemorySourceTypeLike> = true
const store: Mutual<MemoryStore, MemoryStoreLike> = true

it("memory/core store contracts are mutually assignable (compile-time)", () => {
  expect([kind, status, sourceType, store]).toEqual([true, true, true, true])
})
