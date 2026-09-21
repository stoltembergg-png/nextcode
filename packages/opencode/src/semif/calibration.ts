export type Case = { task?: string; expectedIndex: number; probabilities: number[] }

export function summarize(cases: readonly Case[]) {
  if (cases.length === 0) {
    return {
      accuracy: 0,
      margin: 0,
      brier: 0,
      ece: 0,
      coverage: {} as Record<string, { covered: number; accuracy: number }>,
    }
  }
  let correct = 0
  let margin = 0
  let brier = 0
  const bins = Array.from({ length: 10 }, () => ({ conf: 0, acc: 0, n: 0 }))
  for (const item of cases) {
    const best = item.probabilities.reduce((b, v, i) => (v > item.probabilities[b]! ? i : b), 0)
    if (best === item.expectedIndex) correct += 1
    const sorted = [...item.probabilities].sort((a, b) => b - a)
    margin += (sorted[0] ?? 0) - (sorted[1] ?? 0)
    brier += item.probabilities.reduce((sum, p, i) => sum + (p - (i === item.expectedIndex ? 1 : 0)) ** 2, 0)
    const conf = item.probabilities[best] ?? 0
    const bin = Math.min(9, Math.floor(conf * 10))
    bins[bin]!.n += 1
    bins[bin]!.conf += conf
    bins[bin]!.acc += best === item.expectedIndex ? 1 : 0
  }
  const n = cases.length
  const ece = bins.reduce((sum, bin) => {
    if (bin.n === 0) return sum
    return sum + (bin.n / n) * Math.abs(bin.acc / bin.n - bin.conf / bin.n)
  }, 0)
  const coverage: Record<string, { covered: number; accuracy: number }> = {}
  for (const t of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    const subset = cases.filter((item) => Math.max(...item.probabilities) >= t)
    const hits = subset.filter((item) => {
      const best = item.probabilities.reduce((b, v, i) => (v > item.probabilities[b]! ? i : b), 0)
      return best === item.expectedIndex
    }).length
    coverage[String(t)] = { covered: subset.length / n, accuracy: subset.length === 0 ? 0 : hits / subset.length }
  }
  return { accuracy: correct / n, margin: margin / n, brier: brier / n, ece, coverage }
}

export * as SemifCalibration from "./calibration"
