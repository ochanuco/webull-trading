import type { Env } from '../../config/env'
import { selectBarClient, type BarClient } from '../../infrastructure/quotes/BarClient'
import { loadUsdJpyRate } from '../../infrastructure/quotes/fxRate'
import type { WebullAccountBalanceDto } from '../../infrastructure/webull/dto'
import {
  buyingPowerJpyFromBalance,
  createBuyingPowerLedger,
  createUnavailableBuyingPowerLedger,
  type BuyingPowerLedger,
} from './buyingPower'
import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import type { SymbolCurrency } from '../../infrastructure/db/symbolConfigRepo'
import { notifyBrokerErrorSurgeIfChanged } from '../../infrastructure/notification/brokerErrorSurge'
import {
  detectAndNotifyConfigStateChanges,
  type WatchedConfig,
} from '../../infrastructure/notification/configStateChange'
import { createNotifier } from '../../infrastructure/notification/createNotifier'
import type { Notifier } from '../../infrastructure/notification/Notifier'
import { resolveAccessToken } from '../../infrastructure/webull/resolveAccessToken'
import { createWebullReadClient } from '../../infrastructure/webull/WebullReadClient'
import { createWebullTradeClient } from '../../infrastructure/webull/WebullTradeClient'
import { MockExecution } from '../execution/MockExecution'
import { WebullExecution } from '../execution/WebullExecution'
import { PortfolioStateClient } from '../state/PortfolioStateClient'
import { SymbolStateClient } from '../state/SymbolStateClient'
import { computeDrawdownRiskScale } from '../risk/drawdownRiskScale'
import {
  logStrategyDecision,
  strategyDecisionDbOrUndefined,
} from '../../infrastructure/logger/strategyDecisionLog'
import { hasRecentSanityFailure } from '../../infrastructure/db/tradeJournalRepo'
import {
  createEarningsCalendarDb,
  createEarningsCalendarRepo,
} from '../../infrastructure/calendar/earningsCalendarRepo'
import {
  createMacroEventCalendarDb,
  createMacroEventCalendarRepo,
} from '../../infrastructure/calendar/macroEventCalendarRepo'
import {
  evaluateVixRegime,
  type VixRegimeFilterDecision,
} from '../risk/vixRegimeFilter'
import { detectAndNotifyVixRegimeChange } from '../../infrastructure/notification/vixRegimeChange'
import { detectAndNotifyRegimeChange } from '../../infrastructure/notification/regimeChange'
import type { NewsShockGateDecision } from '../risk/newsShockGate'
import {
  buildNewsShockRegimeHeadline,
  isNewsShockGateReady,
  isNewsShockRegime,
  loadNewsShockDecision,
  NEWS_SHOCK_REGIME_RANK,
} from '../risk/newsShockDecision'
import { isExtendedHoursGateReady, loadExtendedHoursGateDecisions } from '../risk/extendedHoursGate'
import { resolveTradingEnabled } from '../runtime/killSwitch'
import { evaluateStrategyWindow, type StrategyWindowVerdict } from '../domain/tradingCalendar'
import { runPullbackScheduler, type PullbackDecisionTrace, type PullbackRunSummary } from './pullbackScheduler'
import { BreakoutMomentumStrategy, TEST_DEFAULT_MOMENTUM_RULE } from './strategies/BreakoutMomentumStrategy'
import {
  buildEntrySuppressedSymbols,
  buildHalfEntrySymbols,
  buildMomentumRules,
  buildMomentumSymbols,
  buildSymbolRules,
} from './symbolRuleResolution'
import { createTickerDenyGuard } from '../risk/tickerDenyGuard'
import { createDb as createSymbolConfigDb } from '../../infrastructure/db/tradeJournalRepo'
import {
  buildCashRebalancePlan,
  computeConditionalAllocation,
  type AllocationView,
  type CashRebalanceSkip,
  type EntrySnapshot,
} from './conditionalAllocation'

const DEFAULT_EQUITY_USD = 10_000
const DEFAULT_EQUITY_JPY = 1_500_000
// 売買単位は per-symbol (symbol_config.lot_size) で持つ。未設定銘柄は scheduler
// 側で fail-closed (発注見送り) — blanket default に倒さない (#symbol-lot-size)。

/**
 * sanity_failed cooldown window (ms)。直近この期間内に同 symbol で broker
 * stub fill が観測されていた場合、新規 BUY を block する。
 *
 * 30 分は経験則: 9697 04/28 incident で 5 min cron × 6 tick = 30 min かけて
 * 600 株疑い分まで累積した実例から、同様の連鎖を 1 cycle 以内で止める長さ。
 * tunable は別 PR で global_config 化想定 (POC 段階では hard-code)。
 */
const SANITY_FAILED_COOLDOWN_MS = 30 * 60 * 1000

/**
 * #session-window-gate: 開場の何分前から戦略評価を再開するか (分)。
 * `sessionWindowGateEnabled` が true の時のみ有効。窓 = [開場 - この値, 引け)。
 * POC 段階では `INTRADAY_CLOSE_WINDOW_MIN` と同様 hard-code (config 化は別 PR)。
 */
const PRE_OPEN_WINDOW_MIN = 30

export interface StrategyCronResult {
  summary: PullbackRunSummary
  symbols: string[]
  /**
   * Operator/AI analysis packet. Safe for logs: no broker secrets or raw
   * Webull payloads, only config/risk context and per-symbol decisions.
   */
  analysis: StrategyCronAnalysis
  /**
   * run 全体を評価せず抜けた理由。`portfolio_halted` / `drawdown_kill` は
   * #exit-only-halt 以降 **この経路では出ない** (entry のみ停止に変更)。
   * 既存の decision log / dashboard filter との互換のため union には残す。
   */
  skipReason?:
    | 'trading_disabled'
    | 'no_tradable_symbols'
    | 'outside_session_window'
    | 'market_holiday'
    | 'no_bridge_state'
    | 'portfolio_halted'
    | 'drawdown_kill'
  /**
   * #exit-only-halt: risk halt により **新規 entry のみ**停止した理由。
   * `skipReason` (= run 全体を skip) とは排他で、こちらが立っている run は
   * 保有の exit 判定を通常どおり実行している。
   */
  entryHaltReason?: string
}

interface StrategyCronAnalysis {
  schema: 'strategy_cron_analysis.v1'
  generatedAt: string
  requestId?: string
  config: {
    dryRun: boolean
    tradingEnabled: boolean
    pullbackRule: {
      stopPct: number
      takeProfitPct: number
      timeStopDays: number
      pullbackMax: number
      pullbackMin: number
      minReturn50d: number
      requireAboveSma50: boolean
      kAtr: number
      maxSma50DeviationPct: number
      maxAtrRatio: number
      maxStopToTpRatio: number
    }
    risk: {
      basePerTradePct: number
      scaledPerTradePct?: number
      ddHalfThreshold: number
      ddHaltThreshold: number
      drawdownKillThreshold: number
    }
  }
  universe: {
    symbols: string[]
    byCurrency: Record<SymbolCurrency, string[]>
    symbolMaxNotional: Record<string, number>
  }
  portfolio?: {
    dailyStartEquity: number
    dailyRealizedPnl: number
    tradingDisabledUntil: string | null
    lastRolledAt: string | null
    updatedAt: string
  }
  drawdownScale?: {
    step: 'normal' | 'half' | 'halt'
    scale: number
    drawdown: number
  }
  /**
   * #exit-only-halt: risk 由来の halt で **新規 entry だけ**を止めている状態。
   * 全銘柄が BUY 抑止され、exit (stop / TP / time-stop) は通常どおり評価される。
   * 未設定なら通常運転。
   */
  entryHalt?: { reason: string }
  /**
   * VIX regime decision (issue #196 3/3)。`^VIX` の最新値から導出。
   * cron tick で一度だけ算出し、両 currency run に同じ decision を渡す。
   */
  vix?: VixRegimeFilterDecision
  /**
   * News shock gate decision (news-shock-gate PR 2)。`global_config.news_shock_mode`
   * が 'off' か、`attention_observation` が未 migrate なら undefined
   * (= gate 自体を評価しない)。cron tick で一度だけ算出し、両 currency run に
   * 同じ decision を渡す (GDELT probe は銘柄非依存)。
   */
  newsShock?: NewsShockGateDecision
  runs: Array<{
    currency: SymbolCurrency
    equity: number
    symbols: string[]
  }>
  decisions: PullbackDecisionTrace[]
  /**
   * 条件連動配分 (#452 Layer 3)。target/active weight と退避の判定結果。
   * `cash_fallback_orders_enabled` が off でも**計算は常に行い**ここに残す
   * (判定・表示のみモード)。発注 plan は on の時のみ。
   */
  allocation?: {
    view: AllocationView
    ordersEnabled: boolean
    rebalanceSkipped?: CashRebalanceSkip[]
  }
}

/**
 * Cron-driven Pullback strategy entry。呼び出し側 (`src/index.ts`) は:
 *   1. global_config + symbol_universe を D1 から読む
 *   2. trading_enabled=0 / symbol 不在 / SYMBOL_STATE 未 bind なら skip
 *   3. PortfolioStateDO の kill-switch / drawdown を確認 (fail-closed)
 *   4. currency 毎に runPullbackScheduler を起動し summary を合算
 *
 * Risk gate のうち **portfolio-wide な pre-flight 判定** (tradingDisabledUntil
 * と drawdown_kill) は本関数で適用する。per-symbol gate (spread / halt / gap /
 * JP band / inverse_pair / settled_cash) は `evaluatePerSymbolRisk` を介して
 * `runPullbackScheduler` に注入し、TradingService と判定が一致するよう unify
 * 済み (issue #138)。
 *
 * JP 銘柄は 100 株ロットで round-down される。bar 取得は Yahoo Finance の
 * `<code>.T` サフィックス (YahooBarClient 内で自動付与)。
 */
export interface RunStrategyCronOptions {
  /** Correlation id for structured logs (from scheduled() handler). */
  requestId?: string
}

export async function runStrategyCron(
  env: Env,
  options: RunStrategyCronOptions = {},
): Promise<StrategyCronResult> {
  const emptySummary = (): PullbackRunSummary => ({
    evaluated: 0,
    buys: 0,
    sells: 0,
    holds: 0,
    rejected: [],
    errors: [],
    decisions: [],
    entrySnapshots: {},
  })

  const [global, universe] = await Promise.all([
    loadGlobalConfigFrom(env, options.requestId),
    loadSymbolUniverse(env),
  ])

  // env=false は deploy-gate override (#276)。DB が true でも env=false なら
  // 強制 OFF。より制限的な側が勝つ。
  const effectiveTradingEnabled = resolveTradingEnabled(global.tradingEnabled, env.TRADING_ENABLED)

  // Notifier は cron tick の最序盤で組み立てる: 後続の skipReason 通知や
  // state change 検知が同じ instance を使う (#141)。requestId を伝搬させる
  // ことで `notification_emit_log.request_id` に紐付く。
  const notifier = createNotifier(env, { requestId: options.requestId })

  // global_config の watched field 遷移を検知 (#141)。await して snapshot を
  // 確実に書き終えてから次の処理に進む — 1 cron tick 中に複数の通知 path が
  // STATE_CHANGE を出すと重複するので、ここで 1 回だけ走らせる。失敗しても
  // 内部で握りつぶされる (caller は気にしなくて良い)。
  const watchedNow: WatchedConfig = {
    dryRun: global.dryRun,
    // env override 適用後の effective 値で遷移を観測する (env=false override が
    // 効いた瞬間も STATE_CHANGE 通知できる、#276)。
    tradingEnabled: effectiveTradingEnabled,
    marketHoursCheck: global.marketHoursCheck,
    sessionWindowGateEnabled: global.sessionWindowGateEnabled,
    drawdownKillThreshold: global.drawdownKillThreshold,
  }
  await detectAndNotifyConfigStateChanges({
    db: env.DB,
    notifier,
    current: watchedNow,
    requestId: options.requestId,
  }).catch((err) => {
    console.warn(
      JSON.stringify({
        event: 'config_state_change_detect_failed',
        requestId: options.requestId,
        message: err instanceof Error ? err.message : String(err),
      }),
    )
  })

  // Broker 4xx/5xx/429 急増検知 (#209)。`notification_emit_log` を集計し、
  // surge 開始 / 解消の遷移時に 1 件 STATE_CHANGE 通知。env.DB が無いと
  // surge 検知は成立しないので skip。fail-silent で cron は止めない。
  if (env.DB) {
    await notifyBrokerErrorSurgeIfChanged({
      db: env.DB,
      notifier,
      requestId: options.requestId,
    }).catch((err) => {
      console.warn(
        JSON.stringify({
          event: 'broker_error_surge_detect_failed',
          requestId: options.requestId,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    })
  }

  const defaultRule = {
    stopPct: global.pullbackDefaultStopPct,
    takeProfitPct: global.pullbackDefaultTakeProfitPct,
    timeStopDays: global.pullbackDefaultTimeStopDays,
    pullbackMax: global.pullbackDefaultPullbackMax,
    pullbackMin: global.pullbackDefaultPullbackMin,
    minReturn50d: global.pullbackDefaultMinReturn50d,
    requireAboveSma50: global.pullbackDefaultRequireAboveSma50,
    kAtr: global.pullbackDefaultKAtr,
    maxSma50DeviationPct: global.pullbackDefaultMaxSma50DeviationPct,
    maxAtrRatio: global.pullbackDefaultMaxAtrRatio,
    maxStopToTpRatio: global.pullbackDefaultMaxStopToTpRatio,
    // #reentry: 再エントリー価格ガード。まだ global_config 列を持たせていないので
    // 定数 (前回売値 −1ATR / 3 営業日窓)。チューニングが要れば列/override 化。
    reentryMinAtrBelowLastExit: 1.0,
    reentryGuardBusinessDays: 3,
  }
  // Per-symbol rule map (#316 / #exit-atr / #452)。global default → role preset
  // → per-symbol override の順に重ねる。詳細と回帰保証は symbolRuleResolution.ts。
  const rulesMap = buildSymbolRules(defaultRule, universe)
  // Entry 抑止 role (#452): cash_parking / 定義のみの role / enum 外 'unknown' は
  // BUY を生成しない (SELL / HOLD の exit 経路は通す)。
  const entrySuppressedSymbols = buildEntrySuppressedSymbols(universe.symbolRole)
  // 段階判定 HALF (#452 PR 2): entry 有効 role を明示した銘柄のみ 0.5x entry を
  // 許可する。role NULL の既存銘柄は従来の二値挙動のまま。
  const halfEntrySymbols = buildHalfEntrySymbols(universe.symbolRole)
  // #momentum: role === 'momentum' の銘柄は BreakoutMomentumStrategy で判定する。
  // signal は以降の Risk→Execution を通常 BUY/SELL と同じ経路で通る。
  const momentumSymbols = buildMomentumSymbols(universe.symbolRole)
  const momentumStrategy =
    momentumSymbols.size > 0
      ? new BreakoutMomentumStrategy(TEST_DEFAULT_MOMENTUM_RULE, buildMomentumRules(universe))
      : undefined
  // ペアレジーム layer (#472)。mode='off' か対象ペアなしなら option ごと省略
  // (= scheduler 側は完全に従来挙動)。
  const pairRegimeOption =
    global.pairRegimeMode !== 'off' && universe.pairRegimes.length > 0
      ? {
          mode: global.pairRegimeMode,
          thresholds: {
            bullEnter: global.pairRegimeThetaBullEnter,
            bullExit: global.pairRegimeThetaBullExit,
            bearEnter: global.pairRegimeThetaBearEnter,
            bearExit: global.pairRegimeThetaBearExit,
          },
          pairs: universe.pairRegimes,
        }
      : undefined
  const byCurrency: Record<SymbolCurrency, string[]> = { USD: [], JPY: [] }
  for (const sym of universe.allowedSymbols) {
    const cur = universe.symbolCurrency[sym] ?? 'USD'
    byCurrency[cur].push(sym)
  }
  const analysisBase = (): StrategyCronAnalysis => ({
    schema: 'strategy_cron_analysis.v1',
    generatedAt: new Date().toISOString(),
    requestId: options.requestId,
    config: {
      dryRun: global.dryRun,
      tradingEnabled: effectiveTradingEnabled,
      pullbackRule: defaultRule,
      risk: {
        basePerTradePct: global.riskBasePerTradePct,
        ddHalfThreshold: global.riskDdHalfThreshold,
        ddHaltThreshold: global.riskDdHaltThreshold,
        drawdownKillThreshold: global.drawdownKillThreshold,
      },
    },
    universe: {
      symbols: universe.allowedSymbols,
      byCurrency,
      symbolMaxNotional: universe.symbolMaxNotional,
    },
    runs: [],
    decisions: [],
  })

  // Critical な cron skip は #141 で push 通知化する。`trading_disabled` /
  // `no_tradable_symbols` は「設定通り」なので noisy にしないよう **通知しない**
  // (operator は意図的に切ってる場合が多い)。
  // DB と env override の AND 結果で判定 (#276: より制限的な側が勝つ)。
  if (!effectiveTradingEnabled) {
    return { summary: emptySummary(), symbols: [], analysis: analysisBase(), skipReason: 'trading_disabled' }
  }

  if (universe.allowedSymbols.length === 0) {
    return { summary: emptySummary(), symbols: [], analysis: analysisBase(), skipReason: 'no_tradable_symbols' }
  }

  // セッションウィンドウ gate (#session-window-gate)。`sessionWindowGateEnabled`
  // が true の時、開場 PRE_OPEN_WINDOW_MIN 分前〜引けの窓外は戦略評価そのものを
  // skip する (cron は発火するが portfolio DO / VIX / 買付余力取得まで全て省く)。
  // 市場ごとに判定し、窓内の currency だけを後段 run に進める (例: US だけ窓内なら
  // USD run のみ)。休場日 (US はルール計算 / JP は static テーブル、#547) は
  // `market_holiday`、それ以外の窓外は `outside_session_window` と skip 理由を
  // 区別する — 2026-07-03 振替休場で stale-quote SKIP が量産された際、reason から
  // 休場が読めなかった反省。US 半日取引日は引けが 13:00 ET に短縮される (#547)。
  // flag off は従来挙動 (全 currency 常時評価)。skip は「設定通り」なので
  // `trading_disabled` 同様 **通知しない** (noisy 回避)。
  const sessionNow = new Date()
  const windowVerdicts: StrategyWindowVerdict[] = []
  const activeCurrencies = new Set<SymbolCurrency>(
    (['USD', 'JPY'] as const).filter((cur) => {
      if (byCurrency[cur].length === 0) return false
      if (!global.sessionWindowGateEnabled) return true
      const verdict = evaluateStrategyWindow(
        sessionNow,
        cur === 'JPY' ? 'JP' : 'US',
        PRE_OPEN_WINDOW_MIN,
      )
      windowVerdicts.push(verdict)
      return verdict === 'in_window'
    }),
  )
  if (global.sessionWindowGateEnabled && activeCurrencies.size === 0) {
    // 全対象 market が休場のときだけ `market_holiday` (休場と窓外が混在する場合、
    // 休場だけでは skip の説明にならないので従来ラベルに倒す)。
    const allHoliday =
      windowVerdicts.length > 0 && windowVerdicts.every((v) => v === 'market_holiday')
    return {
      summary: emptySummary(),
      symbols: universe.allowedSymbols,
      analysis: analysisBase(),
      skipReason: allHoliday ? 'market_holiday' : 'outside_session_window',
    }
  }

  if (!env.SYMBOL_STATE) {
    emitSkipReasonNotify(notifier, 'no_bridge_state', options.requestId, 'critical')
    return {
      summary: emptySummary(),
      symbols: universe.allowedSymbols,
      analysis: analysisBase(),
      skipReason: 'no_bridge_state',
    }
  }

  // Portfolio-level pre-flight。**exit-only halt** (#exit-only-halt):
  // - PORTFOLIO_STATE binding 不在 → entry 停止
  // - getPortfolio 例外 → entry 停止
  // - tradingDisabledUntil が truthy だが parse 不能 → entry 停止 (silent pass 防止)
  // - tradingDisabledUntil が有効 & 未来 → entry 停止
  // - drawdown 閾値超過 → entry 停止
  //
  // いずれも **新規 BUY だけを止め、保有中の exit (stop / TP / time-stop) は
  // 評価し続ける**。stop はブローカー側の逆指値ではなく cron が毎 tick 評価する
  // ソフト stop なので、ここで全停止すると「一番荒れている時に保有銘柄の唯一の
  // 保護が消える」ことになる。特に drawdown kill は **実現損益**基準 = stop が
  // 効いた直後に発火するため、その順序が起きやすい。
  //
  // 全停止のままにするのは operator の明示停止 (`trading_enabled` / env
  // TRADING_ENABLED) と `no_bridge_state` (SYMBOL_STATE 不在 = 保有状態が
  // そもそも読めない) だけ。
  let entryHaltReason: string | null = null
  const portfolioStore = env.PORTFOLIO_STATE ? new PortfolioStateClient(env.PORTFOLIO_STATE) : null
  let portfolioSnapshot: Awaited<ReturnType<PortfolioStateClient['getPortfolio']>> | null = null
  let analysis = analysisBase()
  if (!portfolioStore) {
    entryHaltReason = 'portfolio_halted: PORTFOLIO_STATE binding missing'
    emitSkipReasonNotify(notifier, 'portfolio_halted', options.requestId, 'critical', 'PORTFOLIO_STATE binding missing')
  }
  if (portfolioStore) {
  try {
    portfolioSnapshot = await portfolioStore.getPortfolio()
    // `lastRolledAt` は #140 で追加した forward-compat フィールド。古い DO row
    // / fixture に欠けている場合 `undefined` で読めるので null に正規化する
    // (`null` = 「未 roll」扱いで stale 判定は skip)。
    const lastRolledAt = portfolioSnapshot.lastRolledAt ?? null
    analysis = {
      ...analysis,
      portfolio: {
        dailyStartEquity: portfolioSnapshot.dailyStartEquity,
        dailyRealizedPnl: portfolioSnapshot.dailyRealizedPnl,
        tradingDisabledUntil: portfolioSnapshot.tradingDisabledUntil,
        lastRolledAt,
        updatedAt: portfolioSnapshot.updatedAt,
      },
    }
    // Stale roll detection (issue #140)。`lastRolledAt` から 24h 以上経過して
    // いれば warning ログ。POC 段階では fail-closed までは行かず、operator が
    // dashboard で気付ける可視化に留める。
    emitStaleRollWarningIfNeeded({ lastRolledAt, requestId: options.requestId })
    const now = Date.now()
    if (portfolioSnapshot.tradingDisabledUntil) {
      const disabledUntilMs = new Date(portfolioSnapshot.tradingDisabledUntil).getTime()
      if (!Number.isFinite(disabledUntilMs) || disabledUntilMs > now) {
        emitSkipReasonNotify(
          notifier,
          'portfolio_halted',
          options.requestId,
          'critical',
          `tradingDisabledUntil=${portfolioSnapshot.tradingDisabledUntil}`,
        )
        entryHaltReason = `portfolio_halted: tradingDisabledUntil=${portfolioSnapshot.tradingDisabledUntil}`
      }
    }
    if (entryHaltReason === null && portfolioSnapshot.dailyStartEquity > 0) {
      const ratio = portfolioSnapshot.dailyRealizedPnl / portfolioSnapshot.dailyStartEquity
      if (ratio <= global.drawdownKillThreshold) {
        emitSkipReasonNotify(
          notifier,
          'drawdown_kill',
          options.requestId,
          'critical',
          `ratio=${ratio.toFixed(4)} <= threshold=${global.drawdownKillThreshold}`,
        )
        entryHaltReason = `drawdown_kill: ratio=${ratio.toFixed(4)} <= threshold=${global.drawdownKillThreshold}`
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emitSkipReasonNotify(
      notifier,
      'portfolio_halted',
      options.requestId,
      'critical',
      `getPortfolio threw: ${message}`,
    )
    entryHaltReason = `portfolio_halted: getPortfolio threw: ${message}`
  }
  }

  // Drawdown-scaled risk: derate sizing for the rest of the trading day
  // when realized PnL is underwater but not yet at drawdown_kill threshold.
  // Emits a journal-visible log so the operator can tell a quiet day from
  // a halved one.
  // portfolio が読めなかった場合 (exit-only halt 中) は 0/0 を渡す。この経路では
  // entry が全銘柄抑止されているので sizing 結果は使われないが、後続の型と
  // ログ形状を素通しにするために neutral な値を入れる。
  const { portfolio: portfolioForScale, usedFallback } = resolvePortfolioForRiskScale(
    portfolioSnapshot ?? { dailyStartEquity: 0, dailyRealizedPnl: 0 },
    global.totalCapitalUsd,
  )
  if (usedFallback) {
    console.log(
      JSON.stringify({
        event: 'portfolio_unseeded_fallback',
        requestId: options.requestId,
        fallbackEquity: portfolioForScale.dailyStartEquity,
      }),
    )
  }
  const ddScale = computeDrawdownRiskScale(portfolioForScale, {
    baseRiskPct: global.riskBasePerTradePct,
    halfThreshold: global.riskDdHalfThreshold,
    haltThreshold: global.riskDdHaltThreshold,
  })
  analysis = {
    ...analysis,
    config: {
      ...analysis.config,
      risk: {
        ...analysis.config.risk,
        scaledPerTradePct: global.riskBasePerTradePct * ddScale.scale,
      },
    },
    drawdownScale: {
      step: ddScale.step,
      scale: ddScale.scale,
      drawdown: ddScale.drawdown,
    },
  }
  if (ddScale.step !== 'normal') {
    console.log(
      JSON.stringify({
        event: 'drawdown_risk_scale',
        requestId: options.requestId,
        step: ddScale.step,
        scale: ddScale.scale,
        drawdown: ddScale.drawdown,
      }),
    )
  }
  const scaledRiskPerTradePct = global.riskBasePerTradePct * ddScale.scale

  const positionStore = new SymbolStateClient(env.SYMBOL_STATE)
  // #21: trade と read を別 client に分離。WebullTradeClient は ENVIRONMENT
  // で staging gate を持つ (= staging からの live order を構造的に防ぐ)。
  // DRY_RUN path では両方 null、MockExecution が選ばれ fallback resolver も
  // 未注入なので read 側も触れない。Phase B: live path のみ token を DO から
  // resolve (DRY_RUN なら broker call が無いので無駄に DO を叩かない)。
  const accessToken = global.dryRun ? undefined : await resolveAccessToken(env)
  const liveTradeClient = global.dryRun ? null : createWebullTradeClient(env, { accessToken })
  const liveReadClient = global.dryRun ? null : createWebullReadClient(env, { accessToken })
  const execution = liveTradeClient ? new WebullExecution(liveTradeClient) : new MockExecution()
  // notifier は関数冒頭で組み立て済み (#141)。BUY/SELL emit / per-symbol
  // bar fetch error / broker submit error は scheduler 内で注入された
  // notifier を使う (#199 経路のまま)。
  // BAR_SOURCE env で選択 (#475): default は Yahoo (/v8/finance/chart — free,
  // no auth, US + JP + ^VIX を 1 endpoint でカバー)。'webull' で Market Data
  // API bars が primary になり、^VIX / JP / 障害時は Yahoo に自動 fallback。
  const barClient = await selectBarClient(env)

  // Earnings calendar gate (issue #196 1/3): table 未 migrate な環境で
  // `fetchByRange()` が `no such table` を吐くと fail-closed で全 BUY が
  // `earnings_gate_fetch_failed` reject になる。新環境 / preview deploy 等で
  // 0013 未適用の状態を許容するため、起動時に 1 回 sqlite_master を見て
  // table の有無を判定し、無ければ gate を 注入しない (= 過去挙動 = 全通過)
  // (CodeRabbit #196 review)。
  const earningsGateReady = env.DB ? await isEarningsCalendarReady(env.DB) : false
  if (env.DB && !earningsGateReady) {
    console.warn(
      JSON.stringify({
        event: 'earnings_gate_disabled_table_missing',
        requestId: options.requestId,
      }),
    )
  }
  // Macro event gate (issue #196 2/3): 同じ理由で 0014 未適用環境では gate を
  // 無効化 (table 不在 → fetch 失敗 → fail-closed で全 BUY reject の連鎖を回避)。
  const macroEventGateReady = env.DB ? await isMacroEventCalendarReady(env.DB) : false
  if (env.DB && !macroEventGateReady) {
    console.warn(
      JSON.stringify({
        event: 'macro_event_gate_disabled_table_missing',
        requestId: options.requestId,
      }),
    )
  }

  // VIX regime filter (issue #196 3/3)。`^VIX` daily の最新 close を 1 本だけ
  // 取得し、`evaluateVixRegime` で regime / sizeScale を決める。fetch 失敗は
  // fail-open (= normal fallback)。POC 段階で fail-closed BUY 全停止は厳しい。
  // `^VIX` は free / no-auth で Yahoo `chart` endpoint がそのまま使える。
  const vixDecision = await loadVixDecision(barClient, global, options.requestId)
  analysis = { ...analysis, vix: vixDecision }
  // Regime 遷移 (normal → warning, warning → critical 等) を STATE_CHANGE 通知。
  // 同 regime の連続 tick では emit しない (snapshot table で dedup)。
  await detectAndNotifyVixRegimeChange({
    db: env.DB,
    notifier,
    current: vixDecision,
    requestId: options.requestId,
  }).catch((err) => {
    console.warn(
      JSON.stringify({
        event: 'vix_regime_change_detect_failed',
        requestId: options.requestId,
        message: err instanceof Error ? err.message : String(err),
      }),
    )
  })

  // News shock gate (news-shock-gate PR 2)。0042 未 migrate な preview / 新環境
  // では `attention_observation` が無いので gate を注入しない (isMacroEventCalendarReady
  // と同じ理由)。`news_shock_mode='off'` (default) の間も評価自体をスキップし、
  // 15分間隔の strategy tick に無駄な D1 read を足さない。**D1 read のみ、
  // fetch は一切しない** (`loadNewsShockDecision` の doc comment 参照)。
  const newsShockGateReady = env.DB ? await isNewsShockGateReady(env.DB) : false
  if (env.DB && !newsShockGateReady && global.newsShockMode !== 'off') {
    console.warn(
      JSON.stringify({
        event: 'news_shock_gate_disabled_table_missing',
        requestId: options.requestId,
      }),
    )
  }
  // 多層防御の 3 層目 (CodeRabbit PR #619 review): `loadNewsShockDecision` 内部
  // (sinceIso の sanitize) と `evaluateNewsShockGate` 内部 (config sanitize) を
  // 直したうえで、それでも想定外の例外が出た場合に strategy tick 全体を
  // 落とさないための最終防波堤。VIX / broker surge 検知 (上の
  // `detectAndNotifyVixRegimeChange` / `notifyBrokerErrorSurgeIfChanged` 呼び出し)
  // と同じ形: fail-open で gate を注入しない (= undefined、BUY sizing に影響
  // させない) に倒す。
  const newsShockLoadResult =
    env.DB && newsShockGateReady && global.newsShockMode !== 'off'
      ? await loadNewsShockDecision(env.DB, global, options.requestId, new Date()).catch((err) => {
          console.warn(
            JSON.stringify({
              event: 'news_shock_decision_load_failed',
              requestId: options.requestId,
              message: err instanceof Error ? err.message : String(err),
            }),
          )
          return undefined
        })
      : undefined
  // strategy tick は複数 probe の合成 (`combined`) だけを使う。probe 別の
  // decision (`probes`) は日次サマリ通知 (news-shock-gate follow-up) 向けの
  // 情報で、tick の BUY sizing には関与しない。
  const newsShockDecision = newsShockLoadResult?.combined
  if (newsShockDecision) {
    // trace には unknown を含む全 decision を残す (通知の抑制とは独立)。
    analysis = { ...analysis, newsShock: newsShockDecision }
  }
  if (newsShockDecision && newsShockDecision.regime !== 'unknown') {
    // Regime 遷移 (normal → warning, warning → critical 等) を STATE_CHANGE 通知。
    // VIX と同じ CAS dedup 機構を汎用版 (`regimeChange.ts`) 経由で再利用する。
    //
    // 'unknown' はデータ欠測 (GDELT の反映遅延・producer 障害) であって市場
    // 状態ではないため、snapshot 更新ごとスキップする — 鮮度が 90 分境界を
    // 跨ぐたびに normal↔unknown がフラップして「アクションの取れない通知」で
    // Discord を汚していた (ユーザーフィードバック)。これで snapshot は常に
    // 「最後に観測できた regime」を保持し、warning↔unknown↔warning の再突入
    // 重複通知も出ない。unknown→normal (欠測回復) も shouldNotify で抑制する。
    const mode = global.newsShockMode === 'enforce' ? 'enforce' : 'observe'
    await detectAndNotifyRegimeChange({
      db: env.DB,
      notifier,
      key: 'news_shock_regime',
      current: { regime: newsShockDecision.regime, reason: newsShockDecision.reason },
      rank: NEWS_SHOCK_REGIME_RANK,
      criticalRegime: 'critical',
      isValidRegime: isNewsShockRegime,
      requestId: options.requestId,
      shouldNotify: (from, to) => !(from === 'unknown' && to === 'normal'),
      headline: (from, to) => buildNewsShockRegimeHeadline(from, to, newsShockDecision, mode),
    }).catch((err) => {
      console.warn(
        JSON.stringify({
          event: 'news_shock_regime_change_detect_failed',
          requestId: options.requestId,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    })
  }
  // mode: gate の適用強度を scheduler に伝える。'off' はここまでで decision
  // 自体が undefined になっているので option ごと省略される (= 評価スキップ、
  // trace にも出ない)。
  const newsShockGateOption =
    newsShockDecision && global.newsShockMode !== 'off'
      ? { mode: global.newsShockMode, decision: newsShockDecision }
      : undefined

  // Extended-hours (pre-market) gate (issue #709 Phase 6)。0045 未 migrate な
  // preview / 新環境では `extended_hours_observation` が無いので gate を注入
  // しない (`isNewsShockGateReady` と同じ理由)。`extended_hours_gate_mode='off'`
  // (default) の間も評価自体をスキップし、15分間隔の strategy tick に無駄な
  // D1 read を足さない。**D1 read のみ、fetch は一切しない**
  // (`loadExtendedHoursGateDecisions` の doc comment 参照)。
  const extendedHoursGateReady = env.DB ? await isExtendedHoursGateReady(env.DB) : false
  if (env.DB && !extendedHoursGateReady && global.extendedHoursGateMode !== 'off') {
    console.warn(
      JSON.stringify({
        event: 'extended_hours_gate_disabled_table_missing',
        requestId: options.requestId,
      }),
    )
  }
  // fail-open の最終防波堤 (news shock と同じ層防御): `loadExtendedHoursGateDecisions`
  // 内部で想定外の例外が出ても strategy tick 全体を落とさない。gate を注入しない
  // (= undefined、BUY sizing に影響させない) に倒す。
  const extendedHoursDecisions =
    env.DB && extendedHoursGateReady && global.extendedHoursGateMode !== 'off'
      ? await loadExtendedHoursGateDecisions(env.DB, new Date()).catch((err) => {
          console.warn(
            JSON.stringify({
              event: 'extended_hours_gate_load_failed',
              requestId: options.requestId,
              message: err instanceof Error ? err.message : String(err),
            }),
          )
          return undefined
        })
      : undefined
  // mode: gate の適用強度を scheduler に伝える。'off' / 未 migrate / 有効時間窓外
  // (decisions が空 Map) なら option ごと省略する (= 評価スキップ、trace にも出ない)。
  const extendedHoursGateOption =
    extendedHoursDecisions && extendedHoursDecisions.size > 0 && global.extendedHoursGateMode !== 'off'
      ? { mode: global.extendedHoursGateMode, decisions: extendedHoursDecisions }
      : undefined

  // Pullback デフォルト rule は D1 global_config に寄せた (#118)。
  // 実運用中の tuning は `UPDATE global_config SET ...` で即反映可能。
  // VIX regime decision を summary にも載せる (CodeRabbit #216 4th):
  // sub-run ごとに独立した summary が `vix` を持つので、aggregate もそれと
  // 揃えておく。`emptySummary()` は `vix` を埋めないので明示的に上書きする。
  // #exit-only-halt: risk 由来の halt 中は **全銘柄の BUY を抑止**し、SELL /
  // exit だけを通す。role 由来の抑止理由が既にある銘柄はそちらを優先して残す
  // (より具体的な理由の方が decision log で有用)。
  const effectiveEntrySuppressed: Record<string, string> =
    entryHaltReason === null
      ? entrySuppressedSymbols
      : {
          ...Object.fromEntries(
            universe.allowedSymbols.map((symbol) => [symbol.toUpperCase(), entryHaltReason]),
          ),
          ...entrySuppressedSymbols,
        }
  if (entryHaltReason !== null) {
    console.log(
      JSON.stringify({
        event: 'entry_halt_exit_only',
        requestId: options.requestId,
        reason: entryHaltReason,
        symbols: universe.allowedSymbols.length,
      }),
    )
    analysis = { ...analysis, entryHalt: { reason: entryHaltReason } }
  }
  const summary: PullbackRunSummary = {
    ...emptySummary(),
    vix: vixDecision,
    ...(newsShockDecision !== undefined ? { newsShock: newsShockDecision } : {}),
  }
  // run は `activeCurrencies` (= 銘柄あり ∧ (gate off ∨ 窓内)) のみ構築する。
  // gate off の時は両 currency が active なので従来挙動と一致する (#session-window-gate)。
  const runs: Array<{ currency: SymbolCurrency; equity: number; symbols: string[] }> = []
  if (activeCurrencies.has('USD')) {
    runs.push({
      currency: 'USD',
      equity: sanitizeEquity(global.totalCapitalUsd, DEFAULT_EQUITY_USD),
      symbols: byCurrency.USD,
    })
  }
  if (activeCurrencies.has('JPY')) {
    runs.push({
      currency: 'JPY',
      equity: sanitizeEquity(global.totalCapitalJpy, DEFAULT_EQUITY_JPY),
      symbols: byCurrency.JPY,
    })
  }

  // #budget-jpy-base-fx: 予算配分は口座(円)単一プール基準。USD 銘柄を「円予算 → USD」
  // 換算するため USD/JPY を 1 回だけ取得 (USD 側に budget 銘柄がある時のみ)。取得失敗
  // /異常値は null → USD budget 銘柄は sizing 側で fail-closed (発注見送り)。
  // 予算配分の基準額は実口座総額 (total_capital_jpy)。**null/未設定/非正は DEFAULT に
  // 倒さず undefined** にする: 幻の資本 (¥1.5M default) で budget% sizing すると小口座で
  // 過大発注になり Webull 余力不足 (417) を招くため、budget 銘柄を sizing 側で
  // fail-closed (発注見送り) させる。total_capital_jpy を設定すれば即 sizing 再開
  // (real-money safety / #417 buying-power)。risk-% sizing 経路の equity 既定は別管理。
  const budgetBasisJpy =
    global.totalCapitalJpy != null &&
    Number.isFinite(global.totalCapitalJpy) &&
    global.totalCapitalJpy > 0
      ? global.totalCapitalJpy
      : undefined
  const usdHasBudgetSymbol = byCurrency.USD.some(
    (s) => universe.symbolBudgetAllocPct[s.toUpperCase()] !== undefined,
  )
  // USD/JPY は budget 換算に加え、live 時は買付余力 (USD 建て) の JPY 換算にも要る
  // ので、live ならば取得する (#415)。
  const needUsdJpy = usdHasBudgetSymbol || liveReadClient !== null
  const usdJpyRate = needUsdJpy ? await loadUsdJpyRate({ requestId: options.requestId }) : null

  // #415: 発注前の共有プール pre-trade ゲート。live 時のみ Webull の買付余力を取得し
  // JPY 基準の ledger を作る (runs=USD/JPY をまたいで共有)。取得失敗/異常値は
  // unavailable 台帳 → 当 tick の BUY 全 fail-closed (誤余力で過大発注しない)。
  // DryRun (liveReadClient=null) では undefined のまま = scheduler の pool ゲート無効。
  const buyingPower: BuyingPowerLedger | undefined = liveReadClient
    ? await resolveBuyingPowerLedger(liveReadClient, usdJpyRate, options.requestId)
    : undefined

  // TICKER_IS_DENY 自動停止ガード (#460)。env.DB がある時だけ有効化 — D1 が
  // 無いと symbol_config を停止できないので skip (= 従来挙動)。
  const onTickerDeny = env.DB
    ? createTickerDenyGuard({
        db: createSymbolConfigDb(env.DB),
        rawDb: env.DB,
        notifier,
        requestId: options.requestId,
      })
    : undefined

  for (const run of runs) {
    analysis.runs.push({
      currency: run.currency,
      equity: run.equity,
      symbols: run.symbols,
    })
    // JPY 銘柄は fx=1。USD 銘柄は usdJpyRate (null なら undefined → budget 銘柄 fail-closed)。
    const fxJpyPerSymbolCcy = run.currency === 'JPY' ? 1 : (usdJpyRate ?? undefined)
    const decisionDb = strategyDecisionDbOrUndefined(env)
    const sub = await runPullbackScheduler({
      symbols: run.symbols,
      equity: run.equity,
      symbolLotSizeMap: universe.symbolLotSize,
      barClient,
      positionStore,
      execution,
      symbolCapMap: universe.symbolMaxNotional,
      symbolBudgetAllocPctMap: universe.symbolBudgetAllocPct,
      budgetBasisJpy,
      fxJpyPerSymbolCcy,
      buyingPower,
      intradayOnlySymbols: new Set(Object.keys(universe.symbolIntradayOnly)),
      defaultRule,
      rulesMap,
      entrySuppressedSymbols: effectiveEntrySuppressed,
      atrBaselineMode: global.atrBaselineMode,
      // #trade-cost: 通知の realized を reconcile と同じ net にする。
      tradeCost: {
        feePctOfNotional: global.feePctOfNotional,
        feeFixedPerOrder: global.feeFixedPerOrder,
      },
      halfEntrySymbols,
      momentumSymbols,
      ...(momentumStrategy ? { momentumStrategy } : {}),
      ...(onTickerDeny ? { onTickerDeny } : {}),
      ...(pairRegimeOption ? { pairRegime: pairRegimeOption } : {}),
      riskPerTradePct: scaledRiskPerTradePct,
      requestId: options.requestId,
      notifier,
      // Per-symbol risk gate (issue #138 — TradingService と unify)。
      // global_config / symbol_universe から populate。manual route と同じ
      // deps なので、cron / `/trade/execute` の判定が一致する。
      perSymbolRisk: {
        inversePairs: universe.inversePairs,
        spreadLimits: {
          US: global.spreadLimitPctUs,
          JP: global.spreadLimitPctJp,
        },
        staleQuoteMs: global.staleQuoteMs,
        gapRejectPct: global.gapRejectPct,
      },
      // SELL_QTY_EXCEED fallback (#215 follow-up)。live Webull 経路
      // (DRY_RUN=false) の時だけ注入する。MockExecution 経路は 417 を
      // 起こさないので fallback は dead code。Webull DTO の解釈
      // (symbol 比較 / available_quantity の数値化) は infrastructure 層
      // (`WebullHttpClient.getAvailableQtyForSymbol`) に閉じている。
      // resolver 側で例外を握り潰さず、scheduler 側 (`tryFallbackSell`) が
      // null fallback して元の SELL_QTY_EXCEED エラーを再 throw する。
      ...(liveReadClient
        ? {
            sellFallback: {
              getAvailableQty: (symbol: string) =>
                liveReadClient.getAvailableQtyForSymbol(symbol),
            },
          }
        : {}),
      // Earnings calendar gate (issue #196 1/3)。env.DB が無い OR table 未
      // migrate なら skip (POC 後方互換 / CodeRabbit #196 review)。
      // freezeBusinessDays は POC 段階では default 1 固定。将来 global_config に
      // 出すなら別 PR (#196 follow-up)。
      ...(env.DB && earningsGateReady
        ? {
            earningsGate: {
              repo: createEarningsCalendarRepo(createEarningsCalendarDb(env.DB)),
              freezeBusinessDays: 1,
            },
          }
        : {}),
      // Macro event gate (issue #196 2/3)。同様に env.DB / 0014 適用の双方が
      // あるときだけ注入。config は default (±1h, full-day=true) で POC 運用。
      ...(env.DB && macroEventGateReady
        ? {
            macroEventGate: {
              repo: createMacroEventCalendarRepo(createMacroEventCalendarDb(env.DB)),
            },
          }
        : {}),
      // VIX regime filter (issue #196 3/3)。critical で BUY 全停止、warning で
      // size を縮小、normal は no-op。両 currency run に同じ decision を渡す
      // (`^VIX` は global indicator なので per-currency に変える意味はない)。
      vixDecision,
      // News shock gate (news-shock-gate PR 2)。VIX と乗算チェーンで合成される。
      // 'off' / 未 migrate なら newsShockGateOption 自体が undefined なので
      // option ごと省略 (= scheduler 側は評価をスキップ)。
      ...(newsShockGateOption ? { newsShockGate: newsShockGateOption } : {}),
      // Extended-hours (pre-market) gate (issue #709 Phase 6)。per-symbol の
      // decision Map なので 'off' / 未 migrate / 有効時間窓外 (decisions 空)
      // なら extendedHoursGateOption 自体が undefined → option ごと省略。
      ...(extendedHoursGateOption ? { extendedHoursGate: extendedHoursGateOption } : {}),
      // sanity_failed cooldown (9697 04/28 incident: broker stub fill 30 min /
      // 6 BUY 累積)。env.DB がある時だけ有効化 — D1 が無いと journal 検査
      // できないので skip (= 過去挙動)。fail-closed: check throw 時は scheduler
      // 側で BUY reject。
      ...(env.DB
        ? {
            sanityFailedCooldown: {
              check: (symbol: string) =>
                hasRecentSanityFailure(env.DB!, symbol, SANITY_FAILED_COOLDOWN_MS),
              withinMs: SANITY_FAILED_COOLDOWN_MS,
            },
          }
        : {}),
      onDecision: ({ trace, ...record }) =>
        logStrategyDecision(decisionDb, {
          timestamp: new Date().toISOString(),
          requestId: options.requestId,
          ...record,
          // 判定トレースを JSON 保存しラダー可視化に使う (#decision-trace)。
          traceJson: trace && trace.length > 0 ? JSON.stringify(trace) : null,
        }),
    })
    summary.evaluated += sub.evaluated
    summary.buys += sub.buys
    summary.sells += sub.sells
    summary.holds += sub.holds
    summary.rejected.push(...sub.rejected)
    summary.errors.push(...sub.errors)
    summary.decisions.push(...sub.decisions)
    Object.assign(summary.entrySnapshots, sub.entrySnapshots)
    analysis.decisions.push(...sub.decisions)
  }

  // ---- 条件連動配分 (#452 Layer 3) ----
  // target/active weight の計算は flag に関わらず常に行い analysis に残す
  // (判定・表示)。退避先への自動発注 (pass 2) は cash_fallback_orders_enabled
  // (default false) が on で、かつ budget 基準額がある時だけ。
  const allocationView = computeConditionalAllocation({
    targetWeights: universe.symbolBudgetAllocPct,
    policy: {
      entryRequired: new Set(Object.keys(universe.symbolEntryRequired)),
      alwaysActive: new Set(Object.keys(universe.symbolAlwaysActive)),
      cashFallback: universe.symbolCashFallback,
    },
    entryStatuses: Object.fromEntries(
      Object.entries(summary.entrySnapshots).map(([sym, snap]) => [sym, snap.status]),
    ),
    heldSymbols: new Set(
      Object.entries(summary.entrySnapshots)
        .filter(([, snap]) => snap.heldQty > 0)
        .map(([sym]) => sym),
    ),
    symbolCurrency: universe.symbolCurrency,
    inversePairs: universe.inversePairs,
  })
  analysis.allocation = { view: allocationView, ordersEnabled: global.cashFallbackOrdersEnabled }

  // #exit-only-halt: cash rebalance pass 2 は entrySuppressedSymbols を渡さない
  // 唯一の BUY 経路なので、halt 中はここで丸ごと止める (退避先への自動 BUY も
  // 「新規 entry」として扱う)。
  if (global.cashFallbackOrdersEnabled && budgetBasisJpy !== undefined && entryHaltReason === null) {
    const plan = buildCashRebalancePlan({
      allocation: allocationView,
      snapshots: summary.entrySnapshots,
      budgetBasisJpy,
      fxJpyPerCcy: (currency) => (currency === 'JPY' ? 1 : (usdJpyRate ?? undefined)),
      symbolCurrency: universe.symbolCurrency,
      symbolLotSize: universe.symbolLotSize,
      symbolMaxNotional: universe.symbolMaxNotional,
      maxOrderNotional: { USD: global.maxOrderNotionalUsd, JPY: global.maxOrderNotionalJpy },
    })
    analysis.allocation.rebalanceSkipped = plan.skipped
    if (plan.orders.length > 0) {
      // pass 2: cash 銘柄だけを cashRebalanceQuantityMap 付きで再実行する。
      // entrySuppressedSymbols は渡さない (cash_parking の BUY を許可する唯一の
      // 経路)。lot / per-symbol risk / buying-power / pending lock / DRY_RUN は
      // 通常 BUY と同じ gate を通る。
      const byCcy: Record<SymbolCurrency, typeof plan.orders> = { USD: [], JPY: [] }
      for (const order of plan.orders) {
        byCcy[universe.symbolCurrency[order.symbol] ?? 'USD'].push(order)
      }
      for (const run of runs) {
        const orders = byCcy[run.currency]
        if (orders.length === 0) continue
        const decisionDb = strategyDecisionDbOrUndefined(env)
        const sub = await runPullbackScheduler({
          symbols: orders.map((o) => o.symbol),
          equity: run.equity,
          symbolLotSizeMap: universe.symbolLotSize,
          barClient,
          positionStore,
          execution,
          symbolCapMap: universe.symbolMaxNotional,
          cashRebalanceQuantityMap: Object.fromEntries(orders.map((o) => [o.symbol, o.quantity])),
          ...(onTickerDeny ? { onTickerDeny } : {}),
          fxJpyPerSymbolCcy: run.currency === 'JPY' ? 1 : (usdJpyRate ?? undefined),
          buyingPower,
          defaultRule,
          rulesMap,
          momentumSymbols,
          ...(momentumStrategy ? { momentumStrategy } : {}),
          requestId: options.requestId,
          notifier,
          perSymbolRisk: {
            inversePairs: universe.inversePairs,
            spreadLimits: {
              US: global.spreadLimitPctUs,
              JP: global.spreadLimitPctJp,
            },
            staleQuoteMs: global.staleQuoteMs,
            gapRejectPct: global.gapRejectPct,
          },
          vixDecision,
          ...(newsShockGateOption ? { newsShockGate: newsShockGateOption } : {}),
          ...(extendedHoursGateOption ? { extendedHoursGate: extendedHoursGateOption } : {}),
          onDecision: ({ trace, ...record }) =>
            logStrategyDecision(decisionDb, {
              timestamp: new Date().toISOString(),
              requestId: options.requestId,
              ...record,
              traceJson: trace && trace.length > 0 ? JSON.stringify(trace) : null,
            }),
        })
        summary.evaluated += sub.evaluated
        summary.buys += sub.buys
        summary.rejected.push(...sub.rejected)
        summary.errors.push(...sub.errors)
        summary.decisions.push(...sub.decisions)
        analysis.decisions.push(...sub.decisions)
      }
    }
  }

  return {
    summary,
    symbols: universe.allowedSymbols,
    analysis,
    ...(entryHaltReason !== null ? { entryHaltReason } : {}),
  }
}

function sanitizeEquity(value: number | null | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) return fallback
  return value
}

/**
 * Webull 買付余力を取得し JPY 基準の共有 ledger を作る (#415)。HTTP client が
 * 内部で transient retry するので、ここでは 1 回呼んで成否を判定する。例外 / parse
 * 不能 / 異常値 / FX 欠落は **unavailable 台帳** (= 当 tick の BUY 全 fail-closed)。
 * 構造化ログ (requestId 付き) で取得結果を残す。
 */
async function resolveBuyingPowerLedger(
  readClient: { getAccountBalance(): Promise<WebullAccountBalanceDto> },
  usdJpyRate: number | null,
  requestId: string | undefined,
): Promise<BuyingPowerLedger> {
  try {
    const balance = await readClient.getAccountBalance()
    const bp = buyingPowerJpyFromBalance(balance, usdJpyRate)
    if (bp === null) {
      console.warn(
        JSON.stringify({
          event: 'buying_power_unavailable',
          reason: 'balance parse failed / anomaly / missing FX',
          requestId,
        }),
      )
      return createUnavailableBuyingPowerLedger('balance parse failed / anomaly / missing FX')
    }
    console.warn(
      JSON.stringify({ event: 'buying_power_fetched', jpy: bp.jpy, byCurrency: bp.byCurrency, requestId }),
    )
    return createBuyingPowerLedger({ availableJpy: bp.jpy, asOf: new Date().toISOString() })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(JSON.stringify({ event: 'buying_power_unavailable', reason, requestId }))
    return createUnavailableBuyingPowerLedger(reason)
  }
}

/**
 * 「未 seed」portfolio と「壊れた値」の portfolio を区別する pure helper。
 *
 * 分類:
 *   - `dailyStartEquity > 0`: seed 済、そのまま使う (fallback なし)
 *   - `dailyStartEquity <= 0` かつ **有限値** (0 / 負値): 未 seed 扱い。
 *     `global.totalCapitalUsd` が正値なら baseline として fallback。負値も
 *     同じく未 seed 判定 (tests 参照) で、broken data ではない。
 *   - `dailyStartEquity` が **非有限** (NaN / Infinity): 壊れ値 → fallback
 *     しない。後段 `drawdownRiskScale` の fail-closed (step: 'halt') に任せる。
 *   - `dailyRealizedPnl` が非有限: 同上、fallback 経路で 0 に上書きして
 *     fail-closed を迂回しないよう早期 return (CodeRabbit review #131)。
 *
 * 狙い: `/admin/portfolio/roll-daily` 未実行の初日 / 日跨ぎでも
 * `drawdownRiskScale` が halt ではなく normal で動き、BUY 機会を逃さない。
 * 同時に CodeRabbit review #125 の fail-closed 意図 (壊れ値は halt) は維持。
 */
export function resolvePortfolioForRiskScale<
  P extends { dailyStartEquity: number; dailyRealizedPnl: number },
>(
  portfolio: P,
  totalCapitalUsd: number | null | undefined,
): { portfolio: P; usedFallback: boolean } {
  // start > 0 ならそのまま
  if (portfolio.dailyStartEquity > 0) return { portfolio, usedFallback: false }
  // dailyStartEquity が NaN / Infinity → fallback しない (halt を期待)
  if (!Number.isFinite(portfolio.dailyStartEquity)) return { portfolio, usedFallback: false }
  // dailyRealizedPnl が壊れている (NaN / Infinity) なら fallback しない。
  // fallback 経路で勝手に 0 へ上書きすると壊れ値を fail-closed で捕まえ損ねる
  // (CodeRabbit review #131)。
  if (!Number.isFinite(portfolio.dailyRealizedPnl)) return { portfolio, usedFallback: false }
  if (
    totalCapitalUsd === null ||
    totalCapitalUsd === undefined ||
    !Number.isFinite(totalCapitalUsd) ||
    totalCapitalUsd <= 0
  ) {
    return { portfolio, usedFallback: false }
  }
  return {
    portfolio: {
      ...portfolio,
      dailyStartEquity: totalCapitalUsd,
      dailyRealizedPnl: 0, // 未 seed = 未実現損益もゼロ扱い
    },
    usedFallback: true,
  }
}

/**
 * Issue #140: stale roll の閾値 (hours)。
 *
 * 24h 以上経過 → `event: 'portfolio_roll_stale'` を warning ログ出力。
 *  - 22:00 UTC daily cron が 1 回 miss すると 24h を超えるので、最初の miss で
 *    operator が気付ける粒度にしている。
 *  - `lastRolledAt === null` (= まだ一度も roll が走っていない) は **stale 扱い
 *    しない**。新規環境 / DO 永続化前の state は EOD cron が初回成功するまで
 *    null のままなので、ここで毎 cron tick warn すると noise になる。代わりに
 *    dashboard 側で「未実行」を別表記する。
 *  - `Date.now()` をベースにするので呼び出し側の test は `vi.useFakeTimers` で
 *    時刻を固定する。
 */
const STALE_ROLL_WARNING_HOURS = 24

export function emitStaleRollWarningIfNeeded(args: {
  lastRolledAt: string | null
  requestId?: string
  now?: () => number
}): void {
  if (args.lastRolledAt === null) return
  const lastMs = new Date(args.lastRolledAt).getTime()
  if (!Number.isFinite(lastMs)) {
    // Corrupt timestamp。silent pass を避けて warn を出すが、stale_hours は
    // 計算不能なので "unparseable" を載せる。
    console.warn(
      JSON.stringify({
        event: 'portfolio_roll_stale',
        requestId: args.requestId,
        lastRolledAt: args.lastRolledAt,
        reason: 'unparseable_lastRolledAt',
      }),
    )
    return
  }
  const nowMs = (args.now ?? Date.now)()
  const elapsedHours = (nowMs - lastMs) / 3_600_000
  if (elapsedHours >= STALE_ROLL_WARNING_HOURS) {
    console.warn(
      JSON.stringify({
        event: 'portfolio_roll_stale',
        requestId: args.requestId,
        lastRolledAt: args.lastRolledAt,
        staleHours: Number(elapsedHours.toFixed(2)),
        thresholdHours: STALE_ROLL_WARNING_HOURS,
      }),
    )
  }
}

/**
 * 0013 migration (`earnings_calendar`) が当該 D1 で適用済みかを判定する。
 *
 * 新環境 / preview deploy 等で 0013 未適用の状態に対し earnings gate を有効化
 * すると、`fetchByRange()` が `no such table` を吐き fail-closed で全 BUY が
 * reject される (CodeRabbit #196 review)。それを避けるため、cron 起動時に
 * `sqlite_master` を 1 回参照し、table が存在しなければ gate を **注入しない**
 * (過去挙動 = 全通過 へ fallback)。
 *
 * クエリ自体が throw した場合 (DB 接続失敗 / corruption 等) も「未 ready」
 * 扱い。これは「earnings 評価ができない壊れた D1 で gate を有効化しない」
 * という選択で、安全側の fallback として bucket / perSymbolRisk gate に任せる。
 */
async function isEarningsCalendarReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='earnings_calendar' LIMIT 1",
      )
      .first<{ ok: number }>()
    return row?.ok === 1
  } catch {
    return false
  }
}

/**
 * `^VIX` の最新 close を取って `evaluateVixRegime` に流し、size scaling 用
 * decision を返す (issue #196 3/3)。
 *
 * fail-open: VIX fetch / parse 失敗時は `null` を渡して `regime: 'normal'` /
 * `sizeScale: 1.0` (= 通常運用) に倒す。POC 段階では VIX は part-of-the-system
 * で必須ではなく、fetch 失敗 = BUY 全停止は副作用が大きすぎる。warning ログ
 * だけ吐いて続行。
 */
async function loadVixDecision(
  barClient: BarClient,
  global: { vixWarningThreshold: number; vixCriticalThreshold: number; vixWarningSizeScale: number },
  requestId: string | undefined,
): Promise<VixRegimeFilterDecision> {
  let vix: number | null = null
  try {
    // `^VIX` (CBOE Volatility Index)。Yahoo は記号付き symbol を URL encode で
    // 受けてくれる。lookback=1 で最新 close 1 本だけ。
    const bars = await barClient.getDailyBars('^VIX', 1)
    const last = bars[bars.length - 1]
    if (last && Number.isFinite(last.close) && last.close > 0) {
      vix = last.close
    } else {
      console.warn(
        JSON.stringify({
          event: 'vix_fetch_no_bars',
          requestId,
          barsLength: bars.length,
        }),
      )
    }
  } catch (err) {
    // fail-open: warning ログだけ。decision は null = normal fallback。
    console.warn(
      JSON.stringify({
        event: 'vix_fetch_failed',
        requestId,
        message: err instanceof Error ? err.message : String(err),
      }),
    )
  }
  return evaluateVixRegime(vix, {
    warningThreshold: global.vixWarningThreshold,
    criticalThreshold: global.vixCriticalThreshold,
    warningSizeScale: global.vixWarningSizeScale,
  })
}

/**
 * 0014 migration (`macro_event_calendar`) が当該 D1 で適用済みかを判定する
 * (issue #196 2/3)。`isEarningsCalendarReady` と同じ理由 — 未 migrate な
 * preview / 新環境では gate を 無効化 して fail-closed の連鎖 reject を回避。
 */
async function isMacroEventCalendarReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='macro_event_calendar' LIMIT 1",
      )
      .first<{ ok: number }>()
    return row?.ok === 1
  } catch {
    return false
  }
}

/**
 * cron tick の skip reason を Notifier に push する (#141)。fire-and-forget
 * + silent fallback。`portfolio_halted` / `drawdown_kill` / `no_bridge_state`
 * の 3 種を critical として通知する。
 *
 * 既存の `strategy_cron_run.skipReason` ログ列はそのまま (後方互換)。
 */
function emitSkipReasonNotify(
  notifier: Notifier,
  reason: 'portfolio_halted' | 'drawdown_kill' | 'no_bridge_state',
  requestId: string | undefined,
  severity: 'critical' | 'warning' = 'critical',
  detail?: string,
): void {
  const note = requestId ? ` requestId=${requestId}` : ''
  const message = detail ? `cron skipped: ${reason} — ${detail}${note}` : `cron skipped: ${reason}${note}`
  notifier
    .notify({
      type: 'ERROR',
      message,
      cause: reason,
      severity,
    })
    .catch((err) => {
      console.warn(
        JSON.stringify({
          event: 'cron_skip_notify_failed',
          requestId,
          reason,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    })
}
