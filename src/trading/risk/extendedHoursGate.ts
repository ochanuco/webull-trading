/**
 * Extended-hours (pre-market) gate (issue #709 Phase 6)。
 *
 * `extended_hours_observation` (Phase 1 producer, `extendedHoursScheduler.ts`)
 * が書いた当日プレマーケット観測 (status: NORMAL / WARNING /
 * STOP_AT_OPEN_CANDIDATE / UNKNOWN) を BUY sizing に反映する **size scaling 系**
 * filter。`newsShockGate.ts` と同じ型・reason 形式・防御的正規化の構造を踏襲する。
 *
 * scope:
 *   - in: BUY の `intent.quantity` を per-symbol に倍率調整 (1.0 / 0.5 / 0.0)
 *   - out: SELL は常に通す (issue #709: Yahoo 時間外データ単独では SELL しない —
 *     プレマーケットの薄い出来高・広いスプレッドは exit 判断の根拠として弱い)
 *   - out: 観測データの取得 (fetch) はこの module の責務外。producer
 *     (`extendedHoursScheduler`、別 cron) が書いた行を D1 read するだけ。
 *     **fetch は一切呼ばない** (`newsShockDecision.ts` と同じ安全上の絶対条件)
 *
 * pure な判定 (`extendedHoursStatusToDecision` / `isWithinExtendedHoursGateWindow`)
 * と D1 read (`loadExtendedHoursGateDecisions`) を分離し、前者はユニットテスト
 * 可能にする — `newsShockGate.ts` (pure) / `newsShockDecision.ts` (D1 read) の
 * 2 分割とは異なり 1 ファイルにまとめている。理由: この gate は
 * `attention_observation` (複数 probe・baseline・tone) のような複合入力を持たず、
 * 単一テーブルの当日最新行を読むだけなので、2 ファイルに割る複雑さに見合わない。
 */
import { isTradingDay } from '../domain/tradingCalendar'
import { formatNyYmd } from '../../infrastructure/calendar/usMarketCalendar'
import {
  createExtendedHoursObservationDb,
  createExtendedHoursObservationRepo,
} from '../../infrastructure/db/extendedHoursObservationRepo'

/**
 * 観測窓が US 開場から何分後まで有効か。プレマーケット観測は「寄り付き直後」の
 * 参考情報であり、午後まで朝の警戒を引きずらない (#709 Phase 6 設計)。
 */
export const GATE_VALID_MINUTES_AFTER_OPEN = 120

/** US NYSE レギュラー開場 = 09:30 ET (分換算)。`tradingCalendar.ts` の MARKET_SESSION.US と同値。 */
const US_OPEN_ET_MINUTES = 9 * 60 + 30

type ExtendedHoursGateAction = 'reduce_entry' | 'block_entry'

export interface ExtendedHoursGateDecision {
  action: ExtendedHoursGateAction
  /** BUY qty への倍率。reduce_entry=0.5 / block_entry=0。 */
  multiplier: number
  /** 通知 / log / decision reason 用の説明 (英文 canonical)。 */
  reason: string
}

/**
 * `extended_hours_observation` (issue #709 Phase 1) が当該 D1 で migrate 済みか
 * を判定する。`isNewsShockGateReady` と同じ理由 — 未 migrate な preview / 新環境
 * では gate を無効化して fail-closed の連鎖 reject / D1 read エラーを回避する。
 */
export async function isExtendedHoursGateReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='extended_hours_observation' LIMIT 1",
      )
      .first<{ ok: number }>()
    return row?.ok === 1
  } catch {
    return false
  }
}

/**
 * pure — 観測 status から gate decision を導く。
 *
 * - NORMAL: 通常のプローブ、影響なし → null (呼び出し側は Map に入れない)
 * - WARNING: premarket gap / stop 接近 → BUY size を 0.5x に縮小
 * - STOP_AT_OPEN_CANDIDATE: premarket 値が effective stop を割っている →
 *   BUY を全停止 (寄りで即損切りになりかねない新規建てを避ける)
 * - UNKNOWN / 上記以外: 観測不能 → null (fail-open、`assessPreMarket` 側の
 *   stale/欠測判定に委ねる — この gate 側で追加の fail-closed は取らない)
 */
export function extendedHoursStatusToDecision(status: string): ExtendedHoursGateDecision | null {
  if (status === 'WARNING') {
    return {
      action: 'reduce_entry',
      multiplier: 0.5,
      reason: 'extended_hours: WARNING (premarket gap/stop proximity)',
    }
  }
  if (status === 'STOP_AT_OPEN_CANDIDATE') {
    return {
      action: 'block_entry',
      multiplier: 0,
      reason: 'extended_hours: STOP_AT_OPEN_CANDIDATE (premarket below effective stop)',
    }
  }
  return null
}

/**
 * pure — `now` が「US 開場 〜 開場 + {@link GATE_VALID_MINUTES_AFTER_OPEN} 分」
 * の窓内か。プレマーケット観測は寄り付き直後だけ意味を持つ参考情報なので、
 * 窓外 (前場後半〜引け、時間外、休場日) では常に false を返す。
 *
 * 土日 / 祝日は `isTradingDay` (US はルール計算、#547) で除外。ET wall-clock は
 * `Intl.DateTimeFormat` で取得し DST 自動対応 (`tradingCalendar.evaluateStrategyWindow`
 * と同手法)。判定窓が ET 午前 (深夜跨ぎ無し) のため、`isTradingDay` の UTC 日付
 * 基準判定と ET 暦日がずれる懸念はない (`isWithinUsCloseWindow` の doc comment
 * と同じ理由)。
 */
export function isWithinExtendedHoursGateWindow(now: Date): boolean {
  if (!isTradingDay(now, 'US')) return false
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false
  const etMinutes = (hour % 24) * 60 + minute // hour12:false で稀に '24' を返す Intl quirk 対策
  return (
    etMinutes >= US_OPEN_ET_MINUTES && etMinutes < US_OPEN_ET_MINUTES + GATE_VALID_MINUTES_AFTER_OPEN
  )
}

/**
 * `extended_hours_observation` から当日 (NY session、`formatNyYmd`) の銘柄ごと
 * 最新観測を D1 read し、symbol (大文字) → decision の Map を返す。
 *
 * **D1 read のみ、fetch は一切しない** (module doc 参照)。
 *
 * - 有効時間窓外 (`isWithinExtendedHoursGateWindow` が false) は D1 read すら
 *   行わず空 Map を返す — 15分間隔の strategy tick に無駄な read を足さない。
 * - status が NORMAL / UNKNOWN、または観測なしの symbol は Map に含めない
 *   (= fail-open、呼び出し側の scheduler は「Map に無い symbol」を素通りさせる)。
 */
export async function loadExtendedHoursGateDecisions(
  db: D1Database,
  now: Date,
): Promise<Map<string, ExtendedHoursGateDecision>> {
  const decisions = new Map<string, ExtendedHoursGateDecision>()
  if (!isWithinExtendedHoursGateWindow(now)) return decisions
  const repo = createExtendedHoursObservationRepo(createExtendedHoursObservationDb(db))
  const rows = await repo.latestPerSymbol(formatNyYmd(now))
  for (const row of rows) {
    const decision = extendedHoursStatusToDecision(row.status)
    if (decision) decisions.set(row.symbol.toUpperCase(), decision)
  }
  return decisions
}
