import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * append-only trade decision / order lifecycle log. A single row per logical
 * event (`decision` → `intent` → `pre_submit` → `post_submit` → `fill` /
 * `exit`). Column shape is intentionally flat — schema mirrors
 * {@link TradeJournalRecord} in src/infrastructure/logger/tradeJournal.ts
 * so we can straight-map records into rows without adapter logic.
 *
 * 振り返り用 SELECT 例は docs/db-operations.md 参照。
 */
export const tradeJournal = sqliteTable('trade_journal', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: text('timestamp').notNull(),
  tradeEventType: text('trade_event_type').notNull(),
  requestId: text('request_id'),
  clientOrderId: text('client_order_id'),
  orderId: text('order_id'),
  symbol: text('symbol'),
  strategyName: text('strategy_name'),
  signalAction: text('signal_action'),
  signalReason: text('signal_reason'),
  riskAllowed: integer('risk_allowed', { mode: 'boolean' }),
  riskReasons: text('risk_reasons'),
  side: text('side'),
  quantity: real('quantity'),
  limitPrice: real('limit_price'),
  notional: real('notional'),
  latencyMs: real('latency_ms'),
  brokerStatus: text('broker_status'),
  mode: text('mode'),
  submitted: integer('submitted', { mode: 'boolean' }),
  filledQty: real('filled_qty'),
  filledPrice: real('filled_price'),
  realizedPnl: real('realized_pnl'),
  holdDays: real('hold_days'),
  exitReason: text('exit_reason'),
  errorClass: text('error_class'),
  errorMessage: text('error_message'),
})

export type TradeJournalRow = typeof tradeJournal.$inferSelect
export type TradeJournalInsert = typeof tradeJournal.$inferInsert

/**
 * Per-symbol universe + trading policy. Replaces `ALLOWED_SYMBOLS` and
 * `SYMBOL_MAX_NOTIONAL` env vars so changes do not require redeploy. Operator
 * edits via `wrangler d1 execute "INSERT / UPDATE ..."`. See
 * docs/db-operations.md for recipes.
 *
 * `active = 0` で一時停止扱い (ALLOWED_SYMBOLS から外れる)。`max_notional`
 * が NULL なら global の MAX_ORDER_NOTIONAL 上限に丸める (fall-through)。
 */
export const symbolConfig = sqliteTable('symbol_config', {
  symbol: text('symbol').primaryKey(),
  /** 人間可読な銘柄名 (例: "Direxion Daily Semiconductor Bull 3X"、トヨタ自動車)。運用時の識別用。 */
  name: text('name'),
  market: text('market').notNull(), // 'US' | 'JP'
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  maxNotional: real('max_notional'),
  notes: text('notes'),
  updatedAt: text('updated_at').notNull(),
})

export type SymbolConfigRow = typeof symbolConfig.$inferSelect
export type SymbolConfigInsert = typeof symbolConfig.$inferInsert

/**
 * Structurally anti-correlated pairs (SOXL/SOXS, TQQQ/SQQQ 等)。相手 symbol
 * で position を抱えている間の BUY を拒否するために使う (#38-A inverse-pair
 * correlation cap の env 置換)。
 *
 * 1 方向だけ書き込めば十分 — repo 側で bidirectional に展開する。
 */
export const inversePairs = sqliteTable('inverse_pairs', {
  symbol: text('symbol').primaryKey(),
  inverse: text('inverse').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export type InversePairRow = typeof inversePairs.$inferSelect
export type InversePairInsert = typeof inversePairs.$inferInsert
