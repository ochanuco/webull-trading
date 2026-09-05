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
import {
  computeHoldBusinessDays,
  computePullbackIndicators,
  type DailyBar,
} from './indicators'
import { computePullbackSizing } from './pullbackSizing'
import type { BuyingPowerLedger } from './buyingPower'
import type { ExposureLedger } from './exposureLedger'

/**
 * #intraday-only: US 引け何分前から強制クローズ window を開けるか。cron は 5 分間隔
 * なので 15 分なら必ず 1 tick は窓内に入る (引け前 3 tick = 15/10/5 分前)。
 */
const INTRADAY_CLOSE_WINDOW_MIN = 15
/**
 * 新規 BUY を止める引け前 window (分、`INTRADAY_CLOSE_WINDOW_MIN`
 * より広く取る)。15 分 cron は 1 window 内で「force-close」と「新規 entry」を
 * 両立できない — window 内で拾った BUY はその場で force-close されて往復コスト
 * だけ発生するか、次 tick (session gate 外) まで持ち越されてオーバーナイトになる
 * (実例: 15:45 ET に flat SOXL が entry setup で BUY → 16:00 tick は session
 * window 外で素通り、intraday-only が防ぎたい持ち越しがそのまま起きた)。
 */
const INTRADAY_NO_ENTRY_WINDOW_MIN = 30
/**
 * intraday bar 鮮度ゲートの default 上限 (ms)。60m bar の
 * timestamp は足の始値時刻なので正常系でも取得時刻との差は最大 60分。provider
 * 遅延分の余裕を足して 2h — 60分ちょうどにすると正常な bar まで reject する。
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
  /**
   * Risk-% sizing の母数となる口座資産。未指定は risk-% branch を
   * `capital-unset` で fail-closed させる (`total_capital_usd/jpy` 未設定の
   * 口座に架空の baseline を当てない)。budget-alloc 銘柄は未使用なので
   * 影響しない。
   */
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
   * #momentum: role === 'momentum' の symbol 集合。これに含まれる symbol は
   * `momentumStrategy` で判定する (押し目戦略の代わり)。signal は以降の
   * Risk→Execution を通常 BUY/SELL と同じく通る。
   */
  momentumSymbols?: Set<string>
  /** #momentum: momentum symbol 用の戦略。未指定なら momentum symbol も押し目で判定 (後方互換)。 */
  momentumStrategy?: BreakoutMomentumStrategy
  symbolCapMap?: Record<string, number>
  /**
   * `global_config.max_order_notional_usd/jpy` (symbol 通貨単位)。
   * 銘柄別 `symbolCapMap` とは min で合成する global な 1 注文あたりの上限 —
   * 未設定なら無制限 (従来挙動)。manual `/trade/execute` (`DefaultRiskPolicy`) /
   * cash-rebalance plan (`buildCashRebalancePlan`) は既にこの cap を通しているが、
   * cron の通常 BUY sizing 経路 (`computePullbackSizing`) だけ symbol cap しか
   * 見ていなかった — global cap を上げ忘れたまま個別銘柄 cap を外すと、想定外の
   * 巨大 notional が cron から発注され得る。
   */
  maxOrderNotional?: number
  barLookback?: number
  riskPerTradePct?: number
  pendingLockTtlMs?: number
  /**
   * @deprecated Run 単位の一律 lot。後方互換のため残置 (test 用)。production の
   * `runStrategyCron` は渡さず `symbolLotSizeMap` を使う。symbol が map にも
   * これにも無ければ fail-closed (#symbol-lot-size)。
   */
  lotSize?: number
  /**
   * symbol → lot_size (売買単位、integer >= 1)。`lotSize` (run 単位) より優先。
   * **この map を渡した時点で lot 必須モードになる**: map に該当 symbol が無い
   * BUY は fail-closed (発注見送り) — blanket default に倒さない (#symbol-lot-size)。
   * production (`runStrategyCron`) は常にこれを渡す。map も `lotSize` も渡さない
   * legacy caller のみ従来の lot=1 に倒す (旧 unit test 後方互換)。
   */
  symbolLotSizeMap?: Record<string, number>
  /**
   * symbol → budget_alloc_pct (0<pct<=1)。指定 symbol は fixed-% 配分 sizing
   * (口座(円)単一プールに対する割合) に切替わる (#budget-jpy-base-fx)。
   * 未指定 symbol は従来の risk-% sizing。
   */
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
   * 口座買付余力の共有プール台帳 (#415)。指定時、BUY の submit 直前に notional を
   * JPY 換算して `tryReserve` し、超過 / `unavailable` は pre-trade で reject する
   * (Webull 417 をローカルで先回り)。runs (USD/JPY) をまたいで同一 ledger を共有
   * する想定。未指定 (DryRun / legacy / test) は pool ゲート無効。
   */
  buyingPower?: BuyingPowerLedger
  /**
   * Portfolio 全体エクスポージャー上限の共有台帳
   * (`global_config.max_portfolio_exposure_pct`)。指定時、BUY の submit 直前に
   * notional を JPY 換算して `tryReserve` し、残枠を超える/`unavailable` は
   * pre-trade で reject する。`buyingPower` と同じ設計 (runs=USD/JPY・pass 1/2
   * をまたいで同一 ledger を共有し、逐次減算する)。未指定 (DryRun / legacy /
   * test) はゲート無効。
   */
  exposureCap?: ExposureLedger
  /**
   * intraday-only 銘柄の集合 (#intraday-only)。US 引け前 window 内で保有があれば
   * strategy 判定を上書きして **強制 SELL**(オーバーナイト持ち越し禁止)。レバ ETF の
   * 寄りギャップ stop-out 回避。未指定/対象外は従来どおりスイング保有。
   */
  intradayOnlySymbols?: Set<string>
  /**
   * Per-symbol decision sink。HOLD / BUY / SELL / SKIP / REJECT / ERROR の各
   * route で 1 回ずつ呼ばれる。実装は D1 INSERT が典型 (#128)、テストは fake
   * 注入可能。呼び出し側が失敗を throw しないのが前提 (logging failure isolation)。
   */
  onDecision?: (record: {
    symbol: string
    decision: StrategyDecision
    reason?: string
    price?: number
    indicatorsJson?: string
    /** BUY/SELL 成立時のみ設定。dashboard が trade_journal と JOIN する key (#143)。 */
    clientOrderId?: string
    trace?: DecisionTraceStep[]
  }) => Promise<void> | void
  /**
   * cron fire 単位の correlation id。emit 失敗時の構造化ログに含めることで
   * 「どの run で decision sink が落ちたか」を tail から追えるようにする
   * (CodeRabbit #132 follow-up)。runStrategyCron が scheduled() handler の
   * `crypto.randomUUID()` を渡す。
   */
  requestId?: string
  /**
   * Slack/Discord webhook 通知用 sink (#199)。BUY/SELL emit 時と cron error 時に
   * fire-and-forget で叩く。実装は失敗を握りつぶす責務 (silent fallback) なので
   * scheduler 側は `.catch()` を付けるだけで cron を blocking しない。
   */
  notifier?: Notifier
  /**
   * Per-symbol risk gate config (issue #138 — TradingService と unify)。未指定で
   * cron 経路を無 gate のままにできるよう、deps すべてが有効値なら gate 適用、
   * 一つでも欠けると skip にして既存挙動を保つ (POC 後方互換)。production
   * (`runStrategyCron`) は global_config / symbolUniverse から fully populate する。
   */
  perSymbolRisk?: PerSymbolRiskScheduleConfig
  /**
   * Webull SELL_QTY_EXCEED fallback resolver。SELL submit が
   * `OAUTH_OPENAPI_SELL_QTY_EXCEED_AVAILABLE_QTY` (HTTP 417) で reject
   * された時に呼ばれる: broker portfolio から実 available qty を返し、
   * `available > 0 && available < intent.quantity` なら scheduler が
   * 全部売りで再 submit する (= 辻褄合わせ)。失敗時は throw でも null
   * 返却でも OK で、いずれの場合も元 SELL_QTY_EXCEED エラーが re-throw
   * される (fail-closed)。production (`runStrategyCron`) は
   * `WebullHttpClient.getPositions()` でラップして注入する。未注入なら
   * fallback は skip (= 既存挙動の元 error 再 throw、POC 後方互換)。
   *
   * Race window: getAvailableQty と SELL submit の間で broker side が
   * 動く可能性は POC 段階では許容。連続 reject は次の cron tick で
   * 再評価される。
   */
  sellFallback?: SellFallbackConfig
  /**
   * Earnings calendar gate (issue #196 1/3)。±N 営業日で BUY を凍結。
   * `repo` 未注入なら gate skip (POC 後方互換)。production
   * (`runStrategyCron`) が D1 から repo を作って渡す。
   */
  earningsGate?: EarningsScheduleConfig
  /**
   * Macro event gate (issue #196 2/3)。FOMC / CPI / NFP 等の発表 ±N 時間で
   * 全銘柄 BUY を凍結。`repo` 未注入なら skip (POC 後方互換)。earnings gate
   * より後ろで評価される (両方 reject なら earnings reason が先に確定する)。
   */
  macroEventGate?: MacroEventScheduleConfig
  /**
   * VIX regime filter decision (issue #196 3/3)。caller (`runStrategyCron`) が
   * cron tick 起動時に `^VIX` を fetch し `evaluateVixRegime` を呼んで作る。
   * scheduler は decision を受け取って:
   *   - sizeScale === 0 (critical): BUY 全 reject (reason: `risk: vix_critical: ...`)
   *   - 0 < sizeScale < 1 (warning): `intent.quantity = floor(qty * sizeScale)`
   *   - sizeScale === 1 (normal / unavailable): no-op
   * 未注入なら skip (POC 後方互換)。SELL は VIX 関係なく通す。
   */
  vixDecision?: VixRegimeFilterDecision
  /**
   * News shock gate decision (issue #196 follow-up, news-shock-gate PR 2)。
   * caller (`runStrategyCron`) が cron tick 起動時に `attention_observation`
   * を D1 read して `evaluateNewsShockGate` を呼んで作る。`mode` は
   * `global_config.news_shock_mode` ('off' は caller がこの option ごと省略する
   * ので scheduler 側では扱わない):
   *   - 'enforce': VIX と同じ scaling を適用 (critical で BUY 全 reject /
   *     warning で `intent.quantity` を縮小)。VIX と乗算チェーンで合成される
   *     (`vixScale` を先に適用した後の qty に対して news scale を適用)。
   *   - 'observe': sizeScale を 1.0 に強制 (qty は変えない) しつつ、
   *     `traceStep('risk.news_shock', ...)` に reason を残すだけ (shadow mode)。
   * 未注入なら skip (POC 後方互換)。SELL は news shock 関係なく通す。
   */
  newsShockGate?: {
    mode: 'observe' | 'enforce'
    decision: NewsShockGateDecision
  }
  /**
   * Extended-hours (pre-market) gate (issue #709 Phase 6)。caller
   * (`runStrategyCron`) が cron tick 起動時に `extended_hours_observation`
   * (Phase 1 producer) を D1 read し `loadExtendedHoursGateDecisions` を呼んで
   * 作る、symbol (大文字) → decision の Map。VIX / news shock と異なり
   * **symbol ごと**の decision であり、Map に無い symbol は no-op (= 従来挙動、
   * trace にも出ない)。`mode` は `global_config.extended_hours_gate_mode`
   * ('off' は caller がこの option ごと省略するので scheduler 側では扱わない):
   *   - 'enforce': `action='block_entry'` で BUY 全 reject / `action='reduce_entry'`
   *     で `intent.quantity` を `multiplier` 倍に縮小 (VIX / news shock と同じ
   *     乗算チェーンの最後に適用)。
   *   - 'observe': qty は変えず、`traceStep('risk.extended_hours', ...)` に
   *     reason を残すだけ (shadow mode)。
   * 未注入 / 対象 symbol の decision なしなら skip (POC 後方互換)。SELL は
   * extended hours gate 関係なく通す (issue #709: Yahoo 時間外データ単独では
   * SELL しない)。
   */
  extendedHoursGate?: {
    mode: 'observe' | 'enforce'
    decisions: Map<string, ExtendedHoursGateDecision>
  }
  /**
   * Entry 抑止 symbol → 理由 (#452)。role が entry 無効 (cash_parking / 定義のみ
   * の role / enum 外 'unknown') の銘柄の BUY を SKIP する。SELL / HOLD は
   * 対象外 (exit 経路を妨げない)。未注入なら skip (POC 後方互換)。production
   * (`runStrategyCron`) は `buildEntrySuppressedSymbols` の結果を渡す。
   */
  entrySuppressedSymbols?: Record<string, string>
  /**
   * 売買コスト見積り (#trade-cost)。TRADE 通知の realized PnL を net 化する。
   * 未注入なら 0 (= gross)。永続化される realized は `reconcileFills` 側が
   * 同じ設定で計算する。
   */
  tradeCost?: TradeCostConfig
  /**
   * baseline ATR の作り方 (#atr-baseline-window)。未注入は 'percentile'
   * (実測で最良)。production は global_config 経由で渡る。
   */
  atrBaselineMode?: AtrBaselineMode
  /**
   * ペアレジーム layer (#472)。mode='observe' は zone/score を trace に残すだけ
   * (gate しない)、'enforce' は zone が許可しない側の BUY を SKIP し、保有と
   * 反対 zone への flip で SELL (regime_flip) を出す。未注入 = 従来挙動。
   * production (`runStrategyCron`) は global_config + inverse_pairs から組む。
   */
  pairRegime?: {
    mode: 'observe' | 'enforce'
    thresholds: PairRegimeThresholds
    pairs: PairRegimeEntry[]
  }
  /**
   * 段階判定 HALF (0.5x entry) を有効にする symbol 集合 (#452 PR 2)。role が
   * entry 有効 (core_trend / leveraged_trend) な銘柄のみ。**未注入 / 集合外の
   * 銘柄は従来の二値挙動 (HALF なし)** — role NULL の既存銘柄の挙動を変えない
   * (#452 受け入れ条件)。production (`runStrategyCron`) は
   * `buildHalfEntrySymbols` の結果を渡す。
   */
  halfEntrySymbols?: Set<string>
  /**
   * 条件連動配分の cash rebalance 数量 (#452 Layer 3)。runStrategyCron が
   * pass 1 (通常評価) の entrySnapshots から allocation を計算し、退避先 /
   * always_active 銘柄の不足分 BUY 数量を pass 2 でこの map に入れて呼ぶ。
   * 指定 symbol は **pullback 戦略判定と sizing を bypass** して固定数量の
   * BUY intent を作る — ただし下流の gate (lot fail-closed / per-symbol risk /
   * buying-power / pending lock / execution の DRY_RUN) は全部通る。
   * 未注入なら従来挙動。`cash_fallback_orders_enabled` (default false) が
   * off の間は runStrategyCron がこの map を渡さない。
   */
  cashRebalanceQuantityMap?: Record<string, number>
  /**
   * TICKER_IS_DENY 自動停止 hook (#460)。BUY submit が Webull の銘柄単位の
   * 恒久拒否 (`OAUTH_OPENAPI_TICKER_IS_DENY`) で失敗したとき、該当 symbol を
   * 引数に 1 回呼ばれる。production (`runStrategyCron`) は
   * `createTickerDenyGuard` (symbol_config の自動 inactive 化 + audit + 通知)
   * を注入する。未注入なら従来挙動 (毎 tick 再送)。hook 内の失敗は hook 側で
   * 握りつぶす契約 (scheduler は await するだけ)。SELL では呼ばない — 万一
   * exit 側で deny が出ても銘柄を評価対象から外すと保有が orphan になるため。
   */
  onTickerDeny?: (symbol: string) => Promise<void>
  /**
   * sanity_failed cooldown gate。直近 N 分以内に同 symbol で broker stub
   * fill (`resolveFilledPrice` が ratio guard で reject した) が観測されて
   * いた場合、新規 BUY を block する。9697 04/28 incident (30 min/6 fills 累積、
   * DO null のまま broker 側 600 株疑い) の再発防止 fail-closed gate。
   *
   * 未注入なら skip (POC 後方互換)。SELL は対象外 (= broker stub では起きない、
   * exit 経路を妨げないため)。
   */
  sanityFailedCooldown?: SanityFailedCooldownConfig
  /**
   * intraday 60m bar の最大許容鮮度 (ms)。BUY 判断価格として
   * intraday bar を使う場合のみ意味を持つ (= `barClient.getIntradayBars` を
   * 実装した client でのみ評価する — 未実装 client は従来どおり無 gate)。
   * bar の `timestamp` は足の**始値時刻**なので、最新足は常に「取得時刻 -
   * timestamp ≤ 60分」になる。default 2h はそれに provider 遅延分の余裕を
   * 足した値 — 60分ぴったりを閾値にすると正常系の bar が誤検知で reject
   * される。SELL には適用しない (fail-closed を entry 側だけに閉じる)。
   */
  intradayBarMaxAgeMs?: number
  now?: () => Date
}

interface SanityFailedCooldownConfig {
  /**
   * `symbol` (大文字) について、直近 `withinMs` 内に sanity_failed 系の
   * trade_journal row があるかを返す predicate。production は
   * `hasRecentSanityFailure(env.DB, ...)` で wrap、test は fake で注入する。
   * throw した場合は fail-closed (= cooldown 有効扱い) で BUY を reject。
   */
  check: (symbol: string) => Promise<boolean>
  /**
   * Operator 視認用の窓幅 (ms)。reject reason 文字列に埋め込むだけで、
   * 実際の cutoff は `check` 実装側が持つ (= 1 source of truth)。
   */
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
  /**
   * Gate config (freeze hours / full-day fallback)。Partial で渡せて、
   * 未指定の field は `DEFAULT_MACRO_GATE_CONFIG` (発表前 1h / 発表後 6h /
   * full-day=true) で補う。
   */
  config?: Partial<MacroEventGateConfig>
}

interface PerSymbolRiskScheduleConfig {
  /**
   * BUY symbol → inverse symbol map。production は symbol_universe.inversePairs。
   * 大文字 key 前提で渡す。
   */
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
  /**
   * One JSON-copyable record per symbol decision. This mirrors
   * strategy_decision_log so a single cron run can be analyzed without
   * reconstructing context from scattered log lines.
   */
  decisions: PullbackDecisionTrace[]
  /**
   * 条件連動配分 (#452 Layer 3) 用の per-symbol 観測値。評価が成立した
   * symbol のみ (bars 不足 / ERROR は不在 = 下流が fail-closed に扱う)。
   * 段階判定 / 評価価格 / 保有数量を runStrategyCron の allocation 計算に渡す。
   */
  entrySnapshots: Record<string, EntrySnapshot>
  /**
   * VIX regime filter decision applied to this run (issue #196 3/3)。
   * `vixDecision` option を渡された時のみ set される (POC 後方互換)。
   * cron summary log / dashboard で「この run でどの regime で動いていたか」
   * を可視化するために残す。
   */
  vix?: VixRegimeFilterDecision
  /**
   * News shock gate decision applied to this run (news-shock-gate PR 2)。
   * `newsShockGate` option を渡された時のみ set される (POC 後方互換)。
   * cron summary log / dashboard で「この run でどの regime で動いていたか」
   * を可視化するために残す。
   */
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
  // intraday bar 対応 client かどうかは実行全体で 1 回だけ
  // 決まる (client capability であって per-symbol の話ではない)。未対応 client
  // (Webull 等) は従来どおり無 gate。
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

  // Notifier helper: fire-and-forget。Notifier 実装側で silent fallback する
  // 約束だが、念のため二重 catch して cron を絶対に落とさない (#199)。
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

  // ペアレジーム評価 (#472): ペア単位で 1 回だけ proxy bars を独立 fetch して
  // zone を決め、symbol → {decision, side} に展開する。fetch/評価の失敗は
  // ペア単位で unknown に隔離 (= enforce では両側 BUY block) — cron は落とさない。
  const regimeBySymbol = new Map<
    string,
    { decision: PairRegimeDecision; side: 'bull' | 'bear' }
  >()
  if (options.pairRegime) {
    const runSymbols = new Set(options.symbols.map((s) => s.toUpperCase()))
    const relevant = options.pairRegime.pairs.filter(
      (p) => runSymbols.has(p.bullSymbol) || runSymbols.has(p.bearSymbol),
    )
    // 評価は並列、Map への反映は**評価完了後に設定順で決定的に**行う
    // (CodeRabbit #473: async 完了順の set は重複 symbol で run ごとに揺れる)。
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

  // 保有中 symbol の qty (state read 失敗は 0 = flat 扱いへ
  // fail-safe — 二重障害を新規分岐で拡大しない)。bar 取得失敗 / insufficient
  // bars で indicators が作れない 2 箇所から共通で使う。
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
      // Daily と intraday は別エンドポイント。並行で叩いて intraday 失敗は
      // null fallback (= daily close 採用、既存挙動と等価)。daily は 1 回だけ
      // retry する (upstream の一時的な障害で held position
      // の exit 判定が丸ごと飛ぶのを避ける) — それでも失敗すれば致命
      // (indicators が出ない) なので throw のまま。
      const intradayP = options.barClient.getIntradayBars
        ? options.barClient.getIntradayBars(symbol, '60m').catch(() => [])
        : Promise.resolve([])
      const dailyBars = await fetchDailyBarsWithRetry(options.barClient, symbol, lookback)
      const intradayBars = await intradayP
      bars = dailyBars
      // 最新 1h bar の close を fill 価格として使う。chart UI も同じ
      // intraday endpoint を見ているので BUY pin と candle がズレない。
      const lastIntraday = intradayBars[intradayBars.length - 1]
      lastIntradayBar = lastIntraday ?? null
      intradayPrice = lastIntraday ? lastIntraday.close : null
    } catch (error) {
      // flat なら従来どおり ERROR。保有が残っていれば
      // 「exit 判定が飛んだ」ことを明示する reason + notifier cause に差し替え、
      // 保有を無防備なまま放置しない (SELL の degrade は絶対にしない)。flat の
      // `summary.errors` メッセージ形式は既存挙動のまま (prefix なし)。
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

    const indicators = computePullbackIndicators(bars, intradayPrice, {
      baselineMode: options.atrBaselineMode ?? 'percentile',
    })
    if (!indicators) {
      // bar fetch throw 分岐と同じ扱い — flat は従来の SKIP、
      // 保有が残っていれば exit 判定が飛んだことを明示する ERROR にする。
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

    const state = await options.positionStore.getState(upper)
    const market = inferTradingMarket(upper)
    const holdBusinessDays =
      state.position !== null
        ? computeHoldBusinessDays(state.position.openedAt, now(), market)
        : 0

    // 条件連動配分 (#452 Layer 3) 用の観測値。判定そのものには使わず、
    // runStrategyCron が run 後に target/active weight を計算する材料。
    summary.entrySnapshots[upper] = {
      status: deriveEntryStatusFromIndicators(indicators, strategy.resolveRule(upper)).status,
      price: indicators.price,
      heldQty:
        state.position !== null && Number.isFinite(state.position.qty) && state.position.qty > 0
          ? state.position.qty
          : 0,
    }

    // #momentum: momentum ロールの symbol は BreakoutMomentumStrategy で判定。
    // signal の形は同じで、以降の lot / risk / buying-power / pending / DRY_RUN
    // execution は通常 BUY/SELL と全く同じ経路を通る (= 通常ロールと同じ動き)。
    const useMomentum = !!(options.momentumStrategy && options.momentumSymbols?.has(upper))
    const decider = useMomentum ? options.momentumStrategy! : strategy
    // #reentry: flat のときだけ前回手仕舞い情報を渡す。以前は「flat なら直近
    // fill は保有を閉じた SELL のはず」という推論で lastExecutedPrice を流用
    // していたが、syncHoldings 経由の overridePosition (broker 側清算 / 手動
    // override) は position だけ null 化するためこの不変条件が壊れ、
    // lastExecutedPrice に古い BUY 価格が残ったままガード基準になり得た。
    // lastExitPrice は recordFill が SELL でクローズしたときだけ明示的に
    // 刻む専用フィールドなので、それを直接参照する (#660)。lastExecutedPrice
    // へのフォールバックは意図的に入れない (不健全な推論の再導入になるため)。
    // lastExitAt (#582 で先行導入済) と lastExitPrice (本フィールド) は導入
    // 時期が異なるため、旧 state は「lastExitAt はあるが lastExitPrice が
    // 無い」移行期を経る。その間はガード窓内である限り
    // PullbackUptrendStrategy.entryDecision 側が fail-closed (価格不明で
    // entry 保留) する — lastExitAt 由来の businessDaysSinceExit だけは
    // ここで渡すので、窓経過後は自然に fail-open へ戻る。lastExitAt も無い
    // (一度も exit していない) 銘柄は従来どおり無条件で通す。
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

    // 判断価格の出所・時刻を全 decision の trace 先頭に残す
    // (SKIP/HOLD/ERROR 含む、indicators が存在する以降の全経路)。stale price
    // 調査時に「どの bar を見て判断したか」を trace だけで追えるようにする。
    const priceAsOfSource = lastIntradayBar !== null ? 'intraday_60m' : 'daily_close'
    const priceAsOfValue =
      lastIntradayBar !== null ? lastIntradayBar.timestamp : (bars[bars.length - 1]?.date ?? 'unknown')
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

    // intraday bar 対応 client (`getIntradayBars` 実装済み) で
    // 鮮度が確認できない BUY 判断価格は SKIP する (SELL は対象外、fail-closed を
    // entry 側だけに閉じる)。「確認できない」は 3 パターン: intraday bar が
    // そもそも 0 件 (fallback 先の daily close は BUY には採用しない) / 最新
    // bar の timestamp が鮮度上限を超過 / timestamp が parse 不能 (Date.parse
    // が NaN → NaN との比較は常に false になり素通りしてしまうため明示チェック)。
    let priceFreshnessFailure: string | null = null
    if (intradayAttempted) {
      if (lastIntradayBar === null) {
        priceFreshnessFailure =
          'stale price: intraday bar unavailable, daily close fallback not accepted for BUY'
      } else {
        const asOfMs = Date.parse(lastIntradayBar.timestamp)
        const ageMs = now().getTime() - asOfMs
        if (!Number.isFinite(asOfMs) || ageMs > intradayBarMaxAgeMs) {
          priceFreshnessFailure = `stale price: intraday_60m as of ${lastIntradayBar.timestamp} exceeds ${intradayBarMaxAgeMs}ms`
        }
      }
    }

    // cash rebalance (#452 Layer 3 pass 2): 指定数量の BUY に置き換える。
    // pending order 中は strategy の HOLD (pending guard) をそのまま残す。
    // strategy exit (SELL) / cooldown / re-entry guard は迂回させない —
    // これを外すと time-stop 等で SELL した直後に同ティックで cash
    // rebalance が買い戻す whipsaw が起きる (ICLN 8/18, VUG 8/25, ICLN 9/1 実績)。
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

    // #intraday-only: レバ ETF 等は US 引け前 window で保有があれば strategy 判定を
    // 上書きして強制 SELL (オーバーナイト持ち越し禁止 = 寄りギャップ stop-out 回避)。
    // 既存の SELL 経路 (全保有クローズ) に流れる。US 銘柄のみ対象。
    if (
      options.intradayOnlySymbols?.has(upper) &&
      market === 'US' &&
      state.position !== null &&
      Number.isFinite(state.position.qty) &&
      state.position.qty > 0 &&
      isWithinUsCloseWindow(now(), INTRADAY_CLOSE_WINDOW_MIN)
    ) {
      // symbol/quantity/price/generatedAtIso は元 signal を流用 (SELL 経路は
      // state.position.qty / indicators.price で再計算するので値は不問)。
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

    // ペアレジーム (#472): zone/score を全評価の trace に残す (HOLD 含む —
    // observe 期間の監査が目的なので BUY/SKIP 時だけでは足りない)。
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
      // regime_flip exit (#472 §3a): 保有と**反対 zone** に flip したら全量 SELL。
      // 既存 exit (stop/TP/time-stop) が先に SELL を出していればそれが優先 —
      // その場合は副次理由として trace にだけ残す (効果測定用、review #4)。
      // neutral では強制 exit しない (hysteresis 内の正常な押しで降ろさない)。
      const flipped =
        (regime.side === 'bull' && d.zone === 'bear') || (regime.side === 'bear' && d.zone === 'bull')
      if (options.pairRegime.mode === 'enforce' && held && flipped) {
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

    // 段階判定 HALF (#658: strategy 申告 holdCause の一方向フロー)。旧実装は
    // strategy の HOLD 理由を知らずに deriveEntryStatusFromIndicators で entry
    // status を再導出して昇格判定していたため、再エントリー価格ガード
    // (entry.reentry_below_last_exit — entryDistance.ts の EntryGateKey には
    // 存在しない) 由来の HOLD を指標だけ見て BUY (0.5x) に昇格させてしまった
    // (実害: 2026-07-29 SQQQ)。再エントリーガードは構造的に 7 gate 集合に無い
    // ため、再導出では検知不能だった。
    //
    // 対処: strategy が HOLD の原因 (`holdCause`) と、entry_gate 由来なら 4 段階
    // 判定スナップショット (`entryStatus`) を Signal に申告し、scheduler は
    // **再計算しない** (情報フローの一方向化)。HALF が緩めてよいのは「setup の
    // 質」を測る entry gate だけ — position / pendingOrder / cooldown / 再エント
    // リーのような「行動可否」guard は絶対 veto であり、holdCause が
    // 'entry_gate' でなければこのブロックに入らない。
    let positionMultiplier = 1
    const entryStatus = signal.entryStatus
    if (
      signal.action === 'HOLD' &&
      signal.holdCause === 'entry_gate' &&
      options.halfEntrySymbols?.has(upper) &&
      entryStatus?.status === 'HALF' &&
      entryStatus.halfGate !== null &&
      // holdCause==='entry_gate' なら strategy 側で position/pendingOrder/
      // cooldown が全て非活性であることは既に保証されている (entryDecision は
      // guard 通過後にしか呼ばれない)。以下 3 条件はその不変条件に対する
      // belt-and-suspenders アサーション (将来の strategy 実装ミスへの二次防御)
      // であり、一次判定はあくまで holdCause。
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
            // EntryGateStatus.operator は人間可読 string だが、ここに来る
            // degree gate は '<=' / '>=' のみ (DecisionTraceStep の union 内)。
            gate.operator === '>=' ? '>=' : '<=',
            gate.threshold,
            'HALF: single degree-gate miss within tolerance → 0.5x sizing (#452)',
          ),
        ),
      }
    }

    // intraday-only 銘柄はオーバーナイト持ち越しを防ぐために存在するので、
    // force-close window に飲み込まれる直前 (30分) の新規 BUY も止める — HALF
    // 昇格ブロックの後にこれを置くのが必須: 昇格前に置くと、まだ HOLD の
    // signal.action を見て veto が不発のまま通過し、直後の HALF 昇格が
    // veto 済みの entry_gate HOLD を BUY へ戻してしまう (intradayOnlySymbols と
    // halfEntrySymbols の両方に属する銘柄で発生)。cash rebalance による BUY も
    // 同様にここで最終判定を受ける。
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

    // ペアレジーム BUY gate (#472、enforce のみ): zone が許可しない側の entry を
    // SKIP。SELL / exit は一切妨げない。zone permits, gates decide — ここを
    // 通っても以降の全 gate (role / sizing / risk / 余力) は従来どおり評価される。
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

    // Entry 抑止 role gate (#452)。cash_parking / 定義のみの role / enum 外の
    // role 値の銘柄は BUY を生成しない (fail-closed)。SELL は対象外 — role を
    // 後から変えた銘柄の保有 exit (stop / time-stop / TP) を妨げない。
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

    // 価格鮮度ゲート (BUY のみ)。cash rebalance / HALF 昇格の
    // 後に評価する — どちらも「BUY にする理由」であって「価格が新鮮かどうか」
    // とは独立の判断だが、最終的に BUY として発注する前には必ず通す。
    // `priceFreshnessFailure` は decide() 直後 (このブロックのずっと上) で
    // signal と無関係に前計算済み — lastIntradayBar は cash rebalance / HALF
    // 昇格の影響を受けない。
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

    // sanity_failed cooldown gate (incident: 9697 04/28 で 30 min / 6 BUY 累積、
    // DO null / broker 側 600 株疑い)。直近 N 分以内に同 symbol で broker stub
    // fill が観測されていれば新規 BUY を block する。SELL は対象外 (broker stub
    // では起きない、exit を妨げない)。signal.action === 'BUY' のみ評価し、
    // intent build / sizing 計算より前で短絡させる (= 不要な計算を避ける)。
    // check が throw した場合は fail-closed (= cooldown 有効扱い) — DB read
    // 失敗で BUY を通すと incident 再発リスクが残るため。
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
      // 売買単位は per-symbol map を優先。production (`runStrategyCron`) は常に
      // `symbolLotSizeMap` を渡す (空でも) ので、**map にあるのに該当 symbol が
      // 無い = lot_size 未設定 → fail-closed** (発注見送り、#symbol-lot-size)。
      // 誤った blanket lot で過大/過小発注しない。`symbolLotSizeMap` も
      // `lotSize` も一切渡さない legacy caller (旧 unit test 等) のみ従来の lot=1。
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
      // 銘柄別 cap (`symbolCapMap`) と global per-order cap (`maxOrderNotional`) を
      // min で合成する。片方だけ設定されていればそちらをそのまま使い、両方
      // 未設定なら undefined (無制限) — 既存の 1 銘柄 1 cap という
      // `computePullbackSizing` の契約を変えず、呼び出し側で先に絞る。
      const perSymbolCap = options.symbolCapMap?.[upper]
      const globalOrderCap = options.maxOrderNotional
      const effectiveSymbolCap =
        perSymbolCap !== undefined && globalOrderCap !== undefined
          ? Math.min(perSymbolCap, globalOrderCap)
          : (perSymbolCap ?? globalOrderCap)
      // cash rebalance (#452): 数量は runStrategyCron が allocation 差分から
      // 計算済み (cap / lot 適用済み)。pullback sizing は通さず、lot 整合だけ
      // 再確認する (lot 倍数でなければ floor、0 になれば下の reject で見送り)。
      // ただし global per-order cap は plan 計算後に変わり得るので、ここでも
      // 二重適用する (「cron BUY notional が cap を超えない」という不変条件を
      // rebalance 経路にも及ぼす)。
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
              // #stop-rr-cap: sizing と exit で同じ stop 幅を使う。
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
      // 段階判定 HALF の 0.5x (#452 PR 2) — sizing 直後・VIX scale より前に適用。
      // VIX warning と重なった場合は乗算で両方効く (より保守的な側に倒れる)。
      // lot 丸めで 0 になったら reject (= 部分 entry すらできない小口は見送り)。
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
      // VIX regime filter (issue #196 3/3) — sizing 直後に適用。
      //   - critical (sizeScale === 0): BUY 全 reject
      //   - warning (0 < sizeScale < 1): qty = floor(qty * sizeScale / lot) * lot
      //   - normal (sizeScale === 1): no-op
      // SELL は VIX 関係なく通すため、ここで scaling しても OK (BUY 経路だけ)。
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
          // warning: qty を `floor(qty * scale / lot) * lot` で lot に揃える。
          // lot=1 の US 株は単純な floor、lot=100 の JP 株は単元未満で 0 になり得る。
          // 結果が 0 になった場合は次の `scaledQuantity <= 0` reject で拾う。
          // half-entry 適用後の qty を基数にする (#452: 0.5x と VIX scale は乗算)。
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
      // News shock gate (news-shock-gate PR 2) — VIX と乗算チェーンで合成
      // (finalScale = vixScale × newsShockScale)。VIX 適用後の qty を基数にして
      // 続けて scale するため、既に VIX で 0 に丸まっていればこのブロックへは
      // 到達しない (上の `continue` で抜けている)。SELL はこのブロックの外
      // (signal.action === 'BUY' の中) なので関係なく通る。
      if (options.newsShockGate) {
        const newsDecision = options.newsShockGate.decision
        const isObserve = options.newsShockGate.mode === 'observe'
        // observe は shadow mode — 実際の qty には一切効かせず、trace にだけ
        // 「enforce だったら何が起きたか」を残す (`pairRegime` observe 分岐と同じ設計)。
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
      // Extended-hours (pre-market) gate (issue #709 Phase 6) — VIX / news shock
      // と同じ乗算チェーンの最後に適用。symbol ごとの Map なので対象銘柄の
      // decision が無ければ no-op (trace にも出ない)。decision が Map にある
      // 時点で WARNING/STOP_AT_OPEN_CANDIDATE 確定 (NORMAL/UNKNOWN は呼び出し側
      // `loadExtendedHoursGateDecisions` が含めない) なので **observe / enforce
      // 問わず常に trace を残す** — news shock の enforce-reduce 成功時 (qty>0
      // まで縮小できた) には trace を残さない既存挙動とは異なり、この gate は
      // 「今朝この銘柄に警戒シグナルがあった」という運用可視性を optional
      // narrowing なしで一貫させる (#709 Phase 6 設計)。
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
      intent = buildIntent(upper, 'SELL', state.position.qty, indicators.price)
    }

    // Earnings calendar gate (issue #196 1/3)。BUY の場合のみ評価し、
    // ±N 営業日内に earnings_calendar 行があれば reject。SELL は撤退路を
    // 妨げないよう gate 対象外。`earningsGate` 未注入なら skip (POC 後方互換)。
    // perSymbolRisk より先に評価することで、broker / spread 系より上位の
    // 「そもそもエントリしない」判断として cron 経路から見える。
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

    // Macro event gate (issue #196 2/3)。FOMC / CPI / NFP 等の発表 ±N 時間
    // (default 1h) は全銘柄 BUY を凍結する。earnings gate より後で評価する
    // ので、両方 reject なら earnings reason が先に確定する (task 指定の
    // 優先順位)。`macroEventGate` 未注入なら skip (POC 後方互換)。
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

    // Per-symbol risk gate (issue #138)。manual `/trade/execute` (TradingService)
    // と同じ pure function を呼ぶことで gate parity を取る。perSymbolRisk が
    // 未注入の場合は POC 後方互換で skip。Inverse pair の SymbolState は同期
    // pure 関数で要求されるため、BUY のみ事前 fetch する。
    if (options.perSymbolRisk) {
      let inverseState: SymbolState | null = null
      const inverseSymbol =
        intent.side === 'BUY' ? options.perSymbolRisk.inversePairs[upper] : undefined
      if (inverseSymbol) {
        try {
          inverseState = await options.positionStore.getState(inverseSymbol)
        } catch {
          // fetch 失敗は inverse gate fail-open。inverse 銘柄の state read 失敗
          // で BUY ごと止めると universe 全体が連鎖 reject になり得るため、
          // 他の gate (settled cash / spread / freshness など) に任せる。
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
          // 発生し得る — ここで評価しないと cooldown 中の再購入を止められない。
          // SELL は評価対象外 (gate 1 が side 非依存のため、BUY のみに絞って
          // exit を cooldown で block しないようにする)。
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

    // #415: 買付余力 pool ゲート (BUY only)。notional を JPY 換算して共有台帳の残余力と
    // 突き合わせ、unavailable / 不足は pre-trade で reject (Webull 417 をローカル先回り)。
    // 減算は約定成立後 (loop は逐次なので check→commit で整合)。SELL/exit は対象外。
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

    // portfolio 全体エクスポージャー上限ゲート (BUY only)。
    // 買付余力 pool ゲートと同じ形 (JPY 換算 → 共有台帳の残枠と突き合わせ、
    // unavailable / 超過は pre-trade で reject)。SELL/exit は対象外。
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

    // Journal the pre_submit so reconcileFills (which scans
    // trade_journal.post_submit with broker_status IS NULL) can pick up
    // the cron-placed order. Without this, cron orders bypass the
    // journal entirely and are invisible to reconcile.
    //
    // Logging is isolated in its own try/catch — if the logger sink
    // (D1 write) throws, we must still proceed to execute + release
    // the pending lock, otherwise the lock leaks and the symbol gets
    // stuck.
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
      // SELL_QTY_EXCEED fallback: Webull rejected the SELL because qty >
      // broker-side `quantity_available`. This usually means DO state has
      // drifted above broker truth (#215 reconcile race). Fetch the actual
      // available qty and retry the SELL with that — i.e. close out
      // whatever the broker actually still holds, so the next cron tick
      // sees a clean slate. If anything in the fallback fails, re-throw
      // the original error path (no silent recovery).
      const fallbackResult =
        intent.side === 'SELL' && options.sellFallback && isSellQtyExceedError(error)
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
        // broker 4xx = 注文の**確定拒否** (417 SELL_SHORT / TICKER_IS_DENY /
        // Insufficient Buying Power 等、再送しても解消しない) → REJECT。
        // 429 (rate limit) は再送で解消しうる一時的失敗なので除外して ERROR。
        // それ以外 (5xx / ネットワーク断 / 非 BrokerRequestError 例外) も
        // 原因不明・一時的として ERROR のまま。
        const brokerStatus = error instanceof BrokerRequestError ? error.brokerStatus : undefined
        const isBrokerReject =
          brokerStatus !== undefined && brokerStatus >= 400 && brokerStatus < 500 && brokerStatus !== 429
        await emitDecision({
          symbol: upper,
          decision: isBrokerReject ? 'REJECT' : 'ERROR',
          // DB には英語 canonical で保存。表示層 (localizeReason) で日本語化。
          // localize は `^broker submit error: ` を prefix match するので、発注内容
          // (何口 / $ と ¥) は **message の後ろ**に付けて prefix を壊さない (#417)。
          reason: `broker submit error: ${messageOf(error)} [${describeOrderAmount(intent, options.fxJpyPerSymbolCcy)}]`,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('broker.submit', false, messageOf(error), '==', 'submitted')),
        })
        emitNotify({
          type: 'ERROR',
          symbol: upper,
          message: messageOf(error),
          // surge detector が cause で count するため (#209)、broker submit
          // failure を 4xx / 429 / 5xx / other に分類する。`null` (= broker
          // error ではない) なら legacy の `'broker submit'` に戻す。
          cause: classifyBrokerErrorCause(error) ?? 'broker submit',
        })
        // TICKER_IS_DENY 自動停止 (#460): 銘柄単位の恒久拒否は再送しても解消
        // しないので、BUY のみ hook で fail-closed に停止する (SELL は対象外 —
        // exit 経路と保有の orphan 化を避ける)。
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

    // SELL_QTY_EXCEED fallback succeeded → DO state currently lies above
    // broker truth (the very reason we hit the fallback). Force-reset
    // `position=null` so the next cron tick doesn't try to SELL phantom
    // shares again. We deliberately bypass `recordFill` here because the
    // executed qty < DO qty would leave a non-zero remainder.
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
      // #415: 約定した BUY 分の買付余力を共有台帳から減算 (次銘柄の pool 判定に反映)。
      options.buyingPower?.tryReserve(intent.notional * (options.fxJpyPerSymbolCcy ?? 1))
      // 同様にエクスポージャー上限の共有台帳からも減算。
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

    // SELL の realizedPnl は state.position.avgPrice (existing) と
    // executedIntent.price (exit) の差から推定。BUY 時は undefined。avgPrice
    // が無い SELL は不正経路 (上で reject 済) なので発生しないはずだが defensive。
    // fallback で qty が変わった場合も executedIntent.quantity を使うので
    // realized PnL は実 SELL 数量分のみ。
    // #trade-cost: 通知に出す realized も reconcile と同じ net にする
    // (片方 gross・片方 net だと突き合わせできない)。
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
 * Daily bar 取得を 1 回だけ retry する。upstream の一時的な
 * 障害 (タイムアウト等) をここで吸収しないと、保有中 symbol の exit 判定が
 * そのまま丸ごと飛ぶ。2 回とも失敗したら呼び出し側が「daily bar が使えない」
 * として扱う (2 回目の error をそのまま投げる)。
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
 * 発注しようとした数量・金額を「何口 / いくら」で人間可読に整形する (#417 follow-up)。
 * USD 銘柄 (fx>0 かつ !=1) は **$ と ¥ を併記** (notional × USD/JPY)、JPY 銘柄 (fx=1) は ¥、
 * fx 不明は通貨記号なし。decision log の reason に付けて 417 等の原因切り分けに使う。
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
 * Risk gate (VIX / news shock / half-entry) が共通で使う size scaling
 * (news-shock-gate PR 2 で抽出、以前は VIX warning ブロックと half-entry ブロックに
 * 同じ式が二重記述されていた)。`scale` 倍した raw qty を lot 単位に floor する:
 *   - lot > 1 (JP 単元株等): `floor(raw / lot) * lot`
 *   - lot === 1 (US 株等): `floor(raw)`
 * 結果が 0 になれば呼び出し側が reject する (= 部分 entry すらできない小口は見送り)。
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
