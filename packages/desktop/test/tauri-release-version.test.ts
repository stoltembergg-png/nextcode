import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const yaml = readFileSync(join(import.meta.dir, "../../../.github/workflows/tauri-release.yml"), "utf8")

describe("tauri-release version", () => {
  test("strips one leading v from a dispatch version before tagging", () => {
    const resolves = yaml.split("name: Resolve the release version").slice(1)
    expect(resolves).toHaveLength(2)
    for (const block of resolves) {
      const next = block.indexOf("\n      - ")
      const script = next === -1 ? block : block.slice(0, next)
      const dispatch = script.slice(script.indexOf("else"))
      const strip = dispatch.indexOf('VERSION="${VERSION#v}"')
      const tag = dispatch.indexOf('TAG="v${VERSION}"')
      expect(dispatch).toContain('VERSION="${INPUT_VERSION:-0.0.0}"')
      expect(strip).toBeGreaterThan(-1)
      expect(tag).toBeGreaterThan(strip)
      expect(dispatch).not.toContain("TAG=\"v${INPUT_VERSION")
    }
  })
})
