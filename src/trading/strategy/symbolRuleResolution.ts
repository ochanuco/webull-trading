import type { SymbolRole, SymbolRoleValue } from '../../infrastructure/db/symbolConfigRepo'
import type { SymbolRule } from './strategies/PullbackUptrendStrategy'

/**
 * 銘柄ロール → entry gate プリセット (#452 Layer 1)。適用順は
 *
 *   global default → role preset → per-symbol override
 *
 * で、preset は「global default との差分」だけを持つ。
 *
 * - `leveraged_trend`: 差分なし (= 現行 4 銘柄の挙動そのまま。global default が
 *   そもそもレバ ETF 向けに調整されてきた値のため)
 * - `core_trend`: 非レバ ETF (QQQ / VOO 等) 向けの緩いプリセット。レバ ETF の
 *   1/3 程度の値動きしかないので、押し目深度・トレンド閾値をスケールダウン
 *   しないと事実上 entry 不可能になる (#449 課題2)。**初期値であり backtest
 *   チューニングは #452 非スコープ (後続 issue)** — 個別銘柄で合わない場合は
 *   per-symbol override で吸収する。
 * - その他の role はプリセットなし (entry 自体が抑止される、下記)。
 */
export const ROLE_RULE_PRESETS: Partial<Record<SymbolRole, Partial<SymbolRule>>> = {
  leveraged_trend: {},
  core_trend: {
    // 20d 騰落率: レバ ETF の +8% は非レバでは +2.7% 相当。やや保守的に +3%。
    minReturn50d: 0.03,
    // 押し目バンド: -3%..-6% (3x) → -1.5%..-5% (1x)。深い側はギャップ時の
    // 取りこぼしを避けるため 1/3 スケールより広めに残す。
    pullbackMax: -0.015,
    pullbackMin: -0.05,
    // 過伸長ガード: 非レバが SMA50 から +60% 乖離することは実質ないので
    // +20% に引き下げ (ガードとして機能する値にする)。
    maxSma50DeviationPct: 0.2,
  },
}

/**
 * Entry (BUY 生成) が有効な role。`undefined` (= role NULL、従来挙動) と
 * 初期有効化 3 role のうち pullback gate を通す 2 つ。
 *
 * - `cash_parking` は pullback 判定が無意味 (SMA50 / 押し目が成立しない) なので
 *   strategy 経由の BUY を抑止する。配分は #452 PR 3 の条件連動配分
 *   (`always_active`) が別経路で扱う。
 * - `low_volatility` / `sector_trend` / `inverse_hedge` は定義のみ (後続 issue)。
 *   特に inverse_hedge に long pullback ロジックをそのまま適用するのは誤りなので
 *   fail-closed で抑止する。
 * - repo が enum 外 DB 値を正規化した 'unknown' もここに含まれない (= 抑止)。
 */
const ENTRY_ENABLED_ROLES: ReadonlySet<SymbolRole> = new Set(['core_trend', 'leveraged_trend'])

/**
 * strategy cron が BUY を生成してはいけない symbol → 抑止理由、の map を作る
 * (#452)。SELL / HOLD (exit 経路) は対象外 — role を後から変えた銘柄に建玉が
 * 残っていても stop / time-stop / TP は従来どおり動く。
 */
export function buildEntrySuppressedSymbols(
  symbolRole: Record<string, SymbolRoleValue>,
): Record<string, string> {
  const suppressed: Record<string, string> = {}
  for (const [symbol, role] of Object.entries(symbolRole)) {
    if (role !== 'unknown' && ENTRY_ENABLED_ROLES.has(role)) continue
    suppressed[symbol] =
      role === 'unknown'
        ? 'role: unknown role value in symbol_config (entry suppressed, fail-closed) (#452)'
        : `role: ${role} entry is not enabled (#452)`
  }
  return suppressed
}

/** buildSymbolRules の入力 (SymbolUniverse の該当 map をそのまま渡せる形)。 */
export interface SymbolRuleOverrides {
  symbolTimeStopDaysOverride: Record<string, number>
  symbolKAtrOverride: Record<string, number>
  symbolStopPctOverride: Record<string, number>
  symbolTakeProfitPctOverride: Record<string, number>
  symbolRole: Record<string, SymbolRoleValue>
  symbolPullbackMaxOverride: Record<string, number>
  symbolPullbackMinOverride: Record<string, number>
  symbolMinReturn50dOverride: Record<string, number>
  symbolMaxAtrRatioOverride: Record<string, number>
  symbolMaxSma50DeviationPctOverride: Record<string, number>
  symbolRequireAboveSma50Override: Record<string, boolean>
}

/**
 * Per-symbol rule map を組み立てる (#316 / #exit-atr / #452)。
 *
 * 重ね順: `defaultRule` (global_config) → role preset → per-symbol override。
 * どの層にも該当の無い symbol は map に含めない (= defaultRule そのまま)。
 * **role NULL かつ override なしの既存銘柄は map に現れず、挙動変更ゼロ**
 * (#452 受け入れ条件の回帰保証はこの性質に対するテストで担保)。
 */
export function buildSymbolRules(
  defaultRule: SymbolRule,
  overrides: SymbolRuleOverrides,
): Record<string, SymbolRule> {
  const rulesMap: Record<string, SymbolRule> = {}
  const symbols = new Set<string>([
    ...Object.keys(overrides.symbolTimeStopDaysOverride),
    ...Object.keys(overrides.symbolKAtrOverride),
    ...Object.keys(overrides.symbolStopPctOverride),
    ...Object.keys(overrides.symbolTakeProfitPctOverride),
    ...Object.keys(overrides.symbolRole),
    ...Object.keys(overrides.symbolPullbackMaxOverride),
    ...Object.keys(overrides.symbolPullbackMinOverride),
    ...Object.keys(overrides.symbolMinReturn50dOverride),
    ...Object.keys(overrides.symbolMaxAtrRatioOverride),
    ...Object.keys(overrides.symbolMaxSma50DeviationPctOverride),
    ...Object.keys(overrides.symbolRequireAboveSma50Override),
  ])
  for (const sym of symbols) {
    const role = overrides.symbolRole[sym]
    const preset = role !== undefined && role !== 'unknown' ? ROLE_RULE_PRESETS[role] : undefined
    rulesMap[sym] = {
      ...defaultRule,
      ...(preset ?? {}),
      timeStopDays: overrides.symbolTimeStopDaysOverride[sym] ?? preset?.timeStopDays ?? defaultRule.timeStopDays,
      kAtr: overrides.symbolKAtrOverride[sym] ?? preset?.kAtr ?? defaultRule.kAtr,
      stopPct: overrides.symbolStopPctOverride[sym] ?? preset?.stopPct ?? defaultRule.stopPct,
      takeProfitPct:
        overrides.symbolTakeProfitPctOverride[sym] ?? preset?.takeProfitPct ?? defaultRule.takeProfitPct,
      pullbackMax:
        overrides.symbolPullbackMaxOverride[sym] ?? preset?.pullbackMax ?? defaultRule.pullbackMax,
      pullbackMin:
        overrides.symbolPullbackMinOverride[sym] ?? preset?.pullbackMin ?? defaultRule.pullbackMin,
      minReturn50d:
        overrides.symbolMinReturn50dOverride[sym] ?? preset?.minReturn50d ?? defaultRule.minReturn50d,
      maxAtrRatio:
        overrides.symbolMaxAtrRatioOverride[sym] ?? preset?.maxAtrRatio ?? defaultRule.maxAtrRatio,
      maxSma50DeviationPct:
        overrides.symbolMaxSma50DeviationPctOverride[sym] ??
        preset?.maxSma50DeviationPct ??
        defaultRule.maxSma50DeviationPct,
      requireAboveSma50:
        overrides.symbolRequireAboveSma50Override[sym] ??
        preset?.requireAboveSma50 ??
        defaultRule.requireAboveSma50,
    }
  }
  return rulesMap
}
