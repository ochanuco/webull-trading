/**
 * Per-symbol risk gate (pure, except one observability `console.warn` when the
 * spread guard is skipped for a bid/ask-less quote source — see gate 4 / #411).
 *
 * 7 つの per-symbol guard を一つの pure function に集約する。manual
 * `/trade/execute` 経路 (TradingService) と cron (`runPullbackScheduler`) の
 * 両方が同じ判定を通るよう unify する目的 (issue #138)。
 *
 * 含まれる gate:
 *   1. settled cash (BUY only): notional > settledCash で reject
 *   2. inverse pair (BUY only): inverse 銘柄の建玉が残っていれば reject
 *   3. quote freshness (BUY only / halt fallback): lastQuote.fetchedAt が staleQuoteMs を超えれば reject
 *   4. spread guard (BUY only): 異常 / spread% が limit 超で reject。bid/ask 欠損は
 *      source 次第 — Yahoo 等 bid/ask 非対応 source は適用外で通す、それ以外は fail-closed (issue #411)
 *   5. gap re-eval (BUY only): avgPrice と lastQuote.price の |gap| > gapRejectPct で reject
 *   6. JP 値幅制限 (BUY only): JP 銘柄かつ band 外 limit price で reject
 *   7. (option) cooldown: state.cooldownUntil が未来なら reject
 *
 * Gate 3-6 は **エントリ抑止** が目的なので BUY only。SELL/exit (stop hit / 損切り)
 * は stale quote / wide spread / 大 gap / JP band 外でも実行を優先する
 * (= 損切りが永久 block されて position 塩漬けにならないように)。
 *
 * 含まれない gate (orchestrator 層が直接持つ):
 *   - portfolio-wide drawdown kill
 *   - tradingDisabledUntil
 *   - pending lock TTL (副作用持ちなので呼び出し側に残す)
 *   - bucket cap (cron 側で pre-scan が必要)
 *
 * Inverse pair 評価は同期化のため、呼び出し側が事前に inverse 銘柄の SymbolState
 * を読み出して `inverseState` として渡す責務を負う (cron は per-symbol loop の
 * 中で fetch、TradingService は async wrapper で fetch)。
 */
import type { QuoteSnapshot, SymbolState } from '../state/types'
import { inferWebullMarket } from '../../infrastructure/webull/mapper'
import { YAHOO_QUOTE_SOURCE } from '../../infrastructure/quotes/YahooQuoteClient'
import { isWithinJpPriceBand } from './jpPriceBand'
import { computeSpreadPct } from './spreadGuard'

/**
 * Quote source が構造的に bid/ask を持たない (= spread を計算できない) もの。
 * Yahoo `/v8/chart` meta は bid/ask を返さない (PR #334 で default 化)。これらの
 * source で bid/ask 欠損は「異常」ではなく「仕様」なので、spread guard を
 * **適用外 (skip)** にして発注を通す (degraded but tradeable)。Webull 等 bid/ask を
 * 返すべき source での欠損は従来通り fail-closed。Webull market-data 復活で
 * bid/ask が実データになれば本 set を空にして本来運用へ戻す (issue #411 = 案B)。
 */
const QUOTE_SOURCES_WITHOUT_BID_ASK: ReadonlySet<string> = new Set([YAHOO_QUOTE_SOURCE])

export interface PerSymbolRiskInput {
  symbol: string
  side: 'BUY' | 'SELL'
  /** Order limit price (used for JP price band). */
  intentPrice: number
  /** Order notional (qty × price), used for settled-cash gate. */
  intentNotional: number
  /** Latest known SymbolState for `symbol` (cooldown / position / lastQuote / settledCash). */
  state: SymbolState
  /**
   * Pre-fetched SymbolState for the inverse symbol (per `config.inversePairs`).
   * `null` when the symbol has no inverse mapping or fetch failed (fail-open
   * for inverse only — fetch errors are not the gate's responsibility).
   */
  inverseState?: SymbolState | null
  /** Wall clock for cooldown / freshness comparisons. */
  now: Date
}

export interface PerSymbolRiskConfig {
  /**
   * Symbol → inverse symbol map (already upper-cased keys). When BUY is
   * requested for `symbol` and `inverseState.position.qty > 0`, reject.
   */
  inversePairs: Record<string, string>
  /** Per-market spread limits as fractions of mid (e.g. 0.0025 = 0.25%). */
  spreadLimits: { US: number; JP: number }
  /** lastQuote.fetchedAt より古い経過時間 (ms) を超えれば halt 扱い。 */
  staleQuoteMs: number
  /** position.avgPrice と lastQuote.price の |gap| 比率閾値。 */
  gapRejectPct: number
  /**
   * `true` のとき state.cooldownUntil の評価も行う。manual TradingService 経路
   * は従来 applyStateGate 内で評価していたので互換のため有効化、cron 経路は
   * Strategy.decide() が同等判定を持つので冗長。両方 true でも behaviour 一致。
   */
  evaluateCooldown?: boolean
}

export interface PerSymbolRiskDecision {
  approved: boolean
  /**
   * Approved=false のときの reject 理由。複数 gate が同時に reject しても
   * **最初に当たった一つだけ** を返す (既存 TradingService の挙動と同じ:
   * `appendReason` で 1 回 return)。cron 側 dashboard も先勝ちで表示する。
   */
  reasons: string[]
}

const APPROVED: PerSymbolRiskDecision = Object.freeze({ approved: true, reasons: [] })

export function evaluatePerSymbolRisk(
  input: PerSymbolRiskInput,
  config: PerSymbolRiskConfig,
): PerSymbolRiskDecision {
  const { state, side, symbol, now, intentNotional, intentPrice } = input

  // 1. cooldown (option): TradingService 互換のため最初に評価。
  if (config.evaluateCooldown && state.cooldownUntil) {
    const until = new Date(state.cooldownUntil).getTime()
    if (Number.isFinite(until) && until > now.getTime()) {
      return reject(`cooldown active until ${state.cooldownUntil}`)
    }
  }

  // 2. settled cash (BUY only)。settledCash=0 は未 seed 扱いで skip。
  if (side === 'BUY' && state.settledCash > 0 && intentNotional > state.settledCash) {
    return reject(
      `insufficient settled cash: notional ${intentNotional} exceeds settledCash ${state.settledCash}`,
    )
  }

  // 3. inverse pair (BUY only)。呼び出し側が pre-fetch した inverseState を見る。
  //    (#315) この check が SOXL/SOXS を「regime hedge」として運用するための
  //    要 — 同時に両建てになる dead-money 状態を構造的に発生させない。一方を
  //    SELL し終わってから他方の BUY が通る、交互運用が前提。
  if (side === 'BUY') {
    const inverseSymbol = config.inversePairs[symbol.toUpperCase()]
    if (inverseSymbol && input.inverseState) {
      const inversePos = input.inverseState.position
      if (inversePos !== null && inversePos.qty > 0) {
        return reject(
          `inverse-pair exposure: ${inverseSymbol} position (qty ${inversePos.qty}) blocks BUY ${symbol}`,
        )
      }
    }
  }

  // 4. halt / stale quote (BUY only)。SELL は stale でも exit 実行を優先する
  //    (stop hit / 損切りが stale quote で永久に block されないように)。
  //    lastQuote=null は未 seed 扱いで skip (POC 後方互換)。
  if (side === 'BUY' && state.lastQuote) {
    const ageMs = now.getTime() - new Date(state.lastQuote.fetchedAt).getTime()
    if (!Number.isFinite(ageMs) || ageMs > config.staleQuoteMs) {
      return reject(
        `halt or stale quote: lastQuote ${state.lastQuote.fetchedAt} exceeds staleQuoteMs ${config.staleQuoteMs}`,
      )
    }
  }

  // 5. spread guard (BUY only)。SELL/exit は wide spread でも実行優先。
  //    bid/ask 欠損は source 次第: Yahoo 等 bid/ask 非対応 source は適用外で通し、
  //    それ以外 (Webull 等) は fail-closed (issue #411 で恒久対応 = Webull bid/ask)。
  if (side === 'BUY') {
    const spreadReason = evaluateSpreadGate(symbol, state.lastQuote, config.spreadLimits)
    if (spreadReason !== null) {
      return reject(spreadReason)
    }
  }

  // 6. gap re-eval (BUY only)。SELL は大 gap (= stop hit) こそ fire させたい。
  //    open position が無い / avgPrice が不正なら skip。
  if (side === 'BUY') {
    const gapReason = evaluateGap(state, config.gapRejectPct)
    if (gapReason !== null) {
      return reject(gapReason)
    }
  }

  // 7. JP price band (BUY only)。SELL/exit は band 外でも通す。
  //    JP 銘柄かつ lastQuote 有りで limit が band 外なら reject。
  if (
    side === 'BUY' &&
    inferWebullMarket(symbol) === 'JP' &&
    state.lastQuote &&
    !isWithinJpPriceBand(state.lastQuote.price, intentPrice)
  ) {
    return reject(
      `JP price band: order price ${intentPrice} outside band for reference ${state.lastQuote.price}`,
    )
  }

  return APPROVED
}

function reject(reason: string): PerSymbolRiskDecision {
  return { approved: false, reasons: [reason] }
}

function evaluateSpreadGate(
  symbol: string,
  lastQuote: QuoteSnapshot | null,
  limits: { US: number; JP: number },
): string | null {
  if (lastQuote === null) return null
  const bid = lastQuote.bid
  const ask = lastQuote.ask
  if (bid === undefined || ask === undefined) {
    // 案A (issue #411): bid/ask を構造的に持たない source (Yahoo) では spread を
    // 適用外にして通す。それ以外 (Webull 等) の欠損は異常なので fail-closed 継続。
    if (QUOTE_SOURCES_WITHOUT_BID_ASK.has(lastQuote.source)) {
      // 安全弁を一段緩めるので observability に明示 (構造化ログ)。
      console.warn(
        JSON.stringify({
          event: 'spread_guard_skipped_no_bidask',
          symbol,
          source: lastQuote.source,
        }),
      )
      return null
    }
    return 'spread unknown, bid/ask missing'
  }
  const market = inferWebullMarket(symbol)
  const limit = market === 'JP' ? limits.JP : limits.US
  const spreadPct = computeSpreadPct(bid, ask)
  if (spreadPct === null) {
    return 'spread invalid: crossed book, non-finite, or non-positive bid/ask'
  }
  if (spreadPct > limit) {
    return `spread ${(spreadPct * 100).toFixed(3)}% exceeds ${market} limit ${(limit * 100).toFixed(3)}%`
  }
  return null
}

function evaluateGap(state: SymbolState, thresholdPct: number): string | null {
  const position = state.position
  const quote = state.lastQuote
  if (!position || !quote) return null
  if (!Number.isFinite(position.avgPrice) || position.avgPrice <= 0) return null
  const gap = (quote.price - position.avgPrice) / position.avgPrice
  if (Math.abs(gap) > thresholdPct) {
    return `gap re-eval: |${gap.toFixed(4)}| > ${thresholdPct} (avgPrice ${position.avgPrice} vs quote ${quote.price})`
  }
  return null
}
