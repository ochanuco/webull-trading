import type { ReplayMetrics } from './replay'

export type BacktestPurpose = 'in_sample' | 'out_of_sample'

export interface GateRun {
  id: number
  purpose: BacktestPurpose
  symbols: string[]
  fromDate: string
  toDate: string
  createdAt: string
  metrics: ReplayMetrics
}

interface PromotionCriteria {
  minTrades: number
  minProfitFactor: number
  minTotalReturn: number
  /** Floor on max drawdown (negative fraction, e.g. -0.25). */
  minMaxDrawdownPct: number
  /** OOS Sharpe must keep at least this fraction of in-sample Sharpe. */
  minOosToIsSharpeRatio: number
  maxEvidenceAgeDays: number
}

/**
 * Fixed in code rather than accepted per request: a promotion endpoint that
 * lets the caller loosen its own gate is a bypass with extra steps.
 */
const DEFAULT_PROMOTION_CRITERIA: PromotionCriteria = Object.freeze({
  minTrades: 20,
  minProfitFactor: 1.2,
  minTotalReturn: 0,
  minMaxDrawdownPct: -0.25,
  minOosToIsSharpeRatio: 0.5,
  maxEvidenceAgeDays: 30,
})

interface GateCheck {
  name: string
  /** null = not applicable (e.g. no in-sample run to compare against). */
  passed: boolean | null
  message: string
}

export interface PromotionGateResult {
  passed: boolean
  evidenceRunIds: number[]
  checks: GateCheck[]
}

export interface PromotionGateInput {
  candidateRuns: GateRun[]
  /** The active model's OOS runs, compared only when one has an identical symbols/window. */
  activeRuns: GateRun[]
  now: Date
  criteria?: PromotionCriteria
}

export function evaluatePromotionGate(input: PromotionGateInput): PromotionGateResult {
  const criteria = input.criteria ?? DEFAULT_PROMOTION_CRITERIA
  const oos = latest(input.candidateRuns.filter((r) => r.purpose === 'out_of_sample'))
  if (!oos) {
    return {
      passed: false,
      evidenceRunIds: [],
      checks: [{ name: 'oos_run_exists', passed: false, message: 'no out_of_sample backtest run recorded' }],
    }
  }
  const is = latest(input.candidateRuns.filter((r) => r.purpose === 'in_sample'))
  const m = oos.metrics
  const checks: GateCheck[] = []

  const ageDays = (input.now.getTime() - Date.parse(oos.createdAt)) / 86_400_000
  checks.push({
    name: 'evidence_fresh',
    passed: Number.isFinite(ageDays) && ageDays <= criteria.maxEvidenceAgeDays,
    message: `OOS run #${oos.id} is ${Number.isFinite(ageDays) ? ageDays.toFixed(1) : '?'}d old (max ${criteria.maxEvidenceAgeDays}d)`,
  })
  checks.push({
    name: 'min_trades',
    passed: m.totalTrades >= criteria.minTrades,
    message: `trades ${m.totalTrades} >= ${criteria.minTrades}`,
  })
  checks.push({
    name: 'profit_factor',
    passed: m.profitFactor !== null && m.profitFactor >= criteria.minProfitFactor,
    message: `profit factor ${m.profitFactor === null ? 'n/a (no losing trades)' : m.profitFactor.toFixed(2)} >= ${criteria.minProfitFactor}`,
  })
  checks.push({
    name: 'total_return',
    passed: m.totalReturn > criteria.minTotalReturn,
    message: `total return ${m.totalReturn.toFixed(4)} > ${criteria.minTotalReturn}`,
  })
  checks.push({
    name: 'max_drawdown',
    passed: m.maxDrawdownPct >= criteria.minMaxDrawdownPct,
    message: `max drawdown ${m.maxDrawdownPct.toFixed(4)} >= ${criteria.minMaxDrawdownPct}`,
  })

  if (is) {
    checks.push({
      name: 'oos_after_in_sample',
      passed: oos.fromDate > is.toDate,
      message: `OOS window starts ${oos.fromDate}, in-sample window ends ${is.toDate}`,
    })
    const isSharpe = is.metrics.sharpeRatio
    checks.push(
      isSharpe > 0
        ? {
            name: 'oos_sharpe_retention',
            passed: m.sharpeRatio >= isSharpe * criteria.minOosToIsSharpeRatio,
            message: `OOS sharpe ${m.sharpeRatio.toFixed(2)} >= ${criteria.minOosToIsSharpeRatio} x in-sample ${isSharpe.toFixed(2)}`,
          }
        : { name: 'oos_sharpe_retention', passed: null, message: 'in-sample sharpe <= 0, retention not meaningful' },
    )
  } else {
    checks.push({ name: 'oos_after_in_sample', passed: null, message: 'no in_sample run recorded' })
    checks.push({ name: 'oos_sharpe_retention', passed: null, message: 'no in_sample run recorded' })
  }

  const comparable = latest(input.activeRuns.filter((r) => r.purpose === 'out_of_sample' && sameWindow(r, oos)))
  checks.push(
    comparable
      ? {
          name: 'beats_active_model',
          passed: m.sharpeRatio >= comparable.metrics.sharpeRatio,
          message: `sharpe ${m.sharpeRatio.toFixed(2)} >= active model's ${comparable.metrics.sharpeRatio.toFixed(2)} (run #${comparable.id})`,
        }
      : { name: 'beats_active_model', passed: null, message: 'active model has no OOS run on the same window' },
  )

  const evidenceRunIds = [oos.id, ...(is ? [is.id] : []), ...(comparable ? [comparable.id] : [])]
  return { passed: checks.every((c) => c.passed !== false), evidenceRunIds, checks }
}

function latest(runs: GateRun[]): GateRun | undefined {
  return runs.reduce<GateRun | undefined>((best, r) => (best === undefined || r.id > best.id ? r : best), undefined)
}

function sameWindow(a: GateRun, b: GateRun): boolean {
  return (
    a.fromDate === b.fromDate &&
    a.toDate === b.toDate &&
    [...a.symbols].sort().join(',') === [...b.symbols].sort().join(',')
  )
}
