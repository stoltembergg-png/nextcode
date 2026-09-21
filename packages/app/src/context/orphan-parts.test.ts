import { describe, expect, test } from "bun:test"
import { evictForInsert, ORPHAN_PART_LIMIT_PER_SESSION } from "./orphan-parts"

describe("orphan part eviction", () => {
  test("evicts the busy session before a quiet one", () => {
    const store = new Map<string, Map<string, number>>()
    evictForInsert(store, "quiet", "q1", 1)
    for (let i = 0; i < ORPHAN_PART_LIMIT_PER_SESSION + 10; i++) {
      evictForInsert(store, "busy", `b${i}`, i + 10)
    }
    expect(store.get("quiet")?.has("q1")).toBe(true)
    expect(store.get("busy")?.size).toBe(ORPHAN_PART_LIMIT_PER_SESSION)
  })
})
