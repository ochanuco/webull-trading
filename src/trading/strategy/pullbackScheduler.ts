import type { BarClient, IntradayBar } from '../../infrastructure/quotes/BarClient'
import { logPostSubmit, logPreSubmit } from '../../infrastructure/logger/tradeJournal'
import { classifyBrokerErrorCause } from '../../infrastructure/notification/brokerErrorSurge'
import type { Notifier } from '../../infrastructure/notification/Notifier'
import { BrokerRequestError, isSellQtyExceedError, isTickerDenyError } from '../../shared/errors'
import type { DecisionTraceStep } from '../domain/Signal'
import type { StrategyDecision } from '../domain/StrategyDecision'
import { inferTradingMarket, isWithinUsCloseWindow } from '../domain/tradingCalendar'
import { NO_TRADE_COST, netRealizedPnl, type TradeCostConfig } from '../domain/tradingCost'
import type { AtrBaselineMode } from './indicators'
import type { Execution } from '../execution/Execution'
import type { PositionStore } from '../state/PositionStore'
import type { SymbolState } from '../state/types'
import { freshDecisionQuote } from '../quotes/decisionQuote'
import {
  computeHoldBusinessDays,
  computePullbackIndicators,
  type DailyBar,
} from './indicators'
import { computePullbackSizing } from './pullbackSizing'
import type { BuyingPowerLedger } from './buyingPower'
import type { ExposureLedger } from './exposureLedger'

/** US 引け前何分から強制クローズ window を開けるか。5分 cron で必ず1 tick は窓内に入る幅。 */
const INTRADAY_CLOSE_WINDOW_MIN = 15
/**
 * 新規 BUY を止める引け前 window (`INTRADAY_CLOSE_WINDOW_MIN` より広く取る)。
 * force-close window に飲み込まれる直前の BUY は、その場で往復コストだけ
 * 発生させて閉じられるか、次 tick まで持ち越されてオーバーナイトになる。
 */
const INTRADAY_NO_ENTRY_WINDOW_MIN = 30
/**
 * intraday bar 鮮度ゲートの default 上限 (ms)。60m bar の timestamp は足の
 * 始値時刻なので、正常系でも取得時刻との差は最大60分 — provider 遅延分の
 * 余裕を足して 2h (60分ちょうどだと正常な bar まで reject する)。
 */
const DEFAULT_INTRADAY_BAR_MAX_AGE_MS = 2 * 60 * 60 * 1000
import type { ExecutionResult } from '../domain/ExecutionResult'
import type { OrderIntent } from '../domain/OrderIntent'
import { BreakoutMomentumStrategy } from './strategies/BreakoutMomentumStrategy'
import {
  PullbackUptrendStrategy,
  TEST_DEFAULT_RULE,
  type SymbolRule,
} from './strategies/PullbackUptrendStrategy'
import { evaluateEarningsGate } from '../risk/earningsGate'
import {
  DEFAULT_MACRO_GATE_CONFIG,
  evaluateMacroEventGate,
  type MacroEventGateConfig,
} from '../risk/macroEventGate'
import type { VixRegimeFilterDecision } from '../risk/vixRegimeFilter'
import type { NewsShockGateDecision } from '../risk/newsShockGate'
import type { ExtendedHoursGateDecision } from '../risk/extendedHoursGate'
import type { EarningsCalendarRepo } from '../../infrastructure/calendar/earningsCalendarRepo'
import type { MacroEventCalendarRepo } from '../../infrastructure/calendar/macroEventCalendarRepo'
import { evaluatePerSymbolRisk } from '../risk/perSymbolRiskGate'
import { deriveEntryStatusFromIndicators, type EntryStatus } from './entryStatus'
import {
  evaluatePairRegime,
  type PairRegimeDecision,
  type PairRegimeEntry,
  type PairRegimeThresholds,
} from './pairRegime'
import type { EntrySnapshot } from './conditionalAllocation'

const DEFAULT_BAR_LOOKBACK = 60

export interface PullbackSchedulerOptions {
  symbols: string[]
  /** Risk-% sizing の母数となる口座資産。未指定は `capital-unset` で fail-closed。budget-alloc 銘柄は未使用。 */
  equity?: number
  barClient: BarClient
  positionStore: PositionStore
  execution: Execution
  strategy?: PullbackUptrendStrategy
  /**
   * Default rule used when neither `strategy` nor a per-symbol `rulesMap`
   * entry applies. Production path (runStrategyCron) loads this from
   * global_config in D1; tests can pass TEST_DEFAULT_RULE or a custom one.
   */
  defaultRule?: SymbolRule
  rulesMap?: Record<string, SymbolRule>
  /**
   * role==='momentum' の symbol 集合。該当 symbol は `momentumStrategy` で
   * 判定するが、以降の Risk→Execution は通常 BUY/SELL と同じ経路を通る。
   */
  momentumSymbols?: Set<string>
  /** momentum symbol 用の戦略。未指定なら momentum symbol も押し目戦略で判定する。 */
  momentumStrategy?: BreakoutMomentumStrategy
  symbolCapMap?: Record<string, number>
  /**
   * `global_config.max_order_notional_usd/jpy`。銘柄別 `symbolCapMap` とは
   * min で合成する global な 1 注文あたりの上限。未設定なら無制限。個別銘柄
   * cap だけに頼ると、それを外し忘れたときに想定外の巨大 notional が通る。
   */
  maxOrderNotional?: number
  barLookback?: number
  riskPerTradePct?: number
  pendingLockTtlMs?: number
  /** @deprecated Run 単位の一律 lot、test 用の後方互換のみ残置。production は `symbolLotSizeMap` を使う。 */
  lotSize?: number
  /**
   * symbol → lot_size (integer >= 1)。`lotSize` より優先。この map を渡した
   * 時点で lot 必須モードになり、該当 symbol が無い BUY は fail-closed
   * (blanket default に倒さない)。map も `lotSize` も渡さない legacy caller
   * のみ lot=1 に倒す。
   */
  symbolLotSizeMap?: Record<string, number>
  /** symbol → budget_alloc_pct (0<pct<=1)。指定 symbol は口座(円)単一プールに対する割合の fixed-% sizing に切替わる。未指定は risk-% sizing。 */
  symbolBudgetAllocPctMap?: Record<string, number>
  /**
   * 予算配分の基準額 = 口座総額 (円、`total_capital_jpy`)。budget 銘柄の sizing 基準。
   */
  budgetBasisJpy?: number
  /**
   * この run の symbol 通貨 1 単位 = 何円か (JPY run=1、USD run=USD/JPY レート)。
   * USD で FX 取得失敗時は undefined を渡し、budget 銘柄を fail-closed させる。
   */
  fxJpyPerSymbolCcy?: number
  /**
   * 口座買付余力の共有プール台帳。指定時、BUY submit 直前に notional を JPY
   * 換算して `tryReserve` し、超過/unavailable は pre-trade で reject する
   * (Webull 417 のローカル先回り)。USD/JPY runs をまたいで同一 ledger を共有
   * する想定。未指定はゲート無効。
   */
  buyingPower?: BuyingPowerLedger
  /**
   * `global_config.max_portfolio_exposure_pct` の共有台帳。`buyingPower` と
   * 同じ設計 (runs/passes をまたいで同一 ledger を共有し逐次減算)。未指定は
   * ゲート無効。
   */
  exposureCap?: ExposureLedger
  /**
   * intraday-only 銘柄の集合。US 引け前 window 内で保有があれば strategy 判定を
   * 上書きして強制 SELL する (レバ ETF の寄りギャップ stop-out 回避)。未指定/
   * 対象外はスイング保有。
   */
  intradayOnlySymbols?: Set<string>
  /**
   * Per-symbol decision sink。HOLD / BUY / SELL / SKIP / REJECT / ERROR の各
   * route で 1 回ずつ呼ばれる。sink が throw しても scheduler は止めない
   * (logging failure isolation)。
   */
  onDecision?: (record: {
    symbol: string
    decision: StrategyDecision
    reason?: string
    price?: number
    indicatorsJson?: string
    /** BUY/SELL 成立時のみ設定。dashboard が trade_journal と JOIN する key。 */
    clientOrderId?: string
    trace?: DecisionTraceStep[]
  }) => Promise<void> | void
  /** cron fire 単位の correlation id。emit 失敗時の構造化ログに含めて「どの run で落ちたか」を tail から追えるようにする。 */
  requestId?: string
  /**
   * Slack/Discord webhook 通知用 sink。BUY/SELL emit 時と cron error 時に
   * fire-and-forget で叩く。失敗を握りつぶす責務は実装側にあるので、scheduler
   * 側は `.catch()` を付けるだけで cron を blocking しない。
   */
  notifier?: Notifier
  /**
   * Per-symbol risk gate config (TradingService と同じ pure function を使う)。
   * deps が全て有効なら gate 適用、1つでも欠けると skip (未指定 caller の挙動を保つ)。
   */
  perSymbolRisk?: PerSymbolRiskScheduleConfig
  /**
   * SELL submit が Webull の SELL_QTY_EXCEED (417) で reject された時、broker
   * 側の実 available qty で再 submit するための resolver。throw / null 返却は
   * どちらも元エラーを再 throw させる (fail-closed)。未注入なら fallback skip。
   * getAvailableQty と SELL submit の間で broker 側が動く race は許容 — 連続
   * reject は次 tick で再評価される。
   */
  sellFallback?: SellFallbackConfig
  /** Earnings calendar gate。±N 営業日で BUY を凍結。`repo` 未注入なら skip。 */
  earningsGate?: EarningsScheduleConfig
  /**
   * FOMC/CPI/NFP 等の発表 ±N 時間で全銘柄 BUY を凍結。`repo` 未注入なら skip。
   * earnings gate より後で評価する (両方 reject なら earnings reason が先に確定)。
   */
  macroEventGate?: MacroEventScheduleConfig
  /**
   * VIX regime filter decision。caller が cron tick 起動時に `evaluateVixRegime`
   * を呼んで作る:
   *   - sizeScale === 0 (critical): BUY 全 reject
   *   - 0 < sizeScale < 1 (warning): qty を sizeScale 倍に縮小
   *   - sizeScale === 1: no-op
   * 未注入なら skip。SELL は VIX 関係なく通す。
   */
  vixDecision?: VixRegimeFilterDecision
  /**
   * News shock gate decision。`mode`:
   *   - 'enforce': VIX と同じ scaling を適用し、乗算チェーンで合成する
   *     (vixScale 適用後の qty に news scale を重ねる)。
   *   - 'observe': qty は変えず trace にだけ reason を残す (shadow mode)。
   * 未注入なら skip。SELL は news shock 関係なく通す。
   */
  newsShockGate?: {
    mode: 'observe' | 'enforce'
    decision: NewsShockGateDecision
  }
  /**
   * Extended-hours (pre-market) gate。symbol (大文字) → decision の Map。VIX /
   * news shock と異なり symbol ごとの decision で、Map に無い symbol は no-op。
   * `mode`:
   *   - 'enforce': `block_entry` で BUY 全 reject / `reduce_entry` で qty を
   *     multiplier 倍に縮小 (VIX/news shock と同じ乗算チェーンの最後に適用)。
   *   - 'observe': qty は変えず trace にだけ reason を残す。
   * 未注入/対象 symbol の decision なしなら skip。SELL は対象外。
   */
  extendedHoursGate?: {
    mode: 'observe' | 'enforce'
    decisions: Map<string, ExtendedHoursGateDecision>
  }
  /**
   * Entry 抑止 symbol → 理由。role が entry 無効な銘柄の BUY を SKIP する。
   * SELL/HOLD は対象外 (exit 経路を妨げない)。未注入なら skip。
   */
  entrySuppressedSymbols?: Record<string, string>
  /** 売買コスト見積り。TRADE 通知の realized PnL を net 化する。未注入なら 0 (gross)。`reconcileFills` も同じ設定で計算する。 */
  tradeCost?: TradeCostConfig
  /** baseline ATR の作り方。未注入は 'percentile' (実測で最良)。 */
  atrBaselineMode?: AtrBaselineMode
  /**
   * ペアレジーム layer。'observe' は zone/score を trace に残すだけ (gate しない)、
   * 'enforce' は zone が許可しない側の BUY を SKIP し、保有と反対 zone への flip
   * で SELL (regime_flip) を出す。未注入なら従来挙動。
   */
  pairRegime?: {
    mode: 'observe' | 'enforce'
    thresholds: PairRegimeThresholds
    pairs: PairRegimeEntry[]
  }
  /**
   * 段階判定 HALF (0.5x entry) を有効にする symbol 集合。role が entry 有効な
   * 銘柄のみ想定。未注入/集合外は従来の二値挙動 (HALF なし)。
   */
  halfEntrySymbols?: Set<string>
  /**
   * 条件連動配分の cash rebalance 数量。指定 symbol は pullback 戦略判定と
   * sizing を bypass して固定数量の BUY intent を作るが、下流の gate (lot
   * fail-closed / per-symbol risk / buying-power / pending lock / DRY_RUN) は
   * 全部通る。未注入なら従来挙動。
   */
  cashRebalanceQuantityMap?: Record<string, number>
  /**
   * 条件連動配分の cash rebalance 部分 SELL 数量。strategy の SELL signal が
   * 無い時だけ、この数量 (position.qty にクランプ済み) で部分 SELL intent を
   * 作る — 全量 close ではない点が `cashRebalanceQuantityMap` (BUY) との違い。
   * strategy 自身が SELL を出していればそちらを優先し、この map は無視する。
   * 未注入なら従来挙動。
   */
  cashRebalanceSellQuantityMap?: Record<string, number>
  /**
   * TICKER_IS_DENY 自動停止 hook。BUY submit が Webull の銘柄単位の恒久拒否で
   * 失敗したとき、該当 symbol を引数に 1 回呼ばれる。hook 内の失敗は hook 側で
   * 握りつぶす契約 (scheduler は await するだけ)。SELL では呼ばない — exit 側
   * で deny が出ても銘柄を対象外にすると保有が orphan になるため。
   */
  onTickerDeny?: (symbol: string) => Promise<void>
  /**
   * sanity_failed cooldown gate。直近 N 分以内に同 symbol で broker stub fill
   * (`resolveFilledPrice` が ratio guard で reject した) が観測されていた場合、
   * 新規 BUY を block する fail-closed gate。未注入なら skip。SELL は対象外
   * (broker stub では起きない、exit 経路を妨げないため)。
   */
  sanityFailedCooldown?: SanityFailedCooldownConfig
  /**
   * intraday 60m bar の最大許容鮮度 (ms)。`barClient.getIntradayBars` を実装
   * した client でのみ評価する (未実装 client は無 gate)。bar の timestamp は
   * 足の始値時刻なので、最新足は常に取得時刻との差が60分以内になる — default
   * 2h はそこに provider 遅延分の余裕を足した値。SELL には適用しない。
   */
  intradayBarMaxAgeMs?: number
  now?: () => Date
}

interface SanityFailedCooldownConfig {
  /** `symbol` (大文字) について直近 `withinMs` 内の sanity_failed row 有無を返す predicate。throw は fail-closed (cooldown 有効扱い)。 */
  check: (symbol: string) => Promise<boolean>
  /** Operator 視認用の窓幅 (ms)。reject reason 文字列に埋め込むだけ — 実際の cutoff は `check` 実装側が持つ。 */
  withinMs: number
}

/**
 * Resolver for the SELL_QTY_EXCEED fallback. Returns the broker-side
 * `quantity_available` for the symbol (case-insensitive match), or `null`
 * if not held / not findable. Throwing here is treated the same as `null`
 * — the fallback is best-effort and never converts a SELL reject into a
 * different reject (the original SELL_QTY_EXCEED error is re-thrown).
 */
interface SellFallbackConfig {
  getAvailableQty: (symbol: string) => Promise<number | null>
}

interface EarningsScheduleConfig {
  repo: EarningsCalendarRepo
  /** ±N 営業日。default 1。 */
  freezeBusinessDays?: number
}

interface MacroEventScheduleConfig {
  repo: MacroEventCalendarRepo
  /** Partial で渡せて、未指定 field は `DEFAULT_MACRO_GATE_CONFIG` (発表前1h/発表後6h/full-day=true) で補う。 */
  config?: Partial<MacroEventGateConfig>
}

interface PerSymbolRiskScheduleConfig {
  /** BUY symbol → inverse symbol map (大文字 key)。 */
  inversePairs: Record<string, string>
  spreadLimits: { US: number; JP: number }
  staleQuoteMs: number
  gapRejectPct: number
}

export interface PullbackRunSummary {
  evaluated: number
  buys: number
  sells: number
  holds: number
  rejected: Array<{ symbol: string; reason: string }>
  errors: Array<{ symbol: string; message: string }>
  /** strategy_decision_log をミラーする per-symbol JSON record。散らばったログ行から再構成せず 1 run を分析できる。 */
  decisions: PullbackDecisionTrace[]
  /**
   * 条件連動配分用の per-symbol 観測値。評価が成立した symbol のみ (bars 不足
   * / ERROR は不在、下流が fail-closed に扱う)。runStrategyCron の allocation
   * 計算に渡す。
   */
  entrySnapshots: Record<string, EntrySnapshot>
  /** この run に適用された VIX regime filter decision。`vixDecision` option を渡された時のみ set される。 */
  vix?: VixRegimeFilterDecision
  /** この run に適用された news shock gate decision。`newsShockGate` option を渡された時のみ set される。 */
  newsShock?: NewsShockGateDecision
}

export interface PullbackDecisionTrace {
  symbol: string
  decision: StrategyDecision
  reason?: string
  price?: number
  indicatorsJson?: string
  trace?: DecisionTraceStep[]
  clientOrderId?: string | null
  order?: {
    side: 'BUY' | 'SELL'
    quantity: number
    notional: number
  }
}

/**
 * Drives PullbackUptrendStrategy across the ALLOWED_SYMBOLS universe on a
 * daily cadence: pulls daily bars, computes indicators, reads DO state,
 * resolves quantity via `computePullbackSizing`, then submits through the
 * provided {@link Execution}. The scheduler itself is transport-agnostic —
 * {@link src/index.ts} wires it to a Workers cron trigger.
 */
export async function runPullbackScheduler(
  options: PullbackSchedulerOptions,
): Promise<PullbackRunSummary> {
  const now = options.now ?? (() => new Date())
  const lookback = options.barLookback ?? DEFAULT_BAR_LOOKBACK
  // client capability (per-symbol ではなく実行全体で1回だけ決まる)。未対応 client は無 gate。
  const intradayAttempted = typeof options.barClient.getIntradayBars === 'function'
  const intradayBarMaxAgeMs = options.intradayBarMaxAgeMs ?? DEFAULT_INTRADAY_BAR_MAX_AGE_MS
  const strategy =
    options.strategy ??
    new PullbackUptrendStrategy(options.defaultRule ?? TEST_DEFAULT_RULE, options.rulesMap ?? {})
  const pendingLockTtlMs = options.pendingLockTtlMs ?? 60_000
  if (typeof pendingLockTtlMs !== 'number' || !Number.isFinite(pendingLockTtlMs) || pendingLockTtlMs <= 0) {
    throw new Error(`pendingLockTtlMs must be a finite positive number, got: ${pendingLockTtlMs}`)
  }

  const summary: PullbackRunSummary = {
    evaluated: 0,
    buys: 0,
    sells: 0,
    holds: 0,
    rejected: [],
    errors: [],
    decisions: [],
    entrySnapshots: {},
    ...(options.vixDecision !== undefined ? { vix: options.vixDecision } : {}),
    ...(options.newsShockGate !== undefined ? { newsShock: options.newsShockGate.decision } : {}),
  }

  // fire-and-forget。Notifier 実装側の silent fallback を信頼しつつ、二重 catch で cron を絶対に落とさない。
  const emitNotify = (event: Parameters<NonNullable<typeof options.notifier>['notify']>[0]): void => {
    if (!options.notifier) return
    try {
      const p = options.notifier.notify(event)
      if (p && typeof (p as Promise<unknown>).catch === 'function') {
        ;(p as Promise<unknown>).catch((err) => {
          console.warn(
            JSON.stringify({
              event: 'notifier_emit_failed',
              requestId: options.requestId ?? null,
              message: err instanceof Error ? err.message : String(err),
            }),
          )
        })
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: 'notifier_emit_failed',
          requestId: options.requestId ?? null,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  // Logging helper: sink が投げても本体を落とさない (logging failure isolation)。
  const emitDecision = async (
    record: Parameters<NonNullable<typeof options.onDecision>>[0] & {
      order?: PullbackDecisionTrace['order']
    },
  ): Promise<void> => {
    summary.decisions.push({
      symbol: record.symbol,
      decision: record.decision,
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
      ...(record.price !== undefined ? { price: record.price } : {}),
      ...(record.indicatorsJson !== undefined ? { indicatorsJson: record.indicatorsJson } : {}),
      ...(record.trace !== undefined ? { trace: record.trace } : {}),
      ...(record.clientOrderId !== undefined ? { clientOrderId: record.clientOrderId } : {}),
      ...(record.order !== undefined ? { order: record.order } : {}),
    })
    if (!options.onDecision) return
    try {
      const { order: _order, ...dbRecord } = record
      await options.onDecision(dbRecord)
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'on_decision_sink_failed',
          requestId: options.requestId ?? null,
          symbol: record.symbol,
          decision: record.decision,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  // ペア単位で proxy bars を fetch して zone を決め、symbol → {decision, side}
  // に展開する。fetch/評価の失敗はペア単位で unknown に隔離する (enforce では
  // 両側 BUY block) — cron は落とさない。
  const regimeBySymbol = new Map<
    string,
    { decision: PairRegimeDecision; side: 'bull' | 'bear' }
  >()
  if (options.pairRegime) {
    const runSymbols = new Set(options.symbols.map((s) => s.toUpperCase()))
    const relevant = options.pairRegime.pairs.filter(
      (p) => runSymbols.has(p.bullSymbol) || runSymbols.has(p.bearSymbol),
    )
    // 評価は並列、Map への反映は評価完了後に設定順で決定的に行う (async 完了順の
    // set だと重複 symbol の勝敗が run ごとに揺れる)。
    const evaluated = await Promise.all(
      relevant.map(async (pair) => {
        let decision: PairRegimeDecision
        if (pair.invalidConfig !== null) {
          decision = {
            zone: 'unknown',
            score: null,
            proxySymbol: pair.proxySymbol,
            asOfDate: null,
            reason: `misconfig: ${pair.invalidConfig}`,
          }
        } else {
          try {
            const proxyBars = await options.barClient.getDailyBars(pair.proxySymbol, 80)
            decision = evaluatePairRegime(proxyBars, {
              proxySymbol: pair.proxySymbol,
              thresholds: options.pairRegime!.thresholds,
              now: now(),
            })
          } catch (err) {
            decision = {
              zone: 'unknown',
              score: null,
              proxySymbol: pair.proxySymbol,
              asOfDate: null,
              reason: `proxy bars fetch failed: ${messageOf(err)}`,
            }
          }
        }
        return { pair, decision }
      }),
    )
    for (const { pair, decision } of evaluated) {
      // 同一 symbol が複数ペアに現れる重複設定は判定不能 → unknown (fail-closed)。
      const duplicate = [pair.bullSymbol, pair.bearSymbol].find((sym) => regimeBySymbol.has(sym))
      if (duplicate !== undefined) {
        const dup: PairRegimeDecision = {
          zone: 'unknown',
          score: null,
          proxySymbol: pair.proxySymbol,
          asOfDate: null,
          reason: `duplicate pair config for ${duplicate} (fail-closed)`,
        }
        regimeBySymbol.set(pair.bullSymbol, { decision: dup, side: 'bull' })
        regimeBySymbol.set(pair.bearSymbol, { decision: dup, side: 'bear' })
        const prev = regimeBySymbol.get(duplicate)!
        regimeBySymbol.set(duplicate, { decision: dup, side: prev.side })
      } else {
        regimeBySymbol.set(pair.bullSymbol, { decision, side: 'bull' })
        regimeBySymbol.set(pair.bearSymbol, { decision, side: 'bear' })
      }
      console.warn(
        JSON.stringify({
          event: 'pair_regime_evaluated',
          requestId: options.requestId ?? null,
          mode: options.pairRegime!.mode,
          pair: `${pair.bullSymbol}/${pair.bearSymbol}`,
          proxySymbol: decision.proxySymbol,
          zone: regimeBySymbol.get(pair.bullSymbol)!.decision.zone,
          score: decision.score,
          asOfDate: decision.asOfDate,
          reason: regimeBySymbol.get(pair.bullSymbol)!.decision.reason,
        }),
      )
    }
  }

  // state read 失敗は 0 (flat) にフェイルセーフする — 二重障害を新規分岐で拡大しない。
  const heldQtyOrZero = async (symbol: string): Promise<number> => {
    try {
      const state = await options.positionStore.getState(symbol)
      return state.position !== null && Number.isFinite(state.position.qty) && state.position.qty > 0
        ? state.position.qty
        : 0
    } catch {
      return 0
    }
  }

  for (const symbol of options.symbols) {
    summary.evaluated += 1
    const upper = symbol.toUpperCase()
    let bars: DailyBar[]
    let intradayPrice: number | null = null
    let lastIntradayBar: IntradayBar | null = null
    try {
      // intraday 失敗は null fallback (daily close 採用)。daily は 1 回だけ
      // retry する — それでも失敗すれば held position の exit 判定ごと飛ぶ致命
      // なので throw のまま。
      const intradayP = options.barClient.getIntradayBars
        ? options.barClient.getIntradayBars(symbol, '60m').catch(() => [])
        : Promise.resolve([])
      const dailyBars = await fetchDailyBarsWithRetry(options.barClient, symbol, lookback)
      const intradayBars = await intradayP
      bars = dailyBars
      // chart UI も同じ intraday endpoint を見ているので BUY pin と candle がズレない。
      const lastIntraday = intradayBars[intradayBars.length - 1]
      lastIntradayBar = lastIntraday ?? null
      intradayPrice = lastIntraday ? lastIntraday.close : null
    } catch (error) {
      // 保有中は「exit 判定が飛んだ」ことを reason + notifier cause で明示する
      // (SELL の degrade は絶対にしない)。flat は従来どおり ERROR のみ。
      const bareMessage = messageOf(error)
      const decisionReason = `bar fetch: ${bareMessage}`
      const heldQty = await heldQtyOrZero(upper)
      if (heldQty > 0) {
        const message = `exit evaluation unavailable while holding ${heldQty}: ${decisionReason}`
        summary.errors.push({ symbol: upper, message })
        await emitDecision({ symbol: upper, decision: 'ERROR', reason: message })
        emitNotify({ type: 'ERROR', symbol: upper, message, cause: 'exit_unavailable_while_holding' })
      } else {
        summary.errors.push({ symbol: upper, message: bareMessage })
        await emitDecision({ symbol: upper, decision: 'ERROR', reason: decisionReason })
        emitNotify({ type: 'ERROR', symbol: upper, message: bareMessage, cause: 'bar fetch' })
      }
      continue
    }

    const state = await options.positionStore.getState(upper)
    const decisionQuote = freshDecisionQuote(upper, state.lastQuote, now())
    const indicators = computePullbackIndicators(bars, decisionQuote?.price ?? intradayPrice, {
      baselineMode: options.atrBaselineMode ?? 'percentile',
    })
    if (!indicators) {
      // bar fetch throw 分岐と同じ扱い。
      const baseReason = 'insufficient bars for indicators'
      const heldQty = await heldQtyOrZero(upper)
      if (heldQty > 0) {
        const message = `exit evaluation unavailable while holding ${heldQty}: ${baseReason}`
        summary.errors.push({ symbol: upper, message })
        await emitDecision({ symbol: upper, decision: 'ERROR', reason: message })
        emitNotify({ type: 'ERROR', symbol: upper, message, cause: 'exit_unavailable_while_holding' })
      } else {
        summary.rejected.push({ symbol: upper, reason: baseReason })
        await emitDecision({ symbol: upper, decision: 'SKIP', reason: baseReason })
      }
      continue
    }

    const market = inferTradingMarket(upper)
    const holdBusinessDays =
      state.position !== null
        ? computeHoldBusinessDays(state.position.openedAt, now(), market)
        : 0

    // 条件連動配分用の観測値。判定そのものには使わず、runStrategyCron が run 後に
    // target/active weight を計算する材料。
    summary.entrySnapshots[upper] = {
      status: deriveEntryStatusFromIndicators(indicators, strategy.resolveRule(upper)).status,
      price: indicators.price,
      heldQty:
        state.position !== null && Number.isFinite(state.position.qty) && state.position.qty > 0
          ? state.position.qty
          : 0,
    }

    const useMomentum = !!(options.momentumStrategy && options.momentumSymbols?.has(upper))
    const decider = useMomentum ? options.momentumStrategy! : strategy
    // flat のときだけ前回手仕舞い情報を渡す。lastExecutedPrice への fallback は
    // 意図的に入れない — overridePosition (broker 側清算) は position だけ
    // null 化するため、「flat なら直近 fill は SELL」という推論が壊れ、古い BUY
    // 価格がガード基準に残り得る。lastExitPrice は SELL close でのみ刻まれる
    // 専用フィールドなのでそれを直接使う。lastExitAt はあるが lastExitPrice が
    // 無い旧 state は entryDecision 側が fail-closed する。
    const reentryLastExitPrice = state.position === null ? state.lastExitPrice : null
    const reentryBusinessDaysSinceExit =
      state.position === null && state.lastExitAt
        ? computeHoldBusinessDays(state.lastExitAt, now(), market)
        : null
    let signal = decider.decide({
      symbol: upper,
      indicators,
      position: state.position,
      pendingOrder: state.pendingOrder,
      cooldownUntil: state.cooldownUntil,
      holdBusinessDays,
      lastExitPrice: reentryLastExitPrice,
      businessDaysSinceExit: reentryBusinessDaysSinceExit,
      now: now(),
    })

    // 判断価格の出所・時刻を全 decision の trace 先頭に残す (SKIP/HOLD/ERROR
    // 含む)。stale price 調査時に「どの bar を見て判断したか」を trace だけで追える。
    const priceAsOfSource = decisionQuote !== null ? decisionQuote.source
      : lastIntradayBar !== null ? 'intraday_60m' : 'daily_close'
    const priceAsOfValue =
      decisionQuote?.asOf ?? (lastIntradayBar !== null ? lastIntradayBar.timestamp : (bars[bars.length - 1]?.date ?? 'unknown'))
    signal = {
      ...signal,
      trace: [
        traceStep(
          'data.price_as_of',
          true,
          undefined,
          undefined,
          undefined,
          `${priceAsOfSource}:${priceAsOfValue}`,
        ),
        ...(signal.trace ?? []),
      ],
    }

    // intraday bar 対応 client で鮮度が確認できない BUY 判断価格は SKIP する
    // (SELL は対象外、fail-closed を entry 側だけに閉じる)。timestamp が
    // parse 不能なケースは明示チェックする — Date.parse の NaN を素通しで
    // 比較すると常に false になり鮮度チェックが無効化される。
    let priceFreshnessFailure: string | null = null
    if (intradayAttempted && decisionQuote === null) {
      if (lastIntradayBar === null) {
        priceFreshnessFailure =
          'stale price: intraday bar unavailable, daily close fallback not accepted for BUY'
      } else {
        const asOfMs = Date.parse(lastIntradayBar.timestamp)
        const ageMs = now().getTime() - asOfMs
        if (!Number.isFinite(asOfMs) || ageMs < 0 || ageMs > intradayBarMaxAgeMs) {
          priceFreshnessFailure = `stale price: intraday_60m as of ${lastIntradayBar.timestamp} exceeds ${intradayBarMaxAgeMs}ms`
        }
      }
    }

    // 指定数量の BUY に置き換える。pending order 中は strategy の HOLD
    // (pending guard) をそのまま残す。strategy exit (SELL) / cooldown /
    // re-entry guard は迂回させない — これを外すと time-stop 等で SELL した
    // 直後に同ティックで cash rebalance が買い戻す whipsaw が起きる。
    const cashRebalanceQty = options.cashRebalanceQuantityMap?.[upper]
    if (cashRebalanceQty !== undefined && state.pendingOrder === null) {
      if (Number.isInteger(cashRebalanceQty) && cashRebalanceQty > 0) {
        const cooldownUntilMs = state.cooldownUntil ? new Date(state.cooldownUntil).getTime() : NaN
        const cooldownActive = Number.isFinite(cooldownUntilMs) && cooldownUntilMs > now().getTime()
        const guardDays = strategy.resolveRule(upper).reentryGuardBusinessDays
        const reentryGuardActive =
          state.position === null &&
          state.lastExitAt !== null &&
          Number.isFinite(guardDays) &&
          guardDays > 0 &&
          reentryBusinessDaysSinceExit !== null &&
          reentryBusinessDaysSinceExit < guardDays

        let skipWhy: string | null = null
        if (signal.action === 'SELL') {
          skipWhy = 'strategy exit takes precedence'
        } else if (cooldownActive) {
          skipWhy = `cooldown active until ${state.cooldownUntil}`
        } else if (reentryGuardActive) {
          skipWhy = `re-entry guard window (${reentryBusinessDaysSinceExit}bd < ${guardDays}bd since exit)`
        }

        if (skipWhy !== null) {
          signal = {
            ...signal,
            reason: `${signal.reason}; cash rebalance skipped: ${skipWhy}`,
            trace: appendTrace(
              signal.trace,
              traceStep('entry.cash_rebalance', false, cashRebalanceQty, '>', 0, skipWhy),
            ),
          }
        } else {
          signal = {
            ...signal,
            action: 'BUY',
            quantity: cashRebalanceQty,
            reason: `cash allocation rebalance: buy ${cashRebalanceQty} toward active weight (#452)`,
            trace: appendTrace(
              signal.trace,
              traceStep('entry.cash_rebalance', true, cashRebalanceQty, '>', 0, 'conditional allocation cash rebalance (#452)'),
            ),
          }
        }
      }
    }

    // 退避先の active weight 超過分を部分 SELL に置き換える。強制全量 close
    // ではない — 全量 close は下の intraday-only / regime-flip や通常の
    // stop/TP/time-stop に譲る。それらが既に action='SELL' を出していれば
    // 上書きしない (strategy exit / 強制クローズが優先、二重に売らない)。
    let cashRebalancePartialSell = false
    const cashRebalanceSellQty = options.cashRebalanceSellQuantityMap?.[upper]
    if (
      cashRebalanceSellQty !== undefined &&
      state.pendingOrder === null &&
      Number.isInteger(cashRebalanceSellQty) &&
      cashRebalanceSellQty > 0
    ) {
      if (signal.action === 'SELL') {
        signal = {
          ...signal,
          trace: appendTrace(
            signal.trace,
            traceStep('exit.cash_rebalance', false, cashRebalanceSellQty, '>', 0, 'strategy exit takes precedence'),
          ),
        }
      } else if (state.position === null || state.position.qty <= 0) {
        signal = {
          ...signal,
          trace: appendTrace(
            signal.trace,
            traceStep('exit.cash_rebalance', false, cashRebalanceSellQty, '>', 0, 'no position'),
          ),
        }
      } else {
        const qty = Math.min(cashRebalanceSellQty, state.position.qty)
        signal = {
          ...signal,
          action: 'SELL',
          quantity: qty,
          reason: `cash allocation rebalance: sell ${qty} toward active weight (#452)`,
          trace: appendTrace(
            signal.trace,
            traceStep('exit.cash_rebalance', true, qty, '>', 0, 'conditional allocation cash rebalance sell (#452)'),
          ),
        }
        cashRebalancePartialSell = true
      }
    }

    // レバ ETF 等は US 引け前 window で保有があれば strategy 判定を上書きして
    // 強制 SELL する (寄りギャップ stop-out 回避)。US 銘柄のみ対象。
    if (
      options.intradayOnlySymbols?.has(upper) &&
      market === 'US' &&
      state.position !== null &&
      Number.isFinite(state.position.qty) &&
      state.position.qty > 0 &&
      isWithinUsCloseWindow(now(), INTRADAY_CLOSE_WINDOW_MIN)
    ) {
      // cash rebalance が直前に部分 SELL を仕込んでいても、intraday-only の
      // 強制クローズは全量優先 — フラグを落とし、下流の intent 組み立てで
      // position.qty (全量) を使わせる。
      cashRebalancePartialSell = false
      signal = {
        ...signal,
        action: 'SELL',
        reason: 'intraday-only: force-close before US market close',
        trace: appendTrace(
          signal.trace,
          traceStep('exit.intraday_close', true, undefined, undefined, undefined, 'force-close before US close'),
        ),
      }
    }

    // zone/score を全評価の trace に残す (HOLD 含む — observe 期間の監査が
    // 目的なので BUY/SKIP 時だけでは足りない)。
    const regime = regimeBySymbol.get(upper)
    if (regime && options.pairRegime) {
      const d = regime.decision
      const allowed = (regime.side === 'bull' && d.zone === 'bull') || (regime.side === 'bear' && d.zone === 'bear')
      const held =
        state.position !== null && Number.isFinite(state.position.qty) && state.position.qty > 0
      const observeNote =
        options.pairRegime.mode === 'observe' && !allowed && signal.action === 'BUY'
          ? ' [observe: enforce なら SKIP]'
          : ''
      const neutralHoldNote =
        held && d.zone === 'neutral'
          ? ' [hold_existing_position: neutral_does_not_force_exit]'
          : ''
      signal = {
        ...signal,
        trace: appendTrace(
          signal.trace,
          traceStep(
            'regime.zone',
            allowed,
            d.score,
            undefined,
            undefined,
            `${d.reason} side=${regime.side} mode=${options.pairRegime.mode}${observeNote}${neutralHoldNote}`,
          ),
        ),
      }
      // 保有と反対 zone に flip したら全量 SELL。既存 exit (stop/TP/time-stop)
      // が先に SELL を出していればそれが優先で、副次理由として trace にだけ残す。
      // neutral では強制 exit しない (hysteresis 内の正常な押しで降ろさない)。
      const flipped =
        (regime.side === 'bull' && d.zone === 'bear') || (regime.side === 'bear' && d.zone === 'bull')
      if (options.pairRegime.mode === 'enforce' && held && flipped) {
        // regime flip は常に全量 close の意図。直前の cash rebalance 部分 SELL
        // が「既に SELL 済み」として素通りしないよう、フラグを落として下流に
        // position.qty (全量) を使わせる。
        cashRebalancePartialSell = false
        if (signal.action === 'SELL') {
          signal = {
            ...signal,
            trace: appendTrace(
              signal.trace,
              traceStep('exit.regime_flip_secondary', true, undefined, undefined, undefined, `secondaryExitReasons: regime_flip (${d.reason})`),
            ),
          }
        } else {
          signal = {
            ...signal,
            action: 'SELL',
            reason: `pair regime flip: zone=${d.zone} against held ${regime.side} side (${d.reason})`,
            trace: appendTrace(
              signal.trace,
              traceStep('exit.regime_flip', true, d.score, undefined, undefined, d.reason),
            ),
          }
        }
      }
    }

    // HOLD 理由を知らずに entry status を指標だけから再導出すると、re-entry
    // guard 由来の HOLD (ガードは 7 gate 集合に無い) まで HALF 昇格させてしまう。
    // strategy が申告する `holdCause` / `entryStatus` を scheduler は再計算せず
    // 使う (情報フローの一方向化) — HALF が緩めてよいのは setup の質を測る
    // entry gate だけで、holdCause !== 'entry_gate' なら絶対 veto。
    let positionMultiplier = 1
    const entryStatus = signal.entryStatus
    if (
      signal.action === 'HOLD' &&
      signal.holdCause === 'entry_gate' &&
      options.halfEntrySymbols?.has(upper) &&
      entryStatus?.status === 'HALF' &&
      entryStatus.halfGate !== null &&
      // holdCause==='entry_gate' の時点で保証済みの不変条件に対する
      // belt-and-suspenders アサーション (将来の strategy 実装ミスへの二次防御)。
      state.position === null &&
      state.pendingOrder === null &&
      !(state.cooldownUntil && new Date(state.cooldownUntil).getTime() > now().getTime())
    ) {
      const gate = entryStatus.halfGate
      positionMultiplier = entryStatus.positionMultiplier
      signal = {
        ...signal,
        action: 'BUY',
        reason: `half entry (0.5x): ${gate.key} ${gate.actual.toFixed(4)} near threshold ${gate.threshold} (within tolerance band)`,
        trace: appendTrace(
          signal.trace,
          traceStep(
            'entry.half_status',
            true,
            gate.actual,
            // DecisionTraceStep の operator union は '<=' / '>=' のみ。
            gate.operator === '>=' ? '>=' : '<=',
            gate.threshold,
            'HALF: single degree-gate miss within tolerance → 0.5x sizing (#452)',
          ),
        ),
      }
    }

    // force-close window に飲み込まれる直前 (30分) の新規 BUY も止める。HALF
    // 昇格ブロックより後に置くのが必須 — 前に置くと、まだ HOLD の signal.action
    // を見て veto が不発のまま通過し、直後の HALF 昇格が veto 済みの HOLD を
    // BUY へ戻してしまう。cash rebalance による BUY もここで最終判定を受ける。
    if (
      options.intradayOnlySymbols?.has(upper) &&
      market === 'US' &&
      signal.action === 'BUY' &&
      isWithinUsCloseWindow(now(), INTRADAY_NO_ENTRY_WINDOW_MIN)
    ) {
      signal = {
        ...signal,
        action: 'HOLD',
        holdCause: 'guard',
        reason: 'intraday-only: no new entry within 30min of US close',
        trace: appendTrace(
          signal.trace,
          traceStep(
            'entry.intraday_no_entry',
            false,
            undefined,
            undefined,
            undefined,
            'intraday-only: no new entry within 30min of US close',
          ),
        ),
      }
    }

    if (signal.action === 'HOLD') {
      summary.holds += 1
      await emitDecision({
        symbol: upper,
        decision: 'HOLD',
        reason: signal.reason,
        price: indicators.price,
        indicatorsJson: JSON.stringify(indicators),
        trace: signal.trace,
      })
      continue
    }

    // enforce のみ: zone が許可しない側の entry を SKIP。SELL / exit は妨げない。
    if (options.pairRegime?.mode === 'enforce' && signal.action === 'BUY') {
      const regimeGate = regimeBySymbol.get(upper)
      if (regimeGate) {
        const d = regimeGate.decision
        const allowed =
          (regimeGate.side === 'bull' && d.zone === 'bull') ||
          (regimeGate.side === 'bear' && d.zone === 'bear')
        if (!allowed) {
          const reason = `pair_regime: zone=${d.zone} blocks ${regimeGate.side} entry (${d.reason})`
          summary.rejected.push({ symbol: upper, reason })
          await emitDecision({
            symbol: upper,
            decision: 'SKIP',
            reason,
            price: indicators.price,
            indicatorsJson: JSON.stringify(indicators),
            trace: appendTrace(
              signal.trace,
              traceStep('risk.pair_regime', false, d.score, undefined, undefined, reason),
            ),
          })
          continue
        }
      }
    }

    // SELL は対象外 — role を後から変えた銘柄の保有 exit (stop / time-stop / TP) を妨げない。
    if (signal.action === 'BUY' && options.entrySuppressedSymbols?.[upper] !== undefined) {
      const reason = options.entrySuppressedSymbols[upper]
      summary.rejected.push({ symbol: upper, reason })
      await emitDecision({
        symbol: upper,
        decision: 'SKIP',
        reason,
        price: indicators.price,
        indicatorsJson: JSON.stringify(indicators),
        trace: appendTrace(
          signal.trace,
          traceStep('risk.role_entry_suppressed', false, undefined, undefined, undefined, reason),
        ),
      })
      continue
    }

    // cash rebalance / HALF 昇格の後に評価する — どちらも「BUY にする理由」で
    // あって「価格が新鮮かどうか」とは独立の判断だが、最終的に BUY として
    // 発注する前には必ず通す。
    if (signal.action === 'BUY' && priceFreshnessFailure !== null) {
      const reason = priceFreshnessFailure
      summary.rejected.push({ symbol: upper, reason })
      await emitDecision({
        symbol: upper,
        decision: 'SKIP',
        reason,
        price: indicators.price,
        indicatorsJson: JSON.stringify(indicators),
        trace: appendTrace(
          signal.trace,
          traceStep('risk.price_freshness', false, undefined, undefined, undefined, reason),
        ),
      })
      continue
    }

    // check が throw した場合は fail-closed (cooldown 有効扱い) — DB read 失敗で BUY を通すのは避ける。
    if (signal.action === 'BUY' && options.sanityFailedCooldown) {
      let cooledDown = false
      try {
        cooledDown = await options.sanityFailedCooldown.check(upper)
      } catch (err) {
        cooledDown = true
        console.warn(
          JSON.stringify({
            event: 'sanity_failed_cooldown_check_failed',
            requestId: options.requestId ?? null,
            symbol: upper,
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      }
      if (cooledDown) {
        const minutes = Math.round(options.sanityFailedCooldown.withinMs / 60_000)
        const reason = `risk: sanity_failed cooldown active (recent broker stub fill within ${minutes}min)`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(
            signal.trace,
            traceStep('risk.sanity_failed_cooldown', false, undefined, undefined, undefined, reason),
          ),
        })
        continue
      }
    }

    let intent: OrderIntent
    if (signal.action === 'BUY') {
      const rule = strategy.resolveRule(upper)
      const resolvedLotSize =
        options.symbolLotSizeMap?.[upper] ??
        options.lotSize ??
        (options.symbolLotSizeMap === undefined ? 1 : undefined)
      if (
        resolvedLotSize === undefined ||
        !Number.isFinite(resolvedLotSize) ||
        !Number.isInteger(resolvedLotSize) ||
        resolvedLotSize < 1
      ) {
        const reason = `sizing rejected: missing-lot-size (symbol ${upper} has no lot_size configured, entry ${indicators.price})`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(
            signal.trace,
            traceStep('sizing.lot_size_configured', false, undefined, undefined, undefined, 'missing-lot-size'),
          ),
        })
        continue
      }
      // `computePullbackSizing` は 1 銘柄 1 cap しか受け付けないので、呼び出し
      // 側で先に symbolCapMap と maxOrderNotional を min 合成する。
      const perSymbolCap = options.symbolCapMap?.[upper]
      const globalOrderCap = options.maxOrderNotional
      const effectiveSymbolCap =
        perSymbolCap !== undefined && globalOrderCap !== undefined
          ? Math.min(perSymbolCap, globalOrderCap)
          : (perSymbolCap ?? globalOrderCap)
      // cash rebalance の数量は runStrategyCron が allocation 差分から計算済み
      // なので pullback sizing は通さず lot 整合だけ再確認する。global per-order
      // cap は plan 計算後に変わり得るので、ここでも二重適用して cron BUY
      // notional が cap を超えない不変条件を保つ。
      const sizing =
        cashRebalanceQty !== undefined
          ? (() => {
              const lotQty = Math.floor(cashRebalanceQty / resolvedLotSize) * resolvedLotSize
              const lotNotional = lotQty * indicators.price
              if (effectiveSymbolCap !== undefined && lotNotional > effectiveSymbolCap) {
                const cappedQty =
                  Math.floor(effectiveSymbolCap / indicators.price / resolvedLotSize) * resolvedLotSize
                return {
                  quantity: cappedQty,
                  notional: cappedQty * indicators.price,
                  capped: true,
                  capReason: 'symbol-cap' as const,
                }
              }
              return { quantity: lotQty, notional: lotNotional, capped: false }
            })()
          : computePullbackSizing({
              equity: options.equity,
              entryPrice: indicators.price,
              stopPct: rule.stopPct,
              atr20: indicators.atr20,
              baselineAtr20: indicators.baselineAtr20,
              symbolCap: effectiveSymbolCap,
              riskPerTradePct: options.riskPerTradePct,
              lotSize: resolvedLotSize,
              kAtr: rule.kAtr,
              takeProfitPct: rule.takeProfitPct,
              maxStopToTpRatio: rule.maxStopToTpRatio,
              budgetAllocPct: options.symbolBudgetAllocPctMap?.[upper],
              budgetBasisJpy: options.budgetBasisJpy,
              fxJpyPerSymbolCcy: options.fxJpyPerSymbolCcy,
            })
      if (sizing.quantity <= 0) {
        const reason = buildSizingRejectReason(sizing, {
          lotSize: resolvedLotSize,
          entryPrice: indicators.price,
        })
        summary.holds += 1
        await emitDecision({
          symbol: upper,
          decision: 'HOLD',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(signal.trace, traceStep('sizing.quantity_positive', false, sizing.quantity, '>', 0, sizing.capReason)),
        })
        continue
      }
      // sizing 直後・VIX scale より前に適用。VIX warning と重なった場合は
      // 乗算で両方効く (より保守的な側に倒れる)。
      let scaledQuantity = sizing.quantity
      if (positionMultiplier < 1) {
        scaledQuantity = applySizeScale(sizing.quantity, resolvedLotSize, positionMultiplier)
        if (scaledQuantity <= 0) {
          const reason = `sizing rejected: half-entry qty rounded to 0 (raw ${sizing.quantity} × ${positionMultiplier}, lot=${resolvedLotSize})`
          summary.holds += 1
          await emitDecision({
            symbol: upper,
            decision: 'HOLD',
            reason,
            price: indicators.price,
            indicatorsJson: JSON.stringify(indicators),
            trace: appendTrace(
              signal.trace,
              traceStep('sizing.half_entry_quantity_positive', false, scaledQuantity, '>', 0, reason),
            ),
          })
          continue
        }
      }
      if (options.vixDecision) {
        if (options.vixDecision.sizeScale === 0) {
          const reason = `risk: ${options.vixDecision.reason}`
          summary.holds += 1
          await emitDecision({
            symbol: upper,
            decision: 'HOLD',
            reason,
            price: indicators.price,
            indicatorsJson: JSON.stringify(indicators),
            trace: appendTrace(
              signal.trace,
              traceStep('risk.vix_regime', false, options.vixDecision.vix ?? null, '<=', null, options.vixDecision.reason),
            ),
          })
          continue
        }
        if (options.vixDecision.sizeScale < 1) {
          // half-entry 適用後の qty を基数にする (0.5x と VIX scale は乗算)。
          scaledQuantity = applySizeScale(scaledQuantity, resolvedLotSize, options.vixDecision.sizeScale)
          if (scaledQuantity <= 0) {
            const reason = `risk: ${options.vixDecision.reason} (qty rounded to 0, lot=${resolvedLotSize})`
            summary.holds += 1
            await emitDecision({
              symbol: upper,
              decision: 'HOLD',
              reason,
              price: indicators.price,
              indicatorsJson: JSON.stringify(indicators),
              trace: appendTrace(
                signal.trace,
                traceStep(
                  'risk.vix_regime',
                  false,
                  scaledQuantity,
                  '>',
                  0,
                  `${options.vixDecision.reason}; qty 0 after lot round`,
                ),
              ),
            })
            continue
          }
        }
      }
      // VIX と乗算チェーンで合成 (VIX 適用後の qty に続けて scale する)。既に
      // VIX で 0 に丸まっていればこのブロックへは到達しない。
      if (options.newsShockGate) {
        const newsDecision = options.newsShockGate.decision
        const isObserve = options.newsShockGate.mode === 'observe'
        if (isObserve) {
          const wouldReduce = newsDecision.sizeScale < 1
          const observeNote = wouldReduce
            ? ` [observe: enforce なら size x${newsDecision.sizeScale}]`
            : ''
          signal = {
            ...signal,
            trace: appendTrace(
              signal.trace,
              traceStep(
                'risk.news_shock',
                !wouldReduce,
                newsDecision.ratio ?? null,
                undefined,
                undefined,
                `${newsDecision.reason}${observeNote}`,
              ),
            ),
          }
        } else if (newsDecision.sizeScale === 0) {
          const reason = `risk: ${newsDecision.reason}`
          summary.holds += 1
          await emitDecision({
            symbol: upper,
            decision: 'HOLD',
            reason,
            price: indicators.price,
            indicatorsJson: JSON.stringify(indicators),
            trace: appendTrace(
              signal.trace,
              traceStep('risk.news_shock', false, newsDecision.ratio ?? null, '<=', null, newsDecision.reason),
            ),
          })
          continue
        } else if (newsDecision.sizeScale < 1) {
          scaledQuantity = applySizeScale(scaledQuantity, resolvedLotSize, newsDecision.sizeScale)
          if (scaledQuantity <= 0) {
            const reason = `risk: ${newsDecision.reason} (qty rounded to 0, lot=${resolvedLotSize})`
            summary.holds += 1
            await emitDecision({
              symbol: upper,
              decision: 'HOLD',
              reason,
              price: indicators.price,
              indicatorsJson: JSON.stringify(indicators),
              trace: appendTrace(
                signal.trace,
                traceStep(
                  'risk.news_shock',
                  false,
                  scaledQuantity,
                  '>',
                  0,
                  `${newsDecision.reason}; qty 0 after lot round`,
                ),
              ),
            })
            continue
          }
        }
      }
      // VIX / news shock と同じ乗算チェーンの最後に適用。symbol ごとの Map な
      // ので対象銘柄の decision が無ければ no-op。decision が Map にある時点で
      // 警戒シグナル確定なので、news shock の enforce-reduce 成功時とは異なり
      // observe/enforce 問わず常に trace を残す (運用可視性を一貫させる)。
      const extendedHoursGateOpt = options.extendedHoursGate
      const extendedHoursDecision = extendedHoursGateOpt?.decisions.get(upper)
      if (extendedHoursGateOpt && extendedHoursDecision) {
        const isObserve = extendedHoursGateOpt.mode === 'observe'
        const observeNote = isObserve
          ? ` [observe: enforce なら ${extendedHoursDecision.action === 'block_entry' ? 'BUY 停止' : `size x${extendedHoursDecision.multiplier}`}]`
          : ''
        signal = {
          ...signal,
          trace: appendTrace(
            signal.trace,
            traceStep(
              'risk.extended_hours',
              false,
              extendedHoursDecision.multiplier,
              undefined,
              undefined,
              `${extendedHoursDecision.reason}${observeNote}`,
            ),
          ),
        }
        if (!isObserve && extendedHoursDecision.action === 'block_entry') {
          const reason = `risk: ${extendedHoursDecision.reason}`
          summary.holds += 1
          await emitDecision({
            symbol: upper,
            decision: 'HOLD',
            reason,
            price: indicators.price,
            indicatorsJson: JSON.stringify(indicators),
            trace: signal.trace,
          })
          continue
        }
        if (!isObserve && extendedHoursDecision.action === 'reduce_entry') {
          scaledQuantity = applySizeScale(scaledQuantity, resolvedLotSize, extendedHoursDecision.multiplier)
          if (scaledQuantity <= 0) {
            const reason = `risk: ${extendedHoursDecision.reason} (qty rounded to 0, lot=${resolvedLotSize})`
            summary.holds += 1
            await emitDecision({
              symbol: upper,
              decision: 'HOLD',
              reason,
              price: indicators.price,
              indicatorsJson: JSON.stringify(indicators),
              trace: appendTrace(
                signal.trace,
                traceStep(
                  'risk.extended_hours',
                  false,
                  scaledQuantity,
                  '>',
                  0,
                  `${extendedHoursDecision.reason}; qty 0 after lot round`,
                ),
              ),
            })
            continue
          }
        }
      }
      if (!Number.isFinite(indicators.price) || indicators.price <= 0) {
        const reason = `invalid price: ${indicators.price}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.price_valid', false, indicators.price, '>', 0)),
        })
        continue
      }
      const notional = scaledQuantity * indicators.price
      if (!Number.isFinite(notional) || notional <= 0) {
        const reason = `invalid notional: ${notional} (qty=${scaledQuantity}, price=${indicators.price})`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.notional_valid', false, notional, '>', 0)),
        })
        continue
      }
      intent = buildIntent(upper, 'BUY', scaledQuantity, indicators.price)
    } else {
      // SELL: close the full open position.
      if (state.position === null) {
        const reason = 'SELL without position'
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.sell_position_exists', false, false, 'exists', true)),
        })
        continue
      }
      if (!Number.isFinite(state.position.qty) || state.position.qty <= 0) {
        const reason = `invalid position qty: ${state.position.qty}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.position_qty_valid', false, state.position.qty, '>', 0)),
        })
        continue
      }
      if (!Number.isFinite(indicators.price) || indicators.price <= 0) {
        const reason = `invalid price: ${indicators.price}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.price_valid', false, indicators.price, '>', 0)),
        })
        continue
      }
      const notional = state.position.qty * indicators.price
      if (!Number.isFinite(notional) || notional <= 0) {
        const reason = `invalid notional: ${notional} (qty=${state.position.qty}, price=${indicators.price})`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.notional_valid', false, notional, '>', 0)),
        })
        continue
      }
      // signal.quantity はクランプ済みのはずだが、上流の trace 差し替えで
      // 壊れていないか防御的に再検証する。壊れていれば全量 close にフォール
      // バックせず SKIP — 意図しない数量で発注しない。
      if (cashRebalancePartialSell) {
        if (
          !Number.isInteger(signal.quantity) ||
          signal.quantity <= 0 ||
          signal.quantity > state.position.qty
        ) {
          const reason = `invalid cash rebalance sell qty: ${signal.quantity} (position ${state.position.qty})`
          summary.rejected.push({ symbol: upper, reason })
          await emitDecision({
            symbol: upper,
            decision: 'SKIP',
            reason,
            price: indicators.price,
            trace: appendTrace(
              signal.trace,
              traceStep('scheduler.sell_qty_valid', false, signal.quantity, '<=', state.position.qty),
            ),
          })
          continue
        }
      }
      intent = buildIntent(
        upper,
        'SELL',
        cashRebalancePartialSell ? signal.quantity : state.position.qty,
        indicators.price,
      )
    }

    // BUY の場合のみ評価する。SELL は撤退路を妨げないよう対象外。
    if (options.earningsGate && intent.side === 'BUY') {
      const evalDate = now().toISOString().slice(0, 10)
      const earningsDecision = await evaluateEarningsGate(
        { symbol: upper, evalDate, side: 'BUY' },
        options.earningsGate.repo,
        { freezeBusinessDays: options.earningsGate.freezeBusinessDays ?? 1 },
      )
      if (!earningsDecision.approved) {
        const reason = `risk: ${earningsDecision.reason ?? 'earnings_gate'}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(
            signal.trace,
            traceStep('risk.earnings_calendar', false, undefined, undefined, undefined, earningsDecision.reason),
          ),
        })
        continue
      }
    }

    // earnings gate より後で評価する — 両方 reject なら earnings reason が先に確定する。
    if (options.macroEventGate && intent.side === 'BUY') {
      const evalTimestamp = now().toISOString()
      const macroDecision = await evaluateMacroEventGate(
        { evalTimestamp, side: 'BUY' },
        options.macroEventGate.repo,
        { ...DEFAULT_MACRO_GATE_CONFIG, ...(options.macroEventGate.config ?? {}) },
      )
      if (!macroDecision.approved) {
        const reason = `risk: ${macroDecision.reason ?? 'macro_event_gate'}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(
            signal.trace,
            traceStep('risk.macro_event', false, undefined, undefined, undefined, macroDecision.reason),
          ),
        })
        continue
      }
    }

    // Inverse pair の SymbolState は同期 pure 関数で要求されるため、BUY のみ事前 fetch する。
    if (options.perSymbolRisk) {
      let inverseState: SymbolState | null = null
      const inverseSymbol =
        intent.side === 'BUY' ? options.perSymbolRisk.inversePairs[upper] : undefined
      if (inverseSymbol) {
        try {
          inverseState = await options.positionStore.getState(inverseSymbol)
        } catch {
          // fetch 失敗は inverse gate fail-open — BUY ごと止めると universe
          // 全体が連鎖 reject になり得るため、他の gate に判断を任せる。
          inverseState = null
        }
      }
      const riskDecision = evaluatePerSymbolRisk(
        {
          symbol: upper,
          side: intent.side,
          intentPrice: intent.price,
          intentNotional: intent.notional,
          state,
          inverseState,
          now: now(),
        },
        {
          inversePairs: options.perSymbolRisk.inversePairs,
          spreadLimits: options.perSymbolRisk.spreadLimits,
          staleQuoteMs: options.perSymbolRisk.staleQuoteMs,
          gapRejectPct: options.perSymbolRisk.gapRejectPct,
          // cash rebalance / intraday close は decide() 後に signal を上書きする
          // ため、Strategy.decide() 自身の cooldown 判定を経由しない BUY が
          // 発生し得る。SELL は評価対象外 (exit を cooldown で block しない)。
          evaluateCooldown: intent.side === 'BUY',
        },
      )
      if (!riskDecision.approved) {
        const reason = `risk: ${riskDecision.reasons.join(', ')}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(signal.trace, traceStep('risk.per_symbol_gate', false, undefined, undefined, undefined, riskDecision.reasons.join(', '))),
        })
        continue
      }
    }

    // 減算は約定成立後 (loop は逐次なので check→commit で整合する)。
    if (intent.side === 'BUY' && options.buyingPower) {
      const ledger = options.buyingPower
      const notionalJpy = intent.notional * (options.fxJpyPerSymbolCcy ?? 1)
      const insufficient = ledger.status !== 'ok' || notionalJpy > ledger.remainingJpy
      if (insufficient) {
        const reason =
          ledger.status !== 'ok'
            ? `risk: buying-power unavailable (${ledger.reason ?? 'fetch failed'})`
            : `risk: insufficient buying power (notionalJpy ${Math.round(notionalJpy)} > remaining ${Math.round(ledger.remainingJpy)})`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(
            signal.trace,
            traceStep('risk.buying_power_pool', false, Math.round(notionalJpy), '<=', Math.round(ledger.remainingJpy), reason),
          ),
        })
        continue
      }
    }

    // 買付余力 pool ゲートと同じ形 (JPY 換算 → 共有台帳の残枠と突き合わせ)。
    if (intent.side === 'BUY' && options.exposureCap) {
      const ledger = options.exposureCap
      const notionalJpy = intent.notional * (options.fxJpyPerSymbolCcy ?? 1)
      const exceeds = ledger.status !== 'ok' || notionalJpy > ledger.remainingJpy
      if (exceeds) {
        const reason =
          ledger.status !== 'ok'
            ? `risk: portfolio exposure cap unavailable (${ledger.reason ?? 'unknown'})`
            : `risk: portfolio exposure cap (notionalJpy ${Math.round(notionalJpy)} > remaining ${Math.round(ledger.remainingJpy)} of ceiling ${Math.round(ledger.ceilingJpy)})`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(
            signal.trace,
            traceStep('risk.portfolio_exposure_cap', false, Math.round(notionalJpy), '<=', Math.round(ledger.remainingJpy), reason),
          ),
        })
        continue
      }
    }

    const expiresAtMs = now().getTime() + pendingLockTtlMs
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now().getTime()) {
      const reason = `invalid expiresAt computed from pendingLockTtlMs: ${pendingLockTtlMs}`
      summary.rejected.push({ symbol: upper, reason })
      await emitDecision({
        symbol: upper,
        decision: 'SKIP',
        reason,
        price: indicators.price,
        trace: appendTrace(signal.trace, traceStep('scheduler.pending_lock_expiry_valid', false, expiresAtMs, '>', now().getTime())),
      })
      continue
    }
    const lockResult = await options.positionStore.lockPendingOrder(upper, {
      clientOrderId: intent.clientOrderId,
      side: intent.side,
      submittedAt: now().toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    })
    if (!lockResult.ok) {
      const reason = 'pending order already in flight'
      summary.rejected.push({ symbol: upper, reason })
      await emitDecision({
        symbol: upper,
        decision: 'SKIP',
        reason,
        price: indicators.price,
        trace: appendTrace(signal.trace, traceStep('scheduler.pending_lock_acquired', false, false, '==', true)),
      })
      continue
    }

    // Without this, cron orders bypass trade_journal entirely and are
    // invisible to reconcileFills. Logging is isolated in its own try/catch —
    // if the D1 write throws, execution + pending-lock release must still
    // proceed, otherwise the lock leaks and the symbol gets stuck.
    try {
      logPreSubmit({ clientOrderId: intent.clientOrderId, intent })
    } catch (logError) {
      console.error(
        JSON.stringify({
          event: 'cron_log_pre_submit_failed',
          symbol: upper,
          clientOrderId: intent.clientOrderId,
          message: logError instanceof Error ? logError.message : String(logError),
        }),
      )
    }

    let result: ExecutionResult | undefined
    let executedIntent: OrderIntent = intent
    let fallbackApplied = false
    const startedAt = Date.now()
    try {
      result = await options.execution.execute(intent)
    } catch (error) {
      // cash rebalance の部分 SELL はこの fallback から除外する: 成功後に
      // position を qty=0 へ強制リセットする挙動 (下記) は「意図した SELL は
      // 全量 close だった」前提に依存しており、意図的に一部だけ残す部分 SELL
      // に適用すると、実際は残っているはずの保有を DO 上だけ消してしまう。
      // 部分 SELL が SELL_QTY_EXCEED を踏んだ場合は通常の ERROR/REJECT 経路
      // (fail-closed、position は変更しない) に倒す。
      const fallbackResult =
        intent.side === 'SELL' &&
        !cashRebalancePartialSell &&
        options.sellFallback &&
        isSellQtyExceedError(error)
          ? await tryFallbackSell({
              originalIntent: intent,
              error,
              upper,
              symbol,
              execution: options.execution,
              positionStore: options.positionStore,
              sellFallback: options.sellFallback,
              requestId: options.requestId,
            })
          : null
      if (fallbackResult) {
        result = fallbackResult.result
        executedIntent = fallbackResult.intent
        fallbackApplied = true
      } else {
        await options.positionStore.clearPendingOrder(upper).catch(() => undefined)
        summary.errors.push({
          symbol: upper,
          message: messageOf(error),
        })
        // broker 4xx (429 除く) は注文の確定拒否 → REJECT。429 は再送で解消
        // しうる一時的失敗、それ以外 (5xx / ネットワーク断等) も原因不明・
        // 一時的として ERROR のまま。
        const brokerStatus = error instanceof BrokerRequestError ? error.brokerStatus : undefined
        const isBrokerReject =
          brokerStatus !== undefined && brokerStatus >= 400 && brokerStatus < 500 && brokerStatus !== 429
        await emitDecision({
          symbol: upper,
          decision: isBrokerReject ? 'REJECT' : 'ERROR',
          // localizeReason (表示層) が `^broker submit error: ` を prefix match
          // するので、発注内容は message の後ろに付けて prefix を壊さない。
          reason: `broker submit error: ${messageOf(error)} [${describeOrderAmount(intent, options.fxJpyPerSymbolCcy)}]`,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('broker.submit', false, messageOf(error), '==', 'submitted')),
        })
        emitNotify({
          type: 'ERROR',
          symbol: upper,
          message: messageOf(error),
          // surge detector が cause で count するため 4xx/429/5xx/other に分類する。
          cause: classifyBrokerErrorCause(error) ?? 'broker submit',
        })
        // 銘柄単位の恒久拒否は再送しても解消しないので、BUY のみ hook で
        // fail-closed に停止する (SELL は対象外 — 保有の orphan 化を避ける)。
        if (intent.side === 'BUY' && options.onTickerDeny && isTickerDenyError(error)) {
          await options.onTickerDeny(upper)
        }
        try {
          logPostSubmit({
            clientOrderId: intent.clientOrderId,
            symbol: upper,
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error : new Error(String(error)),
          })
        } catch (logError) {
          console.error(
            JSON.stringify({
              event: 'cron_log_post_submit_failed',
              symbol: upper,
              clientOrderId: intent.clientOrderId,
              message: logError instanceof Error ? logError.message : String(logError),
            }),
          )
        }
        continue
      }
    }

    try {
      logPostSubmit({
        clientOrderId: executedIntent.clientOrderId,
        symbol: upper,
        result,
        latencyMs: Date.now() - startedAt,
      })
    } catch (logError) {
      console.error(
        JSON.stringify({
          event: 'cron_log_post_submit_failed',
          symbol: upper,
          clientOrderId: executedIntent.clientOrderId,
          message: logError instanceof Error ? logError.message : String(logError),
        }),
      )
    }

    // DO state lies above broker truth (the reason we hit the fallback).
    // Force-reset position=null instead of `recordFill`, which would leave
    // a non-zero remainder from executed qty < DO qty.
    if (fallbackApplied) {
      try {
        await options.positionStore.overridePosition(upper, {
          qty: 0,
          avgPrice: 0,
          openedAt: null,
          reason: `sell_qty_fallback: closed at broker available qty (originalIntentQty=${intent.quantity}, executedQty=${executedIntent.quantity})`,
          requestId: options.requestId ?? null,
        })
      } catch (resetError) {
        console.error(
          JSON.stringify({
            event: 'sell_qty_fallback_reset_failed',
            requestId: options.requestId ?? null,
            symbol: upper,
            message: resetError instanceof Error ? resetError.message : String(resetError),
          }),
        )
      }
    }

    // Increment counters only after successful execution.
    if (executedIntent.side === 'BUY') {
      summary.buys += 1
      // 約定した BUY 分を共有台帳から減算し、次銘柄の pool 判定に反映する。
      options.buyingPower?.tryReserve(intent.notional * (options.fxJpyPerSymbolCcy ?? 1))
      options.exposureCap?.tryReserve(intent.notional * (options.fxJpyPerSymbolCcy ?? 1))
    } else {
      summary.sells += 1
    }
    await emitDecision({
      symbol: upper,
      decision: executedIntent.side,
      reason: fallbackApplied
        ? `sell_qty_fallback: ${signal.reason} (originalQty=${intent.quantity}, executedQty=${executedIntent.quantity})`
        : signal.reason,
      price: executedIntent.price,
      indicatorsJson: JSON.stringify(indicators),
      clientOrderId: executedIntent.clientOrderId,
      trace: appendTrace(
        signal.trace,
        traceStep('broker.submit', true, result.mode, '==', 'submitted'),
        ...(fallbackApplied
          ? [
              traceStep(
                'broker.sell_qty_fallback',
                true,
                executedIntent.quantity,
                '==',
                intent.quantity,
                'broker available qty で再 submit',
              ),
            ]
          : []),
      ),
      order: {
        side: executedIntent.side,
        quantity: executedIntent.quantity,
        notional: executedIntent.notional,
      },
    })

    // avgPrice が無い SELL は上で reject 済のため発生しないはずだが defensive。
    // 通知に出す realized も `reconcileFills` と同じ net にする (片方 gross・
    // 片方 net だと突き合わせできない)。
    const realizedPnl =
      executedIntent.side === 'SELL' && state.position && Number.isFinite(state.position.avgPrice)
        ? netRealizedPnl({
            avgPrice: state.position.avgPrice,
            exitPrice: executedIntent.price,
            quantity: executedIntent.quantity,
            config: options.tradeCost ?? NO_TRADE_COST,
          }).net
        : undefined
    emitNotify({
      type: 'TRADE',
      side: executedIntent.side,
      symbol: upper,
      qty: executedIntent.quantity,
      price: executedIntent.price,
      ...(realizedPnl !== undefined ? { realizedPnl } : {}),
      mode: result.mode,
    })

    if (result.mode === 'DRY_RUN') {
      // No broker event will clear the lock; release it eagerly.
      await options.positionStore.clearPendingOrder(upper).catch(() => undefined)
    }
  }

  return summary
}

/**
 * SELL_QTY_EXCEED fallback inner. Returns the successful execution result
 * + the (possibly resized) intent that was actually submitted. Returns
 * `null` when the fallback can't or shouldn't run — the caller treats
 * `null` as "go re-throw the original error path".
 *
 * Conservative invariants:
 *   - `available <= 0` → null (nothing to sell, original 417 stands)
 *   - `available >= intent.quantity` → null (broker truth >= our intent;
 *     the 417 was unexpected and we shouldn't paper over it)
 *   - retry submit throws → null (don't substitute a different error)
 *   - resolver throws / returns NaN → null
 *
 * The successful path emits one structured `sell_qty_fallback_submitted`
 * audit log so the run is reconstructable from log tail. clientOrderId is
 * regenerated for the retry so it doesn't collide with the original
 * (rejected) submission's idempotency key.
 */
async function tryFallbackSell(args: {
  originalIntent: OrderIntent
  error: unknown
  upper: string
  symbol: string
  execution: Execution
  positionStore: PositionStore
  sellFallback: SellFallbackConfig
  requestId?: string
}): Promise<{ result: ExecutionResult; intent: OrderIntent } | null> {
  let available: number | null
  try {
    available = await args.sellFallback.getAvailableQty(args.upper)
  } catch (resolverErr) {
    console.warn(
      JSON.stringify({
        event: 'sell_qty_fallback_resolver_failed',
        requestId: args.requestId ?? null,
        symbol: args.upper,
        message: resolverErr instanceof Error ? resolverErr.message : String(resolverErr),
      }),
    )
    return null
  }
  if (available === null || !Number.isFinite(available) || available <= 0) {
    return null
  }
  if (available >= args.originalIntent.quantity) {
    // Broker says we have at least as much as we tried to SELL — the 417
    // contradicts that, so the situation is something else (transient,
    // race, broker bug). Don't fabricate a reduced SELL.
    return null
  }
  const fallbackIntent: OrderIntent = {
    ...args.originalIntent,
    quantity: available,
    notional: available * args.originalIntent.price,
    clientOrderId: crypto.randomUUID().replaceAll('-', ''),
  }
  try {
    const result = await args.execution.execute(fallbackIntent)
    console.log(
      JSON.stringify({
        event: 'sell_qty_fallback_submitted',
        requestId: args.requestId ?? null,
        symbol: args.upper,
        originalClientOrderId: args.originalIntent.clientOrderId,
        fallbackClientOrderId: fallbackIntent.clientOrderId,
        originalQty: args.originalIntent.quantity,
        fallbackQty: fallbackIntent.quantity,
        price: fallbackIntent.price,
      }),
    )
    return { result, intent: fallbackIntent }
  } catch (retryErr) {
    console.warn(
      JSON.stringify({
        event: 'sell_qty_fallback_retry_failed',
        requestId: args.requestId ?? null,
        symbol: args.upper,
        originalClientOrderId: args.originalIntent.clientOrderId,
        fallbackClientOrderId: fallbackIntent.clientOrderId,
        message: retryErr instanceof Error ? retryErr.message : String(retryErr),
      }),
    )
    return null
  }
}

function buildIntent(symbol: string, side: 'BUY' | 'SELL', qty: number, price: number): OrderIntent {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`buildIntent: invalid qty=${qty} for ${symbol}`)
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`buildIntent: invalid price=${price} for ${symbol}`)
  }
  const notional = qty * price
  if (!Number.isFinite(notional) || notional <= 0) {
    throw new Error(`buildIntent: invalid notional=${notional} for ${symbol} (qty=${qty}, price=${price})`)
  }
  return {
    symbol,
    side,
    quantity: qty,
    price,
    notional,
    clientOrderId: crypto.randomUUID().replaceAll('-', ''),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Daily bar 取得を 1 回だけ retry する。吸収しないと、保有中 symbol の exit
 * 判定が upstream の一時的な障害でそのまま丸ごと飛ぶ。2 回とも失敗したら
 * 2 回目の error をそのまま投げる。
 */
async function fetchDailyBarsWithRetry(
  barClient: BarClient,
  symbol: string,
  lookback: number,
): Promise<DailyBar[]> {
  try {
    return await barClient.getDailyBars(symbol, lookback)
  } catch {
    return await barClient.getDailyBars(symbol, lookback)
  }
}

/**
 * 発注しようとした数量・金額を「何口 / いくら」で人間可読に整形する。USD 銘柄
 * (fx>0 かつ !=1) は $ と ¥ を併記、JPY 銘柄 (fx=1) は ¥、fx 不明は通貨記号なし。
 */
function describeOrderAmount(intent: OrderIntent, fxJpyPerSymbolCcy: number | undefined): string {
  const { quantity: qty, price: px, notional } = intent
  const yen = (n: number) => `¥${Math.round(n).toLocaleString('en-US')}`
  if (fxJpyPerSymbolCcy !== undefined && Number.isFinite(fxJpyPerSymbolCcy) && fxJpyPerSymbolCcy > 0) {
    if (fxJpyPerSymbolCcy === 1) {
      return `発注内容: ${qty}口 @ ${yen(px)} = ${yen(notional)}`
    }
    return `発注内容: ${qty}口 @ $${px} = $${notional.toFixed(2)} ≈ ${yen(notional * fxJpyPerSymbolCcy)} (USD/JPY ${fxJpyPerSymbolCcy})`
  }
  return `発注内容: ${qty}口 @ ${px} = ${notional} (通貨不明)`
}

/**
 * Risk gate (VIX / news shock / half-entry) が共通で使う size scaling。`scale`
 * 倍した raw qty を lot 単位に floor する (lot=1 なら単純な floor)。結果が 0
 * になれば呼び出し側が reject する (部分 entry すらできない小口は見送り)。
 */
function applySizeScale(qty: number, lot: number, scale: number): number {
  const raw = qty * scale
  return lot > 1 ? Math.floor(raw / lot) * lot : Math.floor(raw)
}

function appendTrace(
  trace: DecisionTraceStep[] | undefined,
  ...steps: DecisionTraceStep[]
): DecisionTraceStep[] {
  return [...(trace ?? []), ...steps]
}

function traceStep(
  label: string,
  passed: boolean,
  actual?: DecisionTraceStep['actual'],
  operator?: DecisionTraceStep['operator'],
  threshold?: DecisionTraceStep['threshold'],
  message?: string,
): DecisionTraceStep {
  return {
    label,
    label_ja: labelJa(label),
    passed,
    ...(actual !== undefined ? { actual } : {}),
    ...(operator !== undefined ? { operator } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(message !== undefined ? { message } : {}),
  }
}

function labelJa(label: string): string {
  return TRACE_LABEL_JA[label] ?? label
}

const TRACE_LABEL_JA: Record<string, string> = {
  'sizing.quantity_positive': '買付余力が1株/1単元以上ある',
  'sizing.lot_size_configured': '売買単位 (lot_size) が設定済み',
  'exit.intraday_close': 'intraday-only 引け前強制クローズ',
  'scheduler.price_valid': '株価が有効',
  'scheduler.notional_valid': '発注金額が有効',
  'scheduler.sell_position_exists': '売却対象の保有がある',
  'scheduler.position_qty_valid': '保有数量が有効',
  'scheduler.pending_lock_expiry_valid': '注文ロック期限が有効',
  'scheduler.pending_lock_acquired': '注文ロックを取得できた',
  'risk.earnings_calendar': '決算日カレンダーゲート',
  'risk.macro_event': 'マクロイベントゲート',
  'risk.per_symbol_gate': '銘柄別リスクゲート',
  'risk.vix_regime': 'VIX レジーム判定',
  'risk.news_shock': 'ニュース過熱ゲート',
  'risk.extended_hours': '時間外 (プレマーケット) 警戒ゲート',
  'risk.role_entry_suppressed': 'ロール entry 抑止 (#452)',
  'entry.half_status': '段階判定 HALF (0.5x、#452)',
  'entry.cash_rebalance': '条件連動配分 cash rebalance (#452)',
  'exit.cash_rebalance': '条件連動配分 cash rebalance SELL (#452 follow-up)',
  'scheduler.sell_qty_valid': 'SELL 数量が保有数量以下の正整数',
  'regime.zone': 'ペアレジーム判定 (#472)',
  'risk.pair_regime': 'ペアレジーム gate (#472)',
  'exit.regime_flip': 'レジーム反転 exit (#472)',
  'exit.regime_flip_secondary': 'レジーム反転 (副次理由、#472)',
  'sizing.half_entry_quantity_positive': 'HALF 数量が1株/1単元以上ある',
  'risk.buying_power_pool': '口座買付余力プール (発注前)',
  'risk.portfolio_exposure_cap': 'ポートフォリオ全体エクスポージャー上限',
  'risk.sanity_failed_cooldown': 'sanity_failed cooldown (broker stub 疑い)',
  'broker.submit': '証券会社への発注送信',
  'broker.sell_qty_fallback': 'SELL 数量超過時の broker available qty 再 submit',
  'entry.intraday_no_entry': 'intraday-only 引け前30分の新規entry禁止',
  'data.price_as_of': '判断価格の出所・時刻',
  'risk.price_freshness': '価格鮮度ゲート (BUY のみ)',
}

/**
 * Build an operator-actionable reject reason from a sizing failure。
 * 単に capReason を出すと「なぜ失敗したか / 何を直せばよいか」が見えない
 * (例: `lot-size-round` だけでは raw qty も stop も予算も分からない)。
 * 失敗 route ごとに diagnostic 値を埋め込む。localizeReason 側が regex で
 * 日本語化する。
 */
function buildSizingRejectReason(
  sizing: import('./pullbackSizing').PullbackSizingResult,
  ctx: { lotSize: number; entryPrice: number },
): string {
  const cr = sizing.capReason
  if (cr === 'lot-size-round') {
    const raw = sizing.rawQuantity ?? 0
    const stop = sizing.stopDistance ?? 0
    return `sizing rejected: lot-size-round (raw qty ${raw} < lot ${ctx.lotSize}, stop ${stop.toFixed(2)}, entry ${ctx.entryPrice})`
  }
  if (cr === 'insufficient-risk-budget') {
    const budget = sizing.riskBudget ?? 0
    return `sizing rejected: insufficient-risk-budget (budget ${budget.toFixed(2)})`
  }
  if (cr === 'invalid-stop') {
    const stop = sizing.stopDistance ?? 0
    return `sizing rejected: invalid-stop (stopDistance ${stop})`
  }
  if (cr === 'capital-unset') {
    return 'sizing rejected: capital-unset (set total_capital_usd / total_capital_jpy for risk-% sizing)'
  }
  return `sizing rejected: ${cr ?? 'zero qty'}`
}
