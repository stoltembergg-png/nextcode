import { describe, expect, test } from "bun:test"
import {
  CHOICES,
  MODEL,
  MODELS,
  find,
  profile,
  resolveUrl,
} from "../../src/semif/manifest"

describe("semif manifest", () => {
  test("defaults to LFM2-1.2B Q4_K_M", () => {
    expect(MODEL.id).toBe("LiquidAI/LFM2-1.2B-GGUF")
    expect(MODEL.filename).toBe("LFM2-1.2B-Q4_K_M.gguf")
    expect(MODEL.quant).toBe("Q4_K_M")
    expect(MODEL.bytes).toBe(730_893_248)
    expect(find()).toEqual(MODEL)
    expect(find("   ")).toEqual(MODEL)
  })

  test("popover choices are the default plus the coder and 1.5B models", () => {
    expect(CHOICES.map((entry) => entry.id)).toEqual([
      "LiquidAI/LFM2-1.2B-GGUF",
      "Qwen/Qwen2.5-Coder-3B-Instruct",
      "Qwen/Qwen2.5-1.5B",
    ])
    expect(MODELS.some((entry) => entry.id === "LiquidAI/LFM2-350M-GGUF")).toBe(true)
  })

  test("pins the coder weights to the official GGUF bytes and digest", () => {
    const entry = find("Qwen/Qwen2.5-Coder-3B-Instruct")!
    expect(entry.filename).toBe("qwen2.5-coder-3b-instruct-q4_k_m.gguf")
    expect(entry.bytes).toBe(2_104_932_800)
    expect(entry.sha256).toBe("724fb256bec1ff062b2f65e4569e871ad2e95ab2a3989723d1769c54294730b7")
  })

  test("resolves aliases without silently substituting an unknown model", () => {
    expect(find("LFM2-1.2B-Q4_K_M")?.id).toBe("LiquidAI/LFM2-1.2B-GGUF")
    expect(find("LiquidAI/LFM2-350M-GGUF")?.filename).toBe("LFM2-350M-Q4_K_M.gguf")
    expect(find("Qwen/Qwen2.5-Coder-3B-Instruct")?.family).toBe("qwen")
    expect(find("Qwen/Qwen2.5-Coder-3B-Instruct-GGUF")?.id).toBe("Qwen/Qwen2.5-Coder-3B-Instruct")
    expect(find("Qwen/Qwen2.5-1.5B")?.family).toBe("qwen")
    expect(find("Qwen/Qwen2.5-1.5B-Instruct-GGUF")?.id).toBe("Qwen/Qwen2.5-1.5B")
    expect(find("not-a-model")).toBeUndefined()
  })

  test("LFM2 profiles disable prompt cache and Qwen-family profiles enable it", () => {
    expect(profile(MODEL)).toEqual({
      family: "lfm2",
      source: "LiquidAI/LFM2-1.2B",
      revision: "Q4_K_M",
      cachePrompt: false,
    })
    expect(profile(find("Qwen/Qwen2.5-1.5B")!).cachePrompt).toBe(true)
    expect(profile(find("Qwen/Qwen2.5-Coder-3B-Instruct")!).cachePrompt).toBe(true)
  })

  test("resolveUrl uses the entry URL unless a mirror is set", () => {
    expect(resolveUrl(MODEL, {})).toBe(MODEL.url)
    expect(resolveUrl(MODEL, { NEXTCODE_SEMIF_MODEL_MIRROR: "https://mirror.example/model.gguf" })).toBe(
      "https://mirror.example/model.gguf",
    )
  })
})
