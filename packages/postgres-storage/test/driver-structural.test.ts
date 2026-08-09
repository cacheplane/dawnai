import {
  type Pool as NeonPool,
  type PoolClient as NeonPoolClient,
  neon,
} from "@neondatabase/serverless"
import type { Pool as PgPool, PoolClient as PgPoolClient } from "pg"
import { describe, expect, it } from "vitest"
import type { SqlClient, SqlPool } from "../src/sql.js"

describe("structural SqlPool", () => {
  it("accepts both the node pg pool and the neon WebSocket pool", () => {
    // Compile-time assertions; the runtime body only has to not throw.
    const assignable = (_pool: SqlPool): void => {}
    const assignableClient = (_client: SqlClient): void => {}
    expect(assignable).toBeTypeOf("function")
    expect(assignableClient).toBeTypeOf("function")
    // Type-level: these lines fail `tsc` if the structural type drifts.
    type _A = PgPool extends SqlPool ? true : never
    type _B = NeonPool extends SqlPool ? true : never
    type _C = PgPoolClient extends SqlClient ? true : never
    type _D = NeonPoolClient extends SqlClient ? true : never
    const _checks: [_A, _B, _C, _D] = [true, true, true, true]
    expect(_checks).toEqual([true, true, true, true])
  })

  it("REJECTS neon's transaction-incapable HTTP function", () => {
    // The structural type is itself the guard: neon() has no connect()/end(),
    // so it cannot serve the checkpointer's BEGIN/COMMIT. This must stay a
    // type error — @ts-expect-error fails the build if it ever becomes valid.
    // @ts-expect-error - neon() returns a query function, not a pool
    const _bad: SqlPool = neon("postgres://user:pass@localhost/db")
    expect(typeof neon).toBe("function")
  })
})
