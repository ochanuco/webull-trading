/**
 * Earnings calendar gate (issue #196 1/3)。
 *
 * 決算発表 ±N 営業日のエントリ (BUY) を凍結する **avoid 用 risk gate**。
 * - シグナル源ではない (BUY を出す根拠にしない、BUY を *止める* だけ)
 * - 計算コストはゼロに近い (D1 read 1 本)
 * - DB read 失敗 → fail-closed (entry block) で safe 側に倒す
 * - `freezeBusinessDays` 単位は **営業日** (土日 + 取引所休日 skip)。
 *   `tradingCalendar.isTradingDay` を使うので JP / US 両対応。
 *
 * scope:
 *   - in: BUY を ±N 営業日内に earnings がある銘柄について止める
 *   - out: SELL は止めない (既存 position 保護のため決算前売却は許容)
 *   - out: FOMC / CPI macro gate, VIX regime filter は別 PR で
 *
 * 呼び出し側 (`pullbackScheduler` 経由) は gate decision の `reason` を
 * `risk: earnings_within_1bd: 2026-04-30` 形式で `strategy_decision_log.reason`
 * に書く。dashboard `localizeReason` で日本語化。
 */
import {
  inferTradingMarket,
  isTradingDay,
  type TradingMarket,
} from '../domain/tradingCalendar'
import type { EarningsCalendarRepo } from '../../infrastructure/calendar/earningsCalendarRepo'

export interface EarningsGateInput {
  symbol: string
  /**
   * 評価日 ISO date "YYYY-MM-DD"。cron tick が走った日付を渡す。time-of-day
   * は持たない (1 日粒度の gate)。
   */
  evalDate: string
  /**
   * 評価対象の side。BUY のみ gate を効かせる。SELL は既存 position の
   * 撤退 / cleanup を妨げないように常に approve。
   */
  side: 'BUY' | 'SELL'
}

export interface EarningsGateConfig {
  /**
   * ±N 営業日凍結。default 1 (issue #196 — 「earnings 翌日」までを含む)。
   * 0 を渡せば当日のみ凍結。
   */
  freezeBusinessDays: number
}

export interface EarningsGateDecision {
  approved: boolean
  /**
   * Approved=false のときの reject 理由。形式:
   *   `earnings_within_${freezeBusinessDays}bd: ${earningsDate}`
   * 複数該当する場合は最も近い earnings 日 1 件のみ載せる (operator UI 表示用)。
   */
  reason?: string
}

const DEFAULT_CONFIG: EarningsGateConfig = { freezeBusinessDays: 1 }

/**
 * Pure-ish gate evaluator (`repo.fetchByRange` のみ side-effect)。
 *
 * 振る舞い:
 *  1. SELL → 常に approve (gate scope 外)
 *  2. evalDate parse 失敗 → fail-closed reject
 *  3. evalDate を中心に ±freezeBusinessDays 営業日窓を計算 (Date 範囲 string)
 *  4. repo.fetchByRange で該当 earnings_calendar 行を取得
 *  5. fetch throw → fail-closed reject (D1 read failure を silent pass させない)
 *  6. 行があれば最初 (= 範囲開始日に最も近い) を理由に載せて reject
 *  7. 行がなければ approve
 */
export async function evaluateEarningsGate(
  input: EarningsGateInput,
  repo: EarningsCalendarRepo,
  config: EarningsGateConfig = DEFAULT_CONFIG,
): Promise<EarningsGateDecision> {
  if (input.side === 'SELL') return { approved: true }

  const evalDay = parseYmdUtc(input.evalDate)
  if (evalDay === null) {
    return {
      approved: false,
      reason: `earnings_gate_invalid_eval_date: ${input.evalDate}`,
    }
  }

  const freeze = sanitizeFreezeDays(config.freezeBusinessDays)
  const market = inferTradingMarket(input.symbol)
  const fromDay = shiftBusinessDays(evalDay, -freeze, market)
  const toDay = shiftBusinessDays(evalDay, freeze, market)
  const fromYmd = toYmd(fromDay)
  const toYmd_ = toYmd(toDay)

  let rows: Awaited<ReturnType<EarningsCalendarRepo['fetchByRange']>>
  try {
    rows = await repo.fetchByRange(input.symbol, fromYmd, toYmd_)
  } catch (err) {
    // D1 read failure は fail-closed。entry を止めて他 cron tick / 復旧後に
    // 再判定。reason は dashboard で operator が原因に気付ける程度に残す。
    const msg = err instanceof Error ? err.message : String(err)
    return {
      approved: false,
      reason: `earnings_gate_fetch_failed: ${msg}`,
    }
  }

  if (rows.length === 0) return { approved: true }

  // earnings_calendar.earnings_date は ISO YYYY-MM-DD なので文字列比較で OK。
  // repo は asc で返す前提だが、念のため最小日付を選ぶ。
  let nearest = rows[0]!.earningsDate
  for (const r of rows) {
    if (r.earningsDate < nearest) nearest = r.earningsDate
  }

  return {
    approved: false,
    reason: `earnings_within_${freeze}bd: ${nearest}`,
  }
}

/**
 * 0 / 負値 / 非有限 / 巨大値の `freezeBusinessDays` を default に倒す。
 * 上限 30 営業日 (= 約 6 週間) は POC 運用上の sane bound。
 */
function sanitizeFreezeDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONFIG.freezeBusinessDays
  if (value < 0) return DEFAULT_CONFIG.freezeBusinessDays
  if (value > 30) return 30
  return Math.floor(value)
}

const MS_PER_DAY = 86_400_000
const MAX_SHIFT_ITER = 90

/**
 * `from` を起点に営業日 `count` 日分前後にシフト。`count > 0` で未来、`< 0` で
 * 過去。`from` 自身は count に含めない (= count=0 はそのまま、count=1 は翌営業日)。
 * 連続休日で無限ループを避けるため上限 90 日でガード。
 */
function shiftBusinessDays(from: Date, count: number, market: TradingMarket): Date {
  if (count === 0) return from
  const direction = count > 0 ? 1 : -1
  const remaining = Math.abs(count)
  let cursor = new Date(from.getTime())
  let shifted = 0
  for (let i = 0; i < MAX_SHIFT_ITER && shifted < remaining; i += 1) {
    cursor = new Date(cursor.getTime() + direction * MS_PER_DAY)
    if (isTradingDay(cursor, market)) shifted += 1
  }
  return cursor
}

/** "YYYY-MM-DD" → Date (UTC midnight)。形式不一致は null。 */
function parseYmdUtc(ymd: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null
  const ms = Date.parse(`${ymd}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return null
  return new Date(ms)
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10)
}
