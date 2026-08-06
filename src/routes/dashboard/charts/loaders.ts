import type { Env } from '../../../config/env'
import { MAX_TIME_STOP_DAYS } from '../../../infrastructure/db/schema'
import { type EvalIndicatorPoint } from '../../../trading/strategy/entryDistance'
import type { PullbackIndicators } from '../../../trading/strategy/strategies/PullbackUptrendStrategy'
import { SymbolStateClient } from '../../../trading/state/SymbolStateClient'
import { YahooBarClient } from '../../../infrastructure/quotes/YahooBarClient'
import { type DecisionRow, cronDecisionJson, renderChartDecisionTrace } from '../cron'
import { currencyOfSymbol, exportMeta, messageOf, parseJsonObject } from '../shared'

/**
 * 銘柄チャートで focus する銘柄を決める (#158 Phase 4)。
 * クエリ ?symbol=X が universe にあればそれ、無ければ「直近で BUY/SELL
 * fill のあった銘柄」、それも無ければ universe の先頭。
 *
 * 「実際に売買したことがある銘柄」を優先する理由: トレーダーが
 * 「rule の解釈が現実と合ってるか」を最初に見たいのは、エントリーが
 * あった銘柄だから。
 */
export async function pickDefaultSymbol(db: D1Database): Promise<string | null> {
  const result = await db
    .prepare(
      `SELECT symbol FROM trade_journal
       WHERE trade_event_type = 'post_submit' AND filled_qty IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .all<{ symbol: string }>()
  return result.results?.[0]?.symbol ?? null
}

export interface SymbolChartPoint {
  timestamp: string // ISO UTC (time axis 用、client 側 Intl で JST 表示)
  price: number
  sma50: number | null
  high20d: number | null
  low20d: number | null
}

export interface SymbolChartMarker {
  timestamp: string
  side: 'BUY' | 'SELL'
  price: number
  qty: number | null
  realizedPnl: number | null
  /**
   * fill 元注文の client_order_id。fill マーカー → 取引ジャーナル
   * (/dashboard/trades?clientOrderId=...) への逆リンクに使う。
   * additive フィールドなので optional: 古い fixture では省略され、
   * client 側は null 同等 (リンク非表示) で扱う。
   */
  clientOrderId?: string | null
}

/**
 * BUY → SELL で閉じた 1 往復の保有区間 (#chart-markers)。チャート上に
 * 「この期間持っていて、結果 +X / -Y だった」を薄背景 (markArea) で見せる。
 * オープン中の保有 (BUY のみで未決済) は含めない — 右端まで塗ると
 * 「そこで決済した」ように誤読されるため、既存の position 線に任せる。
 */
export interface ClosedTradeSpan {
  /** 区間開始 = 保有を開いた BUY fill の timestamp (ISO UTC) */
  openTimestamp: string
  /** 区間終了 = 決済 SELL fill の timestamp (ISO UTC) */
  closeTimestamp: string
  /** 決済 SELL の realized PnL。旧 fill 等で欠損なら null (中立色で描画) */
  realizedPnl: number | null
}

/**
 * fills (時系列昇順) から closed round-trip を組む。`deriveOpenPosition` と
 * 同じ突合方針の閉区間版:
 * - フラット状態で最初に現れた BUY を区間開始にする。連続 BUY (position add /
 *   partial fill 分割) は開始点を動かさない — 「持ち始めた時点」から塗るのが
 *   保有区間の意味論として正しい
 * - SELL は全量決済とみなして区間を閉じる (POC 戦略は分割売りしない)。
 *   realizedPnl はその SELL の値を採用
 * - BUY 先行の無い SELL (手動売却の残骸 / データ欠損) は区間にしない
 * - 末尾が BUY で終わる未決済分は返さない (上記 doc comment の通り)
 */
export function pairClosedTrades(fills: SymbolChartMarker[]): ClosedTradeSpan[] {
  const spans: ClosedTradeSpan[] = []
  let openStart: string | null = null
  for (const m of fills) {
    if (m.side === 'BUY') {
      if (openStart === null) openStart = m.timestamp
    } else if (openStart !== null) {
      spans.push({
        openTimestamp: openStart,
        closeTimestamp: m.timestamp,
        realizedPnl: m.realizedPnl,
      })
      openStart = null
    }
  }
  return spans
}

/**
 * チャート上にプロットする「cron 判定イベント」1 件 (#decision-trace 連携)。
 * 文字ログ (戦略判定テーブル) とグラフを 1 画面で同期させるための要素。
 * eval 時刻 (`timestamp`) × eval 価格 (`price`) に色分けの点を打ち、点クリックで
 * `ladderHtml` (= 既存 `renderDecisionLadder` の出力) を脇のパネルに表示する。
 *
 * HOLD (保有継続 / 様子見の定常状態) は省き、判定が動いた BUY/SELL/SKIP/REJECT/
 * ERROR のみを載せる。価格線・fill ピン・position/preview 線が HOLD 状態は既に表現済み。
 */
export interface SymbolChartDecision {
  /** strategy_decision_log の行 id。点の一意キー兼デバッグ用。 */
  id: number
  timestamp: string // ISO UTC (eval 時刻)
  /** eval 時の評価価格 (= strategy_decision_log.price)。y 位置に使う。 */
  price: number
  decision: 'BUY' | 'SELL' | 'SKIP' | 'REJECT' | 'ERROR'
  /** 生 reason (英語)。tooltip では localize して表示。 */
  reason: string | null
  /**
   * server-side で事前レンダリングした判定トレース・ラダー HTML
   * (`renderDecisionLadder` 出力、trace 無し行は最小フォールバック)。
   * client は click でこの文字列を innerHTML へ挿すだけ (JS 側にラダー描画
   * ロジックを複製せず単一の真実源を保つ)。値はすべて `esc()` 済みの自前 markup。
   */
  ladderHtml: string
}

export interface SymbolChartPosition {
  /** 平均取得単価 (= 直近 BUY filled_price、partial fill / add は未対応 POC) */
  avgPrice: number
  /** entry timestamp (JST 表示用文字列) */
  openedAt: string
}

export interface SymbolChartRules {
  /** -0.03 = -3% (押し目浅すぎ閾値) */
  pullbackMax: number
  /** -0.15 = -15% (押し目深すぎ閾値) */
  pullbackMin: number
  /** -0.04 = -4% (損切ライン) */
  stopPct: number
  /** 0.07 = +7% (利食ライン) */
  takeProfitPct: number
  /** 営業日。chart の SQL window 計算に使う (chart logic では非使用) */
  timeStopDays: number
}

/**
 * Chart window の上限日数。schema の MAX_TIME_STOP_DAYS (365) から計算。
 * timeStopDays が大きくても肥大化を防ぐ。
 * MAX_TIME_STOP_DAYS=365 → 2*365+4 = 734 カレンダー日。
 */
export const MAX_WINDOW_DAYS = Math.ceil(MAX_TIME_STOP_DAYS * 2 + 4)

/**
 * Chart SQL の window 日数を timeStopDays から動的に決める。
 * 営業日 N → カレンダー N×7/5 + 祝日バッファ + 安全マージン ≈ 2N+4。
 * timeStopDays=10 → 24 日。年末年始 / 大型連休跨ぎでも entry 取りこぼさない。
 * floor=14, ceiling=MAX_WINDOW_DAYS で clamp してカレンダー window の肥大化を防ぐ。
 */
export function computeChartWindowDays(timeStopDays: number): number {
  const dynamic = Math.ceil(timeStopDays * 2 + 4)
  return Math.min(Math.max(dynamic, 14), MAX_WINDOW_DAYS)
}

/**
 * チャートに重ねる判定点の上限 (最新側から採用)。payload サイズ (各点が
 * 事前レンダリングのラダー HTML を持つ) と視認性のガード。HOLD を除いた
 * BUY/SELL/SKIP/REJECT/ERROR のみが対象なので通常はこの上限に届かない。
 */
export const MAX_CHART_DECISIONS = 250

/** チャート判定点として描画する decision 種別 (HOLD は定常状態なので除外)。 */
export const CHART_PLOTTED_DECISIONS: ReadonlySet<string> = new Set(['BUY', 'SELL', 'SKIP', 'REJECT', 'ERROR'])

export interface PivotPoint {
  /** ISO UTC timestamp of the daily bar */
  timestamp: string
  price: number
  type: 'high' | 'low'
}

/**
 * 直線セグメント。
 *
 * 旧仕様 (pivot ベース) では `pivots` は「採用した 2 swing pivot」だったが、
 * 現仕様 (linear regression) では `pivots[0]` = 線の左端、`pivots[1]` = 同じ
 * slope 上の参照点 (densify では未使用) を入れる。`end` は線の右端 (= chart
 * 最新 timestamp 上の外挿点)。`densifyTrendLine` は `pivots[0]` と `end` の
 * 2 点だけを使うため、両用途で同じ型が再利用できる。
 */
export interface TrendLineSegment {
  pivots: [PivotPoint, PivotPoint]
  end: { timestamp: string; price: number }
}

/** 15 分足 OHLC (Yahoo intraday bars 由来)、candlestick 描画用 */
export interface OhlcBar {
  /** ISO UTC (Yahoo intraday は秒精度の bar 開始時刻) */
  timestamp: string
  open: number
  high: number
  low: number
  close: number
}

export interface SymbolChartData {
  symbol: string
  points: SymbolChartPoint[]
  markers: SymbolChartMarker[]
  /** 現保有 (BUY → SELL がまだない) ならその情報、なければ null */
  position: SymbolChartPosition | null
  rules: SymbolChartRules
  /**
   * 直近 30 日 daily close の最小二乗 (linear regression) で fit した
   * 「価格の中心トレンド線」。データ点が 2 未満なら null。
   *
   * 旧仕様 (resistanceLine / supportLine の上下 2 本) は、ローソク足の上下を
   * flat に走る形で「価格の中心を辿る」という user の期待と乖離していた。
   * regression で価格中央を best-fit する形に変更。
   */
  trendLine: TrendLineSegment | null
  /** Yahoo 日次 OHLC、candlestick 描画用 (空配列 = Yahoo fetch 失敗) */
  intradayBars: OhlcBar[]
  /**
   * 最新の cron-eval point (= strategy_decision_log 由来) の price。
   * Yahoo daily filler を含めず、merge 前 cron-eval の末尾を採用する。
   *
   * preview stop/TP の virtualAvg はこの値を使う。`points` 末尾は
   * Yahoo filler だと「古い日次 close」になる可能性があり、preview に使うと
   * 「実 strategy 評価で参照していない過去価格」で線が引かれて誤解を招く。
   * cron eval 履歴が無い (= strategy_decision_log が空) 場合は null。
   */
  latestCronPrice: number | null
  /** `latestCronPrice` の timestamp (ISO Z)。preview line の to-end 用。null 時 preview 描画スキップ。 */
  latestCronTimestamp: string | null
  /**
   * チャートに重ねる cron 判定イベント (BUY/SELL/SKIP/REJECT/ERROR、HOLD 除外)。
   * 文字ログ↔グラフ同期用 (#decision-trace)。最新側 `MAX_CHART_DECISIONS` 件まで。
   * 追加 (additive) フィールドなので optional: 古い fixture / grid payload では
   * 省略され、レンダラ側は `|| []` で安全に扱う。
   */
  decisions?: SymbolChartDecision[]
  /**
   * 入場距離 (#entry-distance) 計算用の、直近 (日次ユニーク) 評価指標列。
   * 各 cron 評価の完全な `PullbackIndicators` を時系列昇順で保持。route 側で
   * full rule と合わせて `buildBuyabilityView` に渡す。additive で optional。
   */
  evalIndicators?: EvalIndicatorPoint[]
  /**
   * BUY → SELL で閉じた保有区間 (markArea 描画用、#chart-markers)。
   * additive で optional: 古い fixture / payload では省略され、client 側は
   * `|| []` で安全に扱う。
   */
  holdingSpans?: ClosedTradeSpan[]
}

/**
 * 直近 200 件の strategy_decision_log と全 fill markers + 現保有 + ルール閾値を返す。
 * - sma50 / high20d は indicators_json から抜く (JSON.parse 失敗は null fallback)
 * - timestamp は DB 上の UTC ISO をそのまま保持し、ECharts time axis に渡す。
 *   JST 表示は client 側 Intl.DateTimeFormat (Asia/Tokyo) でやる
 * - position は SymbolStateDO の値を最優先 (partial fill / position add 対応)、
 *   binding 無し or 失敗時は trade_journal からの derive にフォールバック
 */
export async function loadSymbolChart(
  env: Env,
  symbol: string,
  rules: SymbolChartRules,
): Promise<SymbolChartData> {
  const db = env.DB
  if (!db) throw new Error('DB binding not available')
  const windowDays = computeChartWindowDays(rules.timeStopDays)
  const [logsResult, fillsResult, doPosition] = await Promise.all([
    db
      // 動的 window: timeStopDays から computeChartWindowDays(N) で計算
      // (default 10 営業日 → 24 カレンダー日)。祝日 / 連休跨ぎでも entry を
      // 取りこぼさない。strftime で右辺を ISO UTC 形式 ("...T...:...Z") に
      // 揃える (default datetime() の空白区切りでは stored ISO と境界がぶれる)。
      .prepare(
        `SELECT id, timestamp, price, decision, reason, indicators_json, trace_json
         FROM strategy_decision_log
         WHERE symbol = ?
           AND timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
         ORDER BY id ASC`,
      )
      .bind(symbol, `-${windowDays} days`)
      .all<{
        id: number
        timestamp: string
        price: number | null
        decision: string | null
        reason: string | null
        indicators_json: string | null
        trace_json: string | null
      }>(),
    db
      // post_submit 行は side が null (writer は pre_submit にしか side を入れない)。
      // client_order_id で pre_submit と self-JOIN して side を引く。古い fill で
      // pre_submit が無い場合は realized_pnl の有無から推測 (null=BUY, 非 null=SELL)。
      .prepare(
        `SELECT
           ps.timestamp AS timestamp,
           pre.side AS pre_side,
           ps.filled_price AS filled_price,
           ps.filled_qty AS filled_qty,
           ps.realized_pnl AS realized_pnl,
           ps.client_order_id AS client_order_id
         FROM trade_journal AS ps
         LEFT JOIN trade_journal AS pre
           ON pre.client_order_id = ps.client_order_id
           AND pre.trade_event_type = 'pre_submit'
         WHERE ps.symbol = ?
           AND ps.trade_event_type = 'post_submit'
           AND ps.filled_price IS NOT NULL
         ORDER BY ps.id ASC`,
      )
      .bind(symbol)
      .all<{
        timestamp: string
        pre_side: string | null
        filled_price: number | null
        filled_qty: number | null
        realized_pnl: number | null
        client_order_id: string | null
      }>(),
    fetchDoPosition(env, symbol),
  ])
  const logs = logsResult.results ?? [] // SQL は既に ASC で返している
  const points: SymbolChartPoint[] = logs
    .filter((r) => r.price !== null && Number.isFinite(Number(r.price)))
    .map((r) => {
      const indicators = parseIndicators(r.indicators_json)
      return {
        timestamp: r.timestamp,
        price: Number(r.price),
        sma50: indicators.sma50,
        high20d: indicators.high20d,
        low20d: indicators.low20d,
      }
    })
  // 判定点 (文字ログ↔グラフ同期 #decision-trace): HOLD を除く BUY/SELL/SKIP/REJECT/
  // ERROR を eval 時刻 × eval 価格でチャートに重ねる。各点はクリック時に出す
  // ラダー HTML を server-side で事前レンダリング (renderDecisionLadder 流用)。
  // 最新側 MAX_CHART_DECISIONS 件に cap (各点が HTML を持つため payload ガード)。
  const decisions: SymbolChartDecision[] = logs
    .filter(
      (r) =>
        r.price !== null &&
        Number.isFinite(Number(r.price)) &&
        CHART_PLOTTED_DECISIONS.has((r.decision ?? '').toUpperCase()),
    )
    .map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      price: Number(r.price),
      decision: (r.decision ?? '').toUpperCase() as SymbolChartDecision['decision'],
      reason: r.reason,
      ladderHtml: renderChartDecisionTrace(r.trace_json, r.decision ?? '', r.reason, currencyOfSymbol(symbol)),
    }))
    .slice(-MAX_CHART_DECISIONS)

  // 入場距離 (#entry-distance) 用: 完全な指標を JST 日ごと最後の評価で集約し
  // 直近 MAX_EVAL_INDICATOR_DAYS 日を残す。日次集約は sma50/high20d/return50d が
  // 日次指標であり、5 分 cron の intraday 重複を除いて「入場までの距離推移」を
  // きれいに見せるため。Map は挿入順 (= 日の初出順 = 時系列) を保ち、同日キーは
  // 後続 (= その日の最後の評価) で値が上書きされる。
  const evalByDay = new Map<string, EvalIndicatorPoint>()
  for (const r of logs) {
    const indicators = parseFullIndicators(r.indicators_json)
    if (!indicators) continue
    const dayKey = jstDayKey(r.timestamp)
    if (!dayKey) continue
    evalByDay.set(dayKey, { timestamp: r.timestamp, indicators })
  }
  const evalIndicators: EvalIndicatorPoint[] = Array.from(evalByDay.values()).slice(
    -MAX_EVAL_INDICATOR_DAYS,
  )

  const markers: SymbolChartMarker[] = (fillsResult.results ?? [])
    .filter((r) => r.filled_price !== null)
    .map((r) => ({
      timestamp: r.timestamp,
      side: resolveFillSide(r.pre_side, r.realized_pnl),
      price: Number(r.filled_price),
      qty: r.filled_qty === null ? null : Number(r.filled_qty),
      realizedPnl: r.realized_pnl === null ? null : Number(r.realized_pnl),
      clientOrderId: r.client_order_id ?? null,
    }))
  // DO query の結果が undefined = binding 無し or fetch 失敗 → derive にフォールバック
  const position = doPosition !== undefined ? doPosition : deriveOpenPosition(markers)

  // Yahoo daily bars 60 日: chart 全体の price line + pivot 検出に使う。
  // Yahoo fetch 失敗時は cron-eval points のみで描画 (短い price line になるが
  // 致命的ではない)。lastTimestamp が無い (chart 自体空) なら filtering 不要。
  const yahooBarsRaw = await fetchYahooBarsForChart(symbol, 60)
  const cronLastTs = points.length > 0 ? points[points.length - 1]!.timestamp : null
  const yahooBars =
    cronLastTs == null ? yahooBarsRaw : yahooBarsRaw.filter((b) => b.timestamp <= cronLastTs)

  // 最新 cron-eval point (= 実 strategy 評価で使った値) を merge 前に snapshot。
  // mergedPoints[末尾] は Yahoo daily filler の可能性があり (cron 停止中 / 古い銘柄)、
  // preview stop/TP に使うと「strategy 上は触ってない過去 Yahoo 値」で線が引かれて
  // 誤解を招く。preview は cron eval 履歴がある時だけ描く方針 → null フィールドで
  // 「描画スキップ」シグナルにする。
  const { latestCronPrice, latestCronTimestamp } = selectLatestCronSnapshot(points)

  // Yahoo bar を points にマージして全期間 price line を実現。同 timestamp で
  // 既に cron-eval point があればそちらを優先 (indicators が乗っているため)。
  // Yahoo bar 由来の point は indicators フィールド全 null。
  const mergedPoints = mergeYahooAndCronPoints(yahooBars, points)
  const lastTimestamp =
    mergedPoints.length > 0 ? mergedPoints[mergedPoints.length - 1]!.timestamp : null

  // 価格トレンド: 直近 30 暦日 (regime shift を跨がない短期) の daily close
  // を最小二乗で fit した linear regression line。pivot ベース (上値抵抗 /
  // 下値支持) は candle の「上下を flat に走る bound 線」になりやすく、user
  // 期待である「ローソク足の中心を辿る trend」を表現できなかったため、close
  // の重心を通る best-fit 1 本に置き換えた (#190 系の見直し)。
  //
  // データ source: Yahoo daily が ≥5 本あればそれ、不足なら cron-eval 由来の
  // 日次 close fallback。30 日に満たないデータでも残っている分すべて使う
  // (< 2 なら null 返却 → 描画スキップ)。
  const TREND_WINDOW_DAYS = 30
  const trendCutoffMs = lastTimestamp
    ? new Date(lastTimestamp).getTime() - TREND_WINDOW_DAYS * 24 * 3600 * 1000
    : 0
  const trendDailySource: Array<{ jstDate: string; close: number; timestamp: string }> = (() => {
    if (!lastTimestamp) return []
    const fromYahoo = yahooBars.filter((b) => new Date(b.timestamp).getTime() >= trendCutoffMs)
    if (fromYahoo.length >= 5) return fromYahoo
    return aggregateDailyCloses(points).filter(
      (p) => new Date(p.timestamp).getTime() >= trendCutoffMs,
    )
  })()
  const trendLine = lastTimestamp
    ? computeLinearRegressionLine(
        trendDailySource.map((d) => ({ timestamp: d.timestamp, close: d.close })),
        lastTimestamp,
      )
    : null
  // candlestick: 15 分足 (intraday) を Yahoo から fetch。旧 1h 足は「1日 ≈ 7本」
  // でスカスカだった (operator 指摘)。category 軸化で overnight gap は詰まる
  // ようになり、barWidth も auto にしたため 15m の旧懸念 (gap 後の clustering)
  // は解消済。Yahoo intraday range 制限 60d は 15m でもカバー可能。
  // 戦略 cron は従来通り 60m を使う (pullbackScheduler 側、ここは表示専用)。
  // 失敗 (network 等) なら空配列で fallback (candle 自体スキップ)。
  let intradayBars: OhlcBar[] = []
  try {
    const intraday = await new YahooBarClient().getIntradayBars(symbol, '15m')
    // lastTimestamp フィルタ: chart x 軸範囲を超える bar (将来に出るはずの bar)
    // を除外。lastTimestamp が無いときは全件採用。
    intradayBars = (cronLastTs == null
      ? intraday
      : intraday.filter((b) => b.timestamp <= cronLastTs)
    ).map((b) => ({
      timestamp: b.timestamp,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }))
  } catch (err) {
    if (err instanceof RangeError) throw err
    // network / parse error → 空 fallback
  }
  return {
    symbol,
    points: mergedPoints,
    markers,
    position,
    rules,
    trendLine,
    intradayBars: intradayBars,
    latestCronPrice,
    latestCronTimestamp,
    decisions,
    evalIndicators,
    // closed round-trip の保有区間 (markArea 用)。markers は SQL の id ASC で
    // 時系列昇順が保証されているのでそのまま突合できる。
    holdingSpans: pairClosedTrades(markers),
  }
}

/**
 * cron-eval points の末尾 (= 実 strategy 評価で参照した最新価格) を取り出して
 * `{ latestCronPrice, latestCronTimestamp }` を返す。preview stop/TP は
 * Yahoo filler を含む `mergedPoints[末尾]` ではなくこちらを使う方針。
 *
 * - cron 履歴空 / 末尾 price 非有限 / 末尾 timestamp 不正 → 全 null
 *   (= preview 描画スキップのシグナル)。
 * - 末尾の price は >= 0 で finite なものだけ採用 (株価の sanity check)。
 *
 * 入力は merge 前 (= strategy_decision_log 由来) の SymbolChartPoint[] を想定。
 * 呼出側が誤って merged points を渡しても動くが、その場合は filler 末尾を
 * 拾うので preview の意図と乖離する。設計上、`loadSymbolChart` 内で merge
 * 前に呼ぶこと。
 */
export function selectLatestCronSnapshot(
  cronPoints: SymbolChartPoint[],
): { latestCronPrice: number | null; latestCronTimestamp: string | null } {
  if (cronPoints.length === 0) {
    return { latestCronPrice: null, latestCronTimestamp: null }
  }
  const last = cronPoints[cronPoints.length - 1]!
  const tsValid = Number.isFinite(new Date(last.timestamp).getTime())
  const priceValid = Number.isFinite(last.price)
  if (!tsValid || !priceValid) {
    return { latestCronPrice: null, latestCronTimestamp: null }
  }
  return { latestCronPrice: last.price, latestCronTimestamp: last.timestamp }
}

/**
 * Yahoo daily bars と cron-eval points をマージ。同 JST 日では cron-eval を
 * 優先 (indicators が乗っているため)、それ以外の日は Yahoo bar を price-only
 * の point として追加。timestamp 昇順で返す。
 */
export function mergeYahooAndCronPoints(
  yahooBars: Array<{ jstDate: string; close: number; sma50?: number | null; timestamp: string }>,
  cronPoints: SymbolChartPoint[],
): SymbolChartPoint[] {
  // 不正 timestamp の cron point は最初に除外。残すと ECharts time 軸 / chart
  // 末尾判定 (lastTimestamp = mergedPoints[-1]) が壊れる。
  const validCronPoints = cronPoints.filter((p) =>
    Number.isFinite(new Date(p.timestamp).getTime()),
  )
  // cron eval は同 JST 日の sma50 が null になりうる (古い row)。Yahoo 側で
  // 算出した sma50 を JST 日キーで参照できるよう Map にしておく。同 JST 日
  // 内の cron eval が複数あっても全部に同じ Yahoo SMA50 が振られる。
  const yahooSmaByJstDate = new Map<string, number | null>(
    yahooBars.map((b) => [b.jstDate, b.sma50 ?? null]),
  )
  const cronJstDates = new Set(
    validCronPoints.map((p) =>
      new Date(new Date(p.timestamp).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10),
    ),
  )
  // Yahoo bar の SMA50 を cron point にも反映 (cron 側 indicators_json の sma50
  // が null の古い row でも線が途切れない)。cron 側が既に sma50 を持っていれば
  // それを優先 (より最新かつ rules と整合する)。
  const enrichedCronPoints: SymbolChartPoint[] = validCronPoints.map((p) => {
    if (p.sma50 != null) return p
    const jstDate = new Date(new Date(p.timestamp).getTime() + 9 * 3600 * 1000)
      .toISOString()
      .slice(0, 10)
    const fallback = yahooSmaByJstDate.get(jstDate) ?? null
    return fallback == null ? p : { ...p, sma50: fallback }
  })
  const yahooFiller: SymbolChartPoint[] = yahooBars
    .filter((b) => !cronJstDates.has(b.jstDate))
    .map((b) => ({
      timestamp: b.timestamp,
      price: b.close,
      sma50: b.sma50 ?? null,
      high20d: null,
      low20d: null,
    }))
  return [...yahooFiller, ...enrichedCronPoints].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  )
}

/**
 * Yahoo daily bars を chart 用に fetch (lookback 営業日)。timestamp は date
 * 部分 + 16:00 UTC (≈ 1:00 JST 翌日 ≈ "evening of date") で擬似生成、
 * trend line の傾き計算には相対精度として十分。
 *
 * エラー方針: caller contract 違反 (RangeError = lookback 不正) は呼出元の
 * 実装バグなので throw 再送出する。それ以外 (network / parse / 一時的
 * fetch 失敗) のみ空配列で fallback を呼出元に伝える。
 */
export async function fetchYahooBarsForChart(
  symbol: string,
  lookback: number,
): Promise<Array<{ jstDate: string; open: number; high: number; low: number; close: number; sma50: number | null; timestamp: string }>> {
  // warmup を足してから getDailyBars に渡す方式だと lookback=0 / 小さな負値で
  // も内側の lookback (lookback+warmup) が正の整数になり validation を素通り
  // してしまう (slice(-0)=slice(0) で warmup 区間が全部返る等)。caller contract
  // を維持するためここで先に弾く。整数性は getDailyBars 側の `Number.isInteger`
  // と整合させる。
  if (!Number.isInteger(lookback) || lookback <= 0) {
    throw new RangeError(
      `fetchYahooBarsForChart: lookback must be a positive integer, got ${lookback}`,
    )
  }
  const client = new YahooBarClient()
  try {
    // SMA50 を「先頭の chart 表示日」から埋めたいので、表示 lookback に加えて
    // SMA50 warmup の 50 日を上乗せして fetch する。表示時に lookback 件分を
    // 末尾から切り出す。
    const warmup = 50
    const bars = await client.getDailyBars(symbol, lookback + warmup)
    const closes = bars.map((b) => b.close)
    const smaSeries = computeRollingSma(closes, 50)
    const enriched = bars.map((b, i) => ({
      jstDate: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      sma50: smaSeries[i] ?? null,
      // JST 00:00 anchor: ECharts time axis (UTC) で JST formatter にかけると
      // b.date と同じ JST カレンダー日に column が配置される。
      // 旧実装 `${b.date}T16:00Z` だと JST 翌 01:00 に shift し、
      // 例えば US bar "04/25" が JST 04/26 列に表示される回帰があった。
      timestamp: anchorJstMidnight(b.date),
    }))
    // 表示は lookback 件分のみ (warmup 区間は SMA50 算出に使い切ったので破棄)。
    // bars が要求件数より少ない (上場初日近辺など) ケースもそのまま素通し。
    return enriched.length > lookback ? enriched.slice(-lookback) : enriched
  } catch (err) {
    // RangeError は呼出元コード側の lookback 不正 (実装ミス)。silent fallback で
    // 隠さず再送出して dashboard handler の try/catch まで伝える。
    if (err instanceof RangeError) throw err
    return []
  }
}

/**
 * `values[i]` を window 期間の単純移動平均に変換。i < window-1 は null。
 * SMA50 に流用するが任意 window で使える素朴実装。NaN/Infinity が混じった
 * 場合 sum が壊れるので入力側で予め弾く前提。
 */
export function computeRollingSma(values: number[], window: number): Array<number | null> {
  if (window <= 0) return values.map(() => null)
  const out: Array<number | null> = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!
    if (i >= window) sum -= values[i - window]!
    if (i >= window - 1) out[i] = sum / window
  }
  return out
}

/**
 * "YYYY-MM-DD" を「その日の JST 00:00 = UTC -9h 前日 15:00」の ISO Z 文字列に。
 * 例: "2026-04-25" → "2026-04-24T15:00:00.000Z" (JST 04/25 00:00)。
 * Yahoo bar / 他のロジックとの timestamp 比較を Z 形式で揃えるため。
 */
export function anchorJstMidnight(date: string): string {
  return new Date(`${date}T00:00:00+09:00`).toISOString()
}

/**
 * cron-eval price (Yahoo daily close を 15 分毎に複製したもの) を JST 日次で
 * dedupe して、その日の最終 cron eval を「日次 close」として採用。
 * trend line / pivot 検出は日足ベースで行うのが標準。
 */
export function aggregateDailyCloses(
  points: SymbolChartPoint[],
): Array<{ jstDate: string; close: number; timestamp: string }> {
  const byDay = new Map<string, { jstDate: string; close: number; timestamp: string }>()
  for (const p of points) {
    if (p.price == null || !Number.isFinite(p.price)) continue
    const ms = new Date(p.timestamp).getTime()
    if (!Number.isFinite(ms)) continue
    // JST date = UTC + 9h、ISO の前 10 文字
    const jstDate = new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10)
    // last write wins → その日の最終 cron eval
    byDay.set(jstDate, { jstDate, close: p.price, timestamp: p.timestamp })
  }
  return [...byDay.values()].sort((a, b) => (a.jstDate < b.jstDate ? -1 : 1))
}

/**
 * Daily close の最小二乗 (ordinary least squares) で価格中央を best-fit する
 * linear regression line を返す。「ローソク足の中心を辿るトレンド」を出すた
 * めの実装で、pivot ベースの上下 bound 線とは目的が違う。
 *
 * 戻り値の形は既存 `TrendLineSegment` を再利用 (densifyTrendLine が `pivots[0]`
 * と `end` の 2 点を読むだけ):
 * - `pivots[0]`: regression line 上の最古 sample timestamp 上の点 (= 線の左端)
 * - `pivots[1]`: 同じ slope を持つ参照点として `end` と同じ点を入れている
 *               (densify では未使用、互換のため形を保つ)
 * - `end`: `endTimestamp` (通常は chart の最新 timestamp) 上の外挿点
 *
 * 入力は `{ timestamp, close }` の配列 (順序不問、内部で時系列に並べる)。
 * 以下のケースで null:
 * - 有効な data point (Number.isFinite な timestamp / close) が 2 未満
 * - 全 sample が同 timestamp (slope 不定)
 * - `endTimestamp` が解釈不能
 * - 計算結果が NaN / Infinity
 *
 * regime filter は意図的に持たない: regression は close 全体の重心を取るので
 * 「別 regime の pivot」概念がそもそも存在しない。窓を 30 日程度に絞ること
 * が regime 跨ぎ対策を兼ねる。
 */
export function computeLinearRegressionLine(
  samples: ReadonlyArray<{ timestamp: string; close: number }>,
  endTimestamp: string,
): TrendLineSegment | null {
  // 有効値のみ抽出 (NaN / Infinity / 不正 timestamp は除外)
  const points: Array<{ t: number; y: number; timestamp: string }> = []
  for (const s of samples) {
    const t = new Date(s.timestamp).getTime()
    const y = s.close
    if (!Number.isFinite(t)) continue
    if (typeof y !== 'number' || !Number.isFinite(y)) continue
    points.push({ t, y, timestamp: s.timestamp })
  }
  if (points.length < 2) return null
  // 時系列で安定 sort (同 t は input 順を維持)
  points.sort((a, b) => a.t - b.t)
  // 全 sample が同 timestamp なら slope 不定
  if (points[0]!.t === points[points.length - 1]!.t) return null

  const tEnd = new Date(endTimestamp).getTime()
  if (!Number.isFinite(tEnd)) return null

  // OLS: y = a*t + b。t を「最古 sample 基準のオフセット」に正規化して
  // epoch ms (~1.7e12) 由来の桁あふれを抑える (slope は同じ)。
  const t0 = points[0]!.t
  let sumT = 0
  let sumY = 0
  for (const p of points) {
    sumT += p.t - t0
    sumY += p.y
  }
  const n = points.length
  const meanT = sumT / n
  const meanY = sumY / n
  let num = 0
  let den = 0
  for (const p of points) {
    const dt = p.t - t0 - meanT
    num += dt * (p.y - meanY)
    den += dt * dt
  }
  if (den === 0) return null
  const slope = num / den
  const intercept = meanY - slope * meanT
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null

  // 線の左端 = 最古 sample timestamp 上の regression y
  const startT = points[0]!.t
  const startY = intercept + slope * (startT - t0)
  // 右端 = endTimestamp 上の regression y (将来 / 既知点いずれでも線形外挿)
  const endY = intercept + slope * (tEnd - t0)
  if (!Number.isFinite(startY) || !Number.isFinite(endY)) return null

  const startPoint: PivotPoint = {
    timestamp: points[0]!.timestamp,
    price: startY,
    // type は描画上未使用。互換のため 'low' を入れておく (意味はない)
    type: 'low',
  }
  const endPoint: PivotPoint = {
    timestamp: endTimestamp,
    price: endY,
    type: 'low',
  }
  return {
    pivots: [startPoint, endPoint],
    end: { timestamp: endTimestamp, price: endY },
  }
}

/**
 * Trend line を「描画用の密点列」に展開する。
 *
 * 背景: ECharts の dataZoom + 2 点 line series は「片方の点が zoom 範囲外
 * になると線が引かれない」既知挙動が widely 報告されている (issue #3637 系)。
 * #189 で `filterMode: 'weakFilter'` に変更したが、それでもユーザ環境で
 * trend line が描画されないケースが残った。
 *
 * 最も robust な解決策は line の data 自体を「常に zoom 範囲内に複数点が
 * 入る粒度」にすること。ここでは intradayBars (15m candle、60 日で ~1500 点)
 * の各 timestamp で trend line の y 値を線形補間して、`[[t, y], ...]` の
 * dense path に展開する。これで 5D (~120 点) や 1D zoom でも常に複数点が
 * visible になり filterMode 不問で確実に描画される。
 *
 * 線形外挿: trend line は本来両側に伸びる概念線なので、p1 より過去側 / end
 * より未来側の sample timestamp も同じ slope で外挿する (chart の見た目で
 * 線が早期に「途切れる」のを避ける)。
 *
 * Fallback: sampleTimestamps が空 (Yahoo intraday fetch 失敗時 = 0 件) の
 * とき、または line の 2 点が degenerate (t1 == t2) のときは 2 点
 * endpoint をそのまま返す (旧挙動 = 描画は zoom 不安定だが少なくとも
 * 全期間表示では出る)。
 */
export function densifyTrendLine(
  line: TrendLineSegment | null,
  sampleTimestamps: ReadonlyArray<string | number>,
): Array<[number, number]> | null {
  if (!line) return null
  const t1 = new Date(line.pivots[0].timestamp).getTime()
  const t2 = new Date(line.end.timestamp).getTime()
  const y1 = line.pivots[0].price
  const y2 = line.end.price
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null
  if (!Number.isFinite(y1) || !Number.isFinite(y2)) return null
  // degenerate: 2 点が同 timestamp → 線の slope 不定。fallback で 2 点返し。
  if (t1 === t2) return [[t1, y1], [t2, y2]]
  const slope = (y2 - y1) / (t2 - t1)
  // sample timestamps を epoch ms に正規化、無効値は除外、unique + 昇順
  const tsSet = new Set<number>()
  for (const s of sampleTimestamps) {
    const t = typeof s === 'number' ? s : new Date(s).getTime()
    if (Number.isFinite(t)) tsSet.add(t)
  }
  // line の 2 点も常に含めて「pivot / end ちょうどでの y」を保証
  tsSet.add(t1)
  tsSet.add(t2)
  const sorted = Array.from(tsSet).sort((a, b) => a - b)
  // sample 0 件 (intradayBars 空) のときは 2 点 fallback
  if (sorted.length < 2) return [[t1, y1], [t2, y2]]
  const out: Array<[number, number]> = []
  for (const t of sorted) {
    const y = y1 + slope * (t - t1)
    if (Number.isFinite(y)) out.push([t, y])
  }
  // out が空になることは tsSet に t1/t2 を入れているのでまず無いが、
  // 安全のため最終 fallback。
  if (out.length < 2) return [[t1, y1], [t2, y2]]
  return out
}

/**
 * 保有中の avg / stop / take-profit のような「水平線分」を「描画用の密点列」
 * に展開する (`densifyTrendLine` と同じ目的の slope=0 特殊化)。
 *
 * 背景: 旧実装では candlestick の `markLine` に [{coord:[fromTs,y]}, {coord:[toTs,y]}]
 * の 2 点だけを渡していたが、ECharts の dataZoom + markLine は trend line と
 * 同様に「片端が zoom 範囲外になると markLine 全体が描画されない」回帰が
 * 起きる (#190 / #191 の trend line と同根、issue #3637 系)。1D zoom in で
 * `openedAt` が範囲外になり avg / stop / TP が一斉に消えるユーザ報告に
 * 対応するため、本関数で fromTs〜toTs を intradayBars timestamps で密化した
 * `[[t, y], ...]` に展開し、独立 `type: 'line'` series として描画する。
 *
 * 仕様:
 * - 戻り値は ascending order の `[t, y]` 配列。`fromTs` と `toTs` は端点として
 *   常に含む (sample に存在しなくても)。`samples` のうち `[fromTs, toTs]`
 *   範囲内のものを併合してユニーク化 + 昇順 sort。
 * - 水平線なので y は常に `yValue` (一定)。
 * - `fromTs > toTs` の degenerate ケース (openedAt > 最新 timestamp、cron が
 *   未だ走っていない直後) は 2 点 fallback `[[fromTs, y], [toTs, y]]`。
 *   呼び元側で既に `endTs = max(latestTs, openedAt)` の clamp をかけている
 *   ため通常は通らないが防御。
 * - `yValue` / `fromTs` / `toTs` が NaN / Infinity / 不正 ISO string なら null
 *   (描画 skip)。
 * - `samples` の不正値 (NaN / non-ISO string) は除外。
 */
export function densifyHorizontalLine(
  yValue: number,
  fromTs: string | number,
  toTs: string | number,
  samples: ReadonlyArray<string | number>,
): Array<[number, number]> | null {
  if (!Number.isFinite(yValue)) return null
  const a = typeof fromTs === 'number' ? fromTs : new Date(fromTs).getTime()
  const b = typeof toTs === 'number' ? toTs : new Date(toTs).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  // degenerate: fromTs >= toTs。端点 2 点だけ返す (描画は実質 1 点と同等
  // だが series.data が空にならないようにする)。
  if (a >= b) return [[a, yValue], [b, yValue]]
  const tsSet = new Set<number>()
  // 端点を必ず含める
  tsSet.add(a)
  tsSet.add(b)
  for (const s of samples) {
    const t = typeof s === 'number' ? s : new Date(s).getTime()
    if (!Number.isFinite(t)) continue
    if (t < a || t > b) continue
    tsSet.add(t)
  }
  const sorted = Array.from(tsSet).sort((x, y) => x - y)
  return sorted.map((t) => [t, yValue] as [number, number])
}

/**
 * fill 行の BUY/SELL を決定する。
 * - 1st: pre_submit 行から JOIN で取得した side ('BUY'/'SELL') を採用
 * - 2nd: それも無い場合は realized_pnl の有無で推測
 *   - realized_pnl が null = entry trade (= BUY)
 *   - realized_pnl が非 null = exit trade (= SELL、reconcileFills が
 *     `(filled_price - prior avg) * filled_qty` で計算する)
 * - 3rd (defensive): どちらでも判断できなければ BUY (entry が圧倒的多数)
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
 * SymbolStateDO から現保有を引く。binding 無し / 失敗時は undefined を返して
 * 呼び元に「derive にフォールバックすべき」と伝える (null は「DO 上明示的に無保有」)。
 */
export async function fetchDoPosition(
  env: Env,
  symbol: string,
): Promise<SymbolChartPosition | null | undefined> {
  if (!env.SYMBOL_STATE) return undefined
  try {
    const state = await new SymbolStateClient(env.SYMBOL_STATE).getState(symbol)
    if (!state.position) return null
    return { avgPrice: state.position.avgPrice, openedAt: state.position.openedAt }
  } catch {
    return undefined
  }
}

/**
 * 直近 fills を時系列で巻き戻し、最後に「BUY → SELL」で閉じていなければ
 * 現保有とみなす。partial fill / position add は POC 未対応 (直近 BUY だけ採用)。
 */
export function deriveOpenPosition(markers: SymbolChartMarker[]): SymbolChartPosition | null {
  let latestBuy: SymbolChartMarker | null = null
  for (const m of markers) {
    if (m.side === 'BUY') latestBuy = m
    else if (m.side === 'SELL') latestBuy = null
  }
  return latestBuy ? { avgPrice: latestBuy.price, openedAt: latestBuy.timestamp } : null
}

export function extractSma50(indicatorsJson: string | null): number | null {
  return parseIndicators(indicatorsJson).sma50
}

export interface ExtractedIndicators {
  sma50: number | null
  high20d: number | null
  low20d: number | null
}

/**
 * indicators_json から chart で使う数値を一括抽出。JSON.parse 失敗 / 数値外は null。
 * low20d は #158 follow-up で追加されたため、既存の indicators_json には未収録 →
 * 古い行は null fallback で grace 化。新しい cron 実行から徐々に出揃う。
 */
export function parseIndicators(indicatorsJson: string | null): ExtractedIndicators {
  if (!indicatorsJson) return { sma50: null, high20d: null, low20d: null }
  try {
    const obj = JSON.parse(indicatorsJson) as {
      sma50?: unknown
      high20d?: unknown
      low20d?: unknown
    }
    return {
      sma50:
        typeof obj.sma50 === 'number' && Number.isFinite(obj.sma50) ? obj.sma50 : null,
      high20d:
        typeof obj.high20d === 'number' && Number.isFinite(obj.high20d) ? obj.high20d : null,
      low20d:
        typeof obj.low20d === 'number' && Number.isFinite(obj.low20d) ? obj.low20d : null,
    }
  } catch {
    return { sma50: null, high20d: null, low20d: null }
  }
}

/**
 * indicators_json から完全な `PullbackIndicators` を取り出す (#entry-distance)。
 * 入場距離計算は price/sma50/return50d/high20d/atr20/baselineAtr20 の全部が要る。
 * 1 つでも欠けて / 非有限なら null (= その評価日は距離計算に使わない)。
 */
export function parseFullIndicators(indicatorsJson: string | null): PullbackIndicators | null {
  if (!indicatorsJson) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(indicatorsJson) as Record<string, unknown>
  } catch {
    return null
  }
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  const price = num(obj.price)
  const sma50 = num(obj.sma50)
  const return50d = num(obj.return50d)
  const high20d = num(obj.high20d)
  const atr20 = num(obj.atr20)
  const baselineAtr20 = num(obj.baselineAtr20)
  if (
    price === null ||
    sma50 === null ||
    return50d === null ||
    high20d === null ||
    atr20 === null ||
    baselineAtr20 === null
  ) {
    return null
  }
  return { price, sma50, return50d, high20d, atr20, baselineAtr20 }
}

/** 入場距離計算に残す日次ユニーク評価の最大日数 (直近側)。 */
export const MAX_EVAL_INDICATOR_DAYS = 20

export const JST_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** ISO UTC timestamp を JST 日付キー ('YYYY-MM-DD') に。不正なら null。 */
export function jstDayKey(iso: string): string | null {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  return JST_DAY_FMT.format(new Date(t))
}

/**
 * チャート銘柄タブの JSON export packet builder
 * (schema: `dashboard_chart_symbol_export.v1`, #dashboard-json-api)。
 *
 * SSR の銘柄タブと同じ loader (`loadSymbolChart` + `loadDecisionRows`) の結果を
 * そのまま機械可読化する。HTML 断片は含めない:
 * - `decisions[].ladderHtml` (事前レンダリング済みラダー HTML) は表示専用なので
 *   落とし、`chartDecisions` には構造化 field だけを残す。
 * - 判定履歴側の trace は `decisionHistory[].trace` に parse 済み object で入る
 *   (AI / スクリプトは raw JSON 文字列を再 parse しなくてよい)。
 */
export function buildSymbolChartPacket(chart: SymbolChartData, decisionRows: DecisionRow[]) {
  return {
    ...exportMeta('dashboard_chart_symbol_export.v1'),
    symbol: chart.symbol,
    /** SSR チャート overlay と同じ effective rule (global → role preset → override)。 */
    rules: chart.rules,
    points: chart.points,
    markers: chart.markers,
    position: chart.position,
    trendLine: chart.trendLine,
    intradayBars: chart.intradayBars,
    latestCronPrice: chart.latestCronPrice,
    latestCronTimestamp: chart.latestCronTimestamp,
    evalIndicators: chart.evalIndicators ?? [],
    chartDecisions: (chart.decisions ?? []).map(({ ladderHtml: _ladderHtml, ...rest }) => rest),
    // SSR の判定履歴テーブル (直近 30 件、#decisions-chart-unify) 相当。
    decisionHistory: decisionRows.map((r) => ({
      ...cronDecisionJson(r),
      requestId: r.requestId,
      trace: parseJsonObject(r.traceJson ?? null),
    })),
  }
}
