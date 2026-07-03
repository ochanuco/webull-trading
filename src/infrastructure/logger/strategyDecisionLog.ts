import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { StrategyDecision } from '../../trading/domain/StrategyDecision'
import { strategyDecisionLog } from '../db/schema'
import { createDb } from '../db/tradeJournalRepo'

export interface StrategyDecisionRecord {
  timestamp: string
  requestId?: string
  symbol: string
  decision: StrategyDecision
  reason?: string | null
  price?: number | null
  indicatorsJson?: string | null
  /** BUY/SELL 成立時のみ設定。dashboard が trade_journal と JOIN する key (#143)。 */
  clientOrderId?: string | null
  /** 判定トレース JSON (`DecisionTraceStep[]`)。ラダー可視化用 (#decision-trace)。 */
  traceJson?: string | null
}

/**
 * INSERT one per-symbol decision row. Failure is logged (console.error) and
 * swallowed — logging must NEVER cause the strategy loop to crash or skip
 * symbols (logging failure isolation, as already practiced by pullbackScheduler
 * for tradeJournal entries).
 *
 * Callers that don't have DB bound (e.g. unit tests that pass a fake
 * positionStore) pass `db` as undefined; this function no-ops then.
 */
export async function logStrategyDecision(
  db: DrizzleD1Database | undefined,
  record: StrategyDecisionRecord,
): Promise<void> {
  if (!db) return
  try {
    await db.insert(strategyDecisionLog).values({
      timestamp: record.timestamp,
      requestId: record.requestId ?? null,
      symbol: record.symbol,
      decision: record.decision,
      reason: record.reason ?? null,
      price: record.price ?? null,
      indicatorsJson: record.indicatorsJson ?? null,
      clientOrderId: record.clientOrderId ?? null,
      traceJson: record.traceJson ?? null,
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'strategy_decision_log_insert_failed',
        requestId: record.requestId ?? null,
        symbol: record.symbol,
        decision: record.decision,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

/**
 * Factory for a lazy D1 handle used by strategy scheduler. Returns `undefined`
 * when `env.DB` is unbound so callers can pass a short-circuit value without
 * branching.
 */
export function strategyDecisionDbOrUndefined(env: { DB?: D1Database }): DrizzleD1Database | undefined {
  return env.DB ? createDb(env.DB) : undefined
}
