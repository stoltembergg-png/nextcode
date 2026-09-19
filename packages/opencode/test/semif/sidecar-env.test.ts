import { describe, expect, test } from "bun:test"

describe("semif sidecar spawn env", () => {
  test("ROCm spawn env only sets ROCBLAS_TENSILE_LIBPATH without PATH mutation", () => {
    const tensile = "C:\\runtime\\rocblas\\library"
    const previousPath = process.env.PATH
    const env = { ROCBLAS_TENSILE_LIBPATH: tensile }
    expect(Object.keys(env)).toEqual(["ROCBLAS_TENSILE_LIBPATH"])
    expect(env.ROCBLAS_TENSILE_LIBPATH).toBe(tensile)
    expect(process.env.PATH).toBe(previousPath)
  })
})
