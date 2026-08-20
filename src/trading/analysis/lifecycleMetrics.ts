/**
 * 売買ライフサイクル計測 (issue #709 Phase 2) — pure functions のみ。
 *
 * D1 / fetch に一切依存しない: `lifecycleReport.ts` が D1 / YahooBarClient から
 * 集めた素材をここに渡し、集計結果を組み立てる。同じ入力には常に同じ出力を
 * 返す (決定的) — dashboard の再表示や JSON export で毎回同じ数字が出ることを
 * 保証するため。
 *
 * 取引経路 (strategy/risk/execution) には一切参照されない読み取り専用の分析。
 */
import type { DailyBar } from '../strategy/indicators'
import { formatNyYmd } from '../../infrastructure/calendar/usMarketCalendar'

export interface LifecycleFill {
  symbol: string
  side: 'BUY' | 'SELL'
  qty: number
  price: number
  /** ISO UTC timestamp (trade_journal.timestamp)。 */
  at: string
  clientOrderId: string | null
  realizedPnl: number | null
  estimatedCost: number | null
}

export interface RoundTrip {
  symbol: string
  entryAt: string
  exitAt: string
  entryPrice: number
  exitPrice: number
  /** 決済 (SELL) fill の qty。POC は分割売り非対応なので entry qty と同じ想定。 */
  qty: number
  realizedPnl: number | null
  exitClientOrderId: string | null
}

export type ExitReasonCategory =
  | 'TP'
  | 'SL'
  | 'TIME_STOP'
  | 'REGIME_FLIP'
  | 'INTRADAY_CLOSE'
  | 'REBALANCE'
  | 'OTHER'
  | 'UNKNOWN'

/** dashboard 表示 / 集計の走査順を固定するための決定的な並び。 */
export const EXIT_REASON_CATEGORY_ORDER: readonly ExitReasonCategory[] = [
  'TP',
  'SL',
  'TIME_STOP',
  'REGIME_FLIP',
  'INTRADAY_CLOSE',
  'REBALANCE',
  'OTHER',
  'UNKNOWN',
]

export interface ClassifiedRoundTrip extends RoundTrip {
  exitReasonCategory: ExitReasonCategory
}

/**
 * fill 行の BUY/SELL を決定する。`routes/dashboard/charts/loaders.ts` の
 * `resolveFillSide` と同一ロジック。
 *
 * Why not import from loaders.ts: routes 層 (dashboard) から trading 層への
 * import は許容されるが、逆方向 (trading → routes) はレイヤー逆流になるため
 * 禁止 (#709 ブリーフ)。3 行の純関数を複製する方が、依存方向を守るコストより
 * 小さい。
 */
export function resolveFillSide(
  preSide: string | null,
  realizedPnl: number | null,
): 'BUY' | 'SELL' {
  if (preSide === 'BUY' || preSide === 'SELL') return preSide
  if (realizedPnl !== null && Number.isFinite(realizedPnl)) return 'SELL'
  return 'BUY'
}

/**
 * fills (時系列昇順、複数銘柄混在可) から closed round-trip を組む。
 * `routes/dashboard/charts/loaders.ts` の `pairClosedTrades` と同じ仮定:
 * - フラット状態で最初に現れた BUY が区間開始 (連続 BUY は開始点を動かさない)
 * - 次の SELL で全量決済とみなして閉じる (部分売り非対応)
 * - BUY 先行の無い SELL (手動売却の残骸) は区間にしない
 * - 末尾の未決済 BUY は返さない
 *
 * 複数銘柄が混在する入力を想定し、銘柄ごとに独立した状態機械で処理してから
 * exitAt 昇順にまとめて返す (Map の挿入順ではなく時系列順で決定的にするため)。
 */
export function pairRoundTrips(fills: readonly LifecycleFill[]): RoundTrip[] {
  const bySymbol = new Map<string, LifecycleFill[]>()
  for (const f of fills) {
    const list = bySymbol.get(f.symbol)
    if (list) list.push(f)
    else bySymbol.set(f.symbol, [f])
  }
  const trips: RoundTrip[] = []
  for (const [symbol, symbolFills] of bySymbol) {
    // 呼び出し側の SELECT 順 (id ASC) に依存しない — id 順と timestamp 順が
    // 食い違う行があると BUY/SELL の対応がねじれ、全指標が静かに壊れるため
    // ここで必ず at 昇順に揃える。
    symbolFills.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    let open: LifecycleFill | null = null
    for (const f of symbolFills) {
      if (f.side === 'BUY') {
        if (open === null) open = f
      } else if (open !== null) {
        trips.push({
          symbol,
          entryAt: open.at,
          exitAt: f.at,
          entryPrice: open.price,
          exitPrice: f.price,
          qty: f.qty,
          realizedPnl: f.realizedPnl,
          exitClientOrderId: f.clientOrderId,
        })
        open = null
      }
    }
  }
  trips.sort((a, b) => (a.exitAt < b.exitAt ? -1 : a.exitAt > b.exitAt ? 1 : 0))
  return trips
}

/**
 * SELL exit の生 reason 文字列 → カテゴリ。実際の文言は
 * `PullbackUptrendStrategy.ts:181,201,212` (take-profit / stop-loss / time-stop)
 * と `pullbackScheduler.ts:665,690,747` (cash allocation rebalance /
 * intraday-only / pair regime flip) で確認済み (#709 ブリーフ)。
 *
 * `reason` が null (= SELL fill の client_order_id が strategy_decision_log に
 * 見つからない、手動売却や migration 前データ) は UNKNOWN。既知パターンに
 * マッチしない reason (将来追加された exit ルート) は OTHER に落として合計が
 * 欠けないようにする。
 */
export function classifyLiveExitReason(reason: string | null | undefined): ExitReasonCategory {
  if (!reason) return 'UNKNOWN'
  if (/^take-profit/.test(reason)) return 'TP'
  if (/^stop-loss/.test(reason)) return 'SL'
  if (/^time-stop/.test(reason)) return 'TIME_STOP'
  if (reason.includes('pair regime flip')) return 'REGIME_FLIP'
  if (reason.includes('intraday-only')) return 'INTRADAY_CLOSE'
  if (reason.includes('cash allocation rebalance')) return 'REBALANCE'
  return 'OTHER'
}

/**
 * round trip に exit reason カテゴリを付与する。`reasonByClientOrderId` は
 * strategy_decision_log の SELL 行 (`clientOrderId → reason`) から loader が
 * 事前に組んだ lookup。
 */
export function classifyRoundTrips(
  trips: readonly RoundTrip[],
  reasonByClientOrderId: ReadonlyMap<string, string | null>,
): ClassifiedRoundTrip[] {
  return trips.map((t) => ({
    ...t,
    exitReasonCategory: classifyLiveExitReason(
      t.exitClientOrderId ? (reasonByClientOrderId.get(t.exitClientOrderId) ?? null) : null,
    ),
  }))
}

export interface ExitReasonStat {
  category: ExitReasonCategory
  count: number
  wins: number
  losses: number
  /** 0..1 */
  winRate: number
  avgWin: number
  avgLoss: number
  /** 1 trade あたり期待損益 (break-even 込みの全トレード平均)。 */
  expectancy: number
}

/**
 * reason カテゴリ別の勝率 / 平均利益 / 平均損失 / 期待値。realizedPnl が null
 * (旧データ欠損) の trip は集計から除外する。
 *
 * Why not import `computeTradeStats` from `routes/dashboard/charts/quality.ts`:
 * 同じ勝率/期待値の式だが、routes 層から trading 層への import は逆流になる
 * ため計算式を複製する (#709 ブリーフ)。
 */
export function computeExitReasonStats(trips: readonly ClassifiedRoundTrip[]): ExitReasonStat[] {
  const byCategory = new Map<ExitReasonCategory, number[]>()
  for (const t of trips) {
    if (t.realizedPnl === null || !Number.isFinite(t.realizedPnl)) continue
    const list = byCategory.get(t.exitReasonCategory)
    if (list) list.push(t.realizedPnl)
    else byCategory.set(t.exitReasonCategory, [t.realizedPnl])
  }
  const out: ExitReasonStat[] = []
  for (const category of EXIT_REASON_CATEGORY_ORDER) {
    const pnls = byCategory.get(category)
    if (!pnls || pnls.length === 0) continue
    let wins = 0
    let losses = 0
    let sumWin = 0
    let sumLoss = 0
    let total = 0
    for (const p of pnls) {
      total += p
      if (p > 0) {
        wins += 1
        sumWin += p
      } else if (p < 0) {
        losses += 1
        sumLoss += p
      }
    }
    const decisive = wins + losses
    out.push({
      category,
      count: pnls.length,
      wins,
      losses,
      winRate: decisive > 0 ? wins / decisive : 0,
      avgWin: wins > 0 ? sumWin / wins : 0,
      avgLoss: losses > 0 ? sumLoss / losses : 0,
      expectancy: total / pnls.length,
    })
  }
  return out
}

/** "2026-06-05T14:05:00.000Z" → "2026-06-05"。不正な ISO は空文字。 */
function utcDateOnly(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  return iso.slice(0, 10)
}

/**
 * `dateIso` 時点以降で最初に現れる bar の index。「exit/entry の UTC 日付 <=
 * bar 日付」となる最初の bar を採用する (#709 ブリーフの営業日オフセット定義)。
 * 該当 bar が無い (= その日以降の bar がまだ取得できていない) 場合は null。
 */
function findBarIndexOnOrAfter(bars: readonly DailyBar[], dateIso: string): number | null {
  const date = utcDateOnly(dateIso)
  if (!date) return null
  const idx = bars.findIndex((b) => date <= b.date)
  return idx === -1 ? null : idx
}

export interface ForwardReturns {
  r1: number | null
  r3: number | null
  r5: number | null
  r10: number | null
  /** exit 後 10 営業日の最大上昇幅 (close 基準、high で見た上振れ)。 */
  postExitMfe10: number | null
}

/**
 * exit 後 1/3/5/10 営業日リターン + post-exit MFE (10 営業日以内の最大上昇幅)。
 * 基準値は exit 日に対応する bar の close (= `findBarIndexOnOrAfter` が返す
 * index の bar)。r1/r3/r5/r10 はその offset の bar が無ければ null (bar 不足)。
 * postExitMfe10 は exit bar 自体が見つからないときのみ null — 見つかった場合は
 * 取得できている bar の範囲 (最大 10 本) で best-effort に計算する (r1..r10 の
 * ような「ちょうどその日」の値ではなく「その時点までの最大」なので、bar が
 * 10 本そろっていなくても部分集計に意味があるため)。
 */
export function computeForwardReturns(
  trip: { exitAt: string },
  bars: readonly DailyBar[],
): ForwardReturns {
  const idx = findBarIndexOnOrAfter(bars, trip.exitAt)
  if (idx === null) return { r1: null, r3: null, r5: null, r10: null, postExitMfe10: null }
  const base = bars[idx]!.close
  const ret = (n: number): number | null => {
    const bar = bars[idx + n]
    return bar && base !== 0 && Number.isFinite(base) ? (bar.close - base) / base : null
  }
  let mfe: number | null = null
  for (let n = 1; n <= 10; n += 1) {
    const bar = bars[idx + n]
    if (!bar) break
    if (base === 0 || !Number.isFinite(base)) break
    const upside = (bar.high - base) / base
    if (mfe === null || upside > mfe) mfe = upside
  }
  return { r1: ret(1), r3: ret(3), r5: ret(5), r10: ret(10), postExitMfe10: mfe }
}

/**
 * entry 直前 5 営業日の上昇率: entry 日の bar (index) と、その 5 本前の bar の
 * close を比較する。entry bar が見つからない、または前に 5 本の bar が無い
 * (上場直後 / データ不足) 場合は null。
 */
export function computePreEntryRunup(
  trip: { entryAt: string },
  bars: readonly DailyBar[],
): number | null {
  const idx = findBarIndexOnOrAfter(bars, trip.entryAt)
  if (idx === null || idx < 5) return null
  const base = bars[idx - 5]!.close
  if (base === 0 || !Number.isFinite(base)) return null
  return (bars[idx]!.close - base) / base
}

export interface SkipSignal {
  symbol: string
  /** ISO UTC timestamp (strategy_decision_log.timestamp)。 */
  at: string
  reason: string | null
}

export type SkipReasonCategory = 'HALT' | 'SIZING' | 'RISK' | 'OTHER'

export const SKIP_REASON_CATEGORY_ORDER: readonly SkipReasonCategory[] = [
  'HALT',
  'SIZING',
  'RISK',
  'OTHER',
]

/**
 * SKIP reason の軽量分類。`routes/dashboard/charts/quality.ts` の
 * `categorizeSkipReason` (7 カテゴリ、UI 表示色分け込み) より粗い 4 分類 —
 * この画面が見たいのは「見送りの後どうなったか」であって SKIP の内訳自体では
 * ないため、判定観点 (停止系 / サイジング不可 / リスクゲート / その他) だけ
 * 揃えれば十分。
 *
 * Why not import from quality.ts: routes 層 → trading 層の import は逆流になる
 * ため、分類 prefix だけを軽量に複製する (#709 ブリーフ)。
 */
export function classifySkipReason(reason: string | null | undefined): SkipReasonCategory {
  if (!reason) return 'OTHER'
  if (/^(?:portfolio_halted|drawdown_kill):/.test(reason)) return 'HALT'
  if (/^sizing rejected:/.test(reason)) return 'SIZING'
  if (/^risk:/.test(reason) || /^pair_regime:/.test(reason)) return 'RISK'
  return 'OTHER'
}

/**
 * 15 分 cron で同日に連発する SKIP を (symbol, UTC 日付) ごとに最初の 1 件へ
 * dedup する。入力は timestamp 昇順を前提 (= 最初に見つかったものが「その日の
 * 最初の SKIP」になる)。
 */
export function dedupSkipSignalsByDay(signals: readonly SkipSignal[]): SkipSignal[] {
  const seen = new Set<string>()
  const out: SkipSignal[] = []
  for (const s of signals) {
    const day = utcDateOnly(s.at)
    const key = `${s.symbol}|${day}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

export interface SkipOutcome {
  /** 見送り後 10 営業日以内の最大上昇幅 (high 基準)。 */
  mfe10: number | null
  /** 見送り後 10 営業日以内の最大下落幅 (low 基準、負値)。 */
  mae10: number | null
}

/**
 * 見送った signal のその後 10 営業日 MFE/MAE。基準値は SKIP 日に対応する bar
 * の close。`computeForwardReturns` の postExitMfe10 と同じ best-effort 方針
 * (bar が 10 本そろっていなくても取得できた範囲で計算)、SKIP bar 自体が
 * 見つからない場合のみ両方 null。
 */
export function computeSkipOutcome(skip: SkipSignal, bars: readonly DailyBar[]): SkipOutcome {
  const idx = findBarIndexOnOrAfter(bars, skip.at)
  if (idx === null) return { mfe10: null, mae10: null }
  const base = bars[idx]!.close
  if (base === 0 || !Number.isFinite(base)) return { mfe10: null, mae10: null }
  let mfe: number | null = null
  let mae: number | null = null
  for (let n = 1; n <= 10; n += 1) {
    const bar = bars[idx + n]
    if (!bar) break
    const upside = (bar.high - base) / base
    const downside = (bar.low - base) / base
    if (mfe === null || upside > mfe) mfe = upside
    if (mae === null || downside < mae) mae = downside
  }
  return { mfe10: mfe, mae10: mae }
}

/** null / non-finite を除いた平均。0 件は `{ n: 0, avg: null }`。 */
export function avgNonNull(values: ReadonlyArray<number | null>): { n: number; avg: number | null } {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v))
  if (finite.length === 0) return { n: 0, avg: null }
  const sum = finite.reduce((a, b) => a + b, 0)
  return { n: finite.length, avg: sum / finite.length }
}

export interface DrawdownResult {
  /** peak からの最大下落幅 (正の USD 額)。トレードが無ければ 0。 */
  maxDrawdownUsd: number
  /** 最大 DD 発生時点の累積 peak (USD)。 */
  peakUsd: number
  /** 最大 DD 発生時点の累積値 (USD)。 */
  troughUsd: number
}

/**
 * round trip の realizedPnl を exit 時刻順に累積し、peak からの最大下落を
 * USD で返す。分母となる資本 (equity) を持たないので % は出さない
 * (#709 ブリーフ)。
 */
export function computeDrawdown(trips: readonly RoundTrip[]): DrawdownResult {
  const sorted = [...trips].sort((a, b) => (a.exitAt < b.exitAt ? -1 : a.exitAt > b.exitAt ? 1 : 0))
  let cum = 0
  let peak = 0
  let maxDd = 0
  let peakAtMaxDd = 0
  let troughAtMaxDd = 0
  for (const t of sorted) {
    if (t.realizedPnl === null || !Number.isFinite(t.realizedPnl)) continue
    cum += t.realizedPnl
    if (cum > peak) peak = cum
    const dd = peak - cum
    if (dd > maxDd) {
      maxDd = dd
      peakAtMaxDd = peak
      troughAtMaxDd = cum
    }
  }
  return { maxDrawdownUsd: maxDd, peakUsd: peakAtMaxDd, troughUsd: troughAtMaxDd }
}

export interface TurnoverResult {
  buyNotionalUsd: number
  sellNotionalUsd: number
  totalNotionalUsd: number
  /** totalNotional / avgEquity。avgEquity が null / 0 以下なら null。 */
  turnoverRatio: number | null
}

/**
 * 全 fill の notional (price × qty) を BUY/SELL 別・合計で集計し、平均 equity
 * が取れれば turnover ratio (合計 notional / 平均 equity) も出す。
 */
export function computeTurnover(
  fills: readonly LifecycleFill[],
  avgEquityUsd: number | null,
): TurnoverResult {
  let buyNotionalUsd = 0
  let sellNotionalUsd = 0
  for (const f of fills) {
    // price/qty どちらかが 0・負値・非有限だと notional が意味を失う (負×負で
    // 正になるケースも通ってしまう) ので、有限かつ > 0 の組だけ集計する。
    if (!Number.isFinite(f.price) || f.price <= 0 || !Number.isFinite(f.qty) || f.qty <= 0) continue
    const notional = f.price * f.qty
    if (!Number.isFinite(notional) || notional <= 0) continue
    if (f.side === 'BUY') buyNotionalUsd += notional
    else sellNotionalUsd += notional
  }
  const totalNotionalUsd = buyNotionalUsd + sellNotionalUsd
  const turnoverRatio =
    avgEquityUsd !== null && Number.isFinite(avgEquityUsd) && avgEquityUsd > 0
      ? totalNotionalUsd / avgEquityUsd
      : null
  return { buyNotionalUsd, sellNotionalUsd, totalNotionalUsd, turnoverRatio }
}

/** `estimated_cost` (SELL 行に往復分が入っている、#trade-cost) の単純合計。再計算はしない。 */
export function sumEstimatedCost(fills: readonly LifecycleFill[]): number {
  let sum = 0
  for (const f of fills) {
    if (f.estimatedCost !== null && Number.isFinite(f.estimatedCost)) sum += f.estimatedCost
  }
  return sum
}

/**
 * stop-loss exit と同日の時間外参考観測 (`extended_hours_observation.status`)
 * を突き合わせる。`statusBySymbolNyDay` は loader が事前に組んだ
 * `${symbol}|${NY YYYY-MM-DD}` → status の lookup (その日の最終観測を想定)。
 * 観測が無い日は 'NO_OBSERVATION' に集計する。
 *
 * NY 暦日への変換は `formatNyYmd` (pure, Date 計算のみ) を使う — 時間外観測
 * 自体が NY セッション基準の producer (#709 Phase 1) なので、SL exit の UTC
 * timestamp も NY 日に揃えないと突き合わせがずれる。
 */
export function crossTabSlExitsWithExtendedHours(
  slExits: ReadonlyArray<{ symbol: string; exitAt: string }>,
  statusBySymbolNyDay: ReadonlyMap<string, string>,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const exit of slExits) {
    const t = new Date(exit.exitAt)
    const nyYmd = Number.isFinite(t.getTime()) ? formatNyYmd(t) : ''
    const key = `${exit.symbol}|${nyYmd}`
    const status = nyYmd ? (statusBySymbolNyDay.get(key) ?? 'NO_OBSERVATION') : 'NO_OBSERVATION'
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}
