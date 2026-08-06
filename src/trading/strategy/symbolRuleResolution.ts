import type { SymbolRole, SymbolRoleValue } from '../../infrastructure/db/symbolConfigRepo'
import {
  type MomentumRule,
  TEST_DEFAULT_MOMENTUM_RULE,
} from './strategies/BreakoutMomentumStrategy'
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
 *   しないと事実上 entry 不可能になる (#449 課題2)。
 * - `low_volatility` / `sector_trend` / `inverse_hedge`: #457 で有効化。設計根拠
 *   (ボラスケーリング・守る失敗モード) は issue #457 参照。
 *
 * **全 preset の数値は backtest 未検証の初期推定** — 個別銘柄で合わない場合は
 * per-symbol override で吸収し、チューニングは後続 issue。迷う値は一貫して
 * 「トレードが減る側」(fail-closed) を採用している。
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
  // USMV / SPLV (年率ボラ ~12%、日次 ~0.5%)。entry と exit の両方を約 1/3〜1/5
  // にスケールダウン — レバ向け global では entry gate が永久に開かず (-3% の
  // 押しが稀)、exit が永久に閉じない (-4% stop は 4-5σ、+7% TP は数ヶ月モノ)。
  low_volatility: {
    // 20d +1.5% ≈ 年率 ~20% ペース = 低ボラ ETF の「明確な上昇」下限。
    minReturn50d: 0.015,
    // 10d 高値から ~0.6σ の押し。-3% 超 (~2σ) はレジーム破綻疑いで買わない。
    pullbackMax: -0.01,
    pullbackMin: -0.03,
    // +10% 乖離はほぼ起きない値 → ガードとして機能する水準に。
    maxSma50DeviationPct: 0.1,
    // ボラ圧縮プロダクトの前提 (ATR が baseline 近傍) が壊れた局面で entry しない。
    maxAtrRatio: 1.3,
    // exit 側: stop -1.5% ≈ 3 日分の通常変動、TP +2.5% ≈ 15 営業日の ~1.3σ
    // (R:R ~1.67)。低ボラの mean-reversion は解決が遅いので time stop は 15 日
    // (preset 中唯一「保有を増やす」側の変更)。
    stopPct: -0.015,
    takeProfitPct: 0.025,
    timeStopDays: 15,
  },
  // SMH / SOXX / XLK (1x セクター、core_trend と global の中間ボラ ~1.5x QQQ)。
  // entry 側のみ中間値にスケールし、**exit は global 据え置き** (stop -4% ≈ 日次
  // 2-2.5σ で floor として妥当、変更点を entry 4 つに絞って overfit を避ける)。
  // 注意: SMH/SOXX は SOXL と原資産がほぼ同一 — leveraged_trend と同時有効化
  // するとセクター集中が起きる。rule preset では守れず配分側の責務 (#457)。
  sector_trend: {
    minReturn50d: 0.04,
    pullbackMax: -0.02,
    pullbackMin: -0.05,
    // 強気相場の SMH は SMA50 +20% 超まで走る — 0.2 は切りすぎ、0.6 は効かない。
    maxSma50DeviationPct: 0.3,
  },
  // SQQQ / SOXS (3x インバース)。市場下落レジームでの inverse 押し目買い。
  // daily-rebalance のボラ drag が保有日数に複利で効くため **短期保有・早い退出**。
  // trend filter (inverse 自身の 20d リターン) がレジーム判定を兼ねる。
  // **PSQ 等 1x インバースにはこの preset は合わない** (minReturn50d 0.15 は
  // 1x では発火不能) — 使う場合は per-symbol override で吸収する (#457)。
  inverse_hedge: {
    // SQQQ +15%/20d ≈ QQQ -5%。チョップ域 (drag で構造的に負ける) を弾く。
    minReturn50d: 0.15,
    // panic spike の頂点圏 (+40% 乖離超) で買わない — 次は bear rally の確率大。
    maxSma50DeviationPct: 0.4,
    // 1 週間で決着しなければ手仕舞い。レジーム継続なら trend gate が再 entry を
    // 承認するので長く持つ必要がない。
    timeStopDays: 5,
    // bear rally (1 日 +5-10% の逆行が普通) を「通常変動」として耐えない。
    kAtr: 1.5,
  },
}

/**
 * Entry (BUY 生成) が有効な role。`undefined` (= role NULL、従来挙動) もこの
 * 集合とは別に常に有効。
 *
 * - `cash_parking` は pullback 判定が無意味 (SMA50 / 押し目が成立しない) なので
 *   strategy 経由の BUY を抑止する。配分は #452 PR 3 の条件連動配分
 *   (`always_active`) が別経路で扱う。
 * - `low_volatility` / `sector_trend` / `inverse_hedge` は #457 で preset 付きで
 *   有効化。inverse_hedge は inverse_pairs 排他 gate (両建て防止) が引き続き
 *   下流で効く。
 * - repo が enum 外 DB 値を正規化した 'unknown' はここに含まれない (= 抑止)。
 */
const ENTRY_ENABLED_ROLES: ReadonlySet<SymbolRole> = new Set([
  'core_trend',
  'leveraged_trend',
  'low_volatility',
  'sector_trend',
  'inverse_hedge',
  // #momentum: entry 有効 (BreakoutMomentumStrategy で判定)。
  'momentum',
])

/**
 * 段階判定 HALF (0.5x entry) を有効にする symbol 集合を作る (#452 PR 2)。
 * entry 有効 role (core_trend / leveraged_trend) を**明示的に**設定した銘柄のみ。
 * role NULL の既存銘柄は含めない = 従来の二値挙動のまま (受け入れ条件の回帰保証)。
 */
export function buildHalfEntrySymbols(
  symbolRole: Record<string, SymbolRoleValue>,
): Set<string> {
  const enabled = new Set<string>()
  for (const [symbol, role] of Object.entries(symbolRole)) {
    // #momentum: モメンタムは HALF 昇格 (degree-gate の near-threshold 許容) と
    // 相性が悪い (ブレイク未達=もっと手前で 0.5x は逆効果) ので除外。
    if (role === 'momentum') continue
    if (role !== 'unknown' && ENTRY_ENABLED_ROLES.has(role)) enabled.add(symbol)
  }
  return enabled
}

/** role === 'momentum' の symbol 集合 (#momentum)。scheduler の戦略分岐に使う。 */
export function buildMomentumSymbols(symbolRole: Record<string, SymbolRoleValue>): Set<string> {
  const set = new Set<string>()
  for (const [symbol, role] of Object.entries(symbolRole)) {
    if (role === 'momentum') set.add(symbol)
  }
  return set
}

/**
 * strategy cron が BUY を生成してはいけない symbol → 抑止理由、の map を作る
 * (#452)。SELL / HOLD (exit 経路) は対象外 — role を後から変えた銘柄に保有が
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

/**
 * role === 'momentum' の symbol ごとに MomentumRule を組み立てる (#momentum)。
 * `TEST_DEFAULT_MOMENTUM_RULE` を基準に、既存 override 列 (stop/tp/timeStop/kAtr/
 * minReturn/maxSma50Dev/requireAboveSma50) を重ねる。breakoutBuffer に対応する
 * override 列は無いので preset 値のまま。
 */
export function buildMomentumRules(
  overrides: SymbolRuleOverrides,
  base: MomentumRule = TEST_DEFAULT_MOMENTUM_RULE,
): Record<string, MomentumRule> {
  const rules: Record<string, MomentumRule> = {}
  for (const [sym, role] of Object.entries(overrides.symbolRole)) {
    if (role !== 'momentum') continue
    rules[sym] = {
      ...base,
      stopPct: overrides.symbolStopPctOverride[sym] ?? base.stopPct,
      takeProfitPct: overrides.symbolTakeProfitPctOverride[sym] ?? base.takeProfitPct,
      timeStopDays: overrides.symbolTimeStopDaysOverride[sym] ?? base.timeStopDays,
      kAtr: overrides.symbolKAtrOverride[sym] ?? base.kAtr,
      minReturn: overrides.symbolMinReturn50dOverride[sym] ?? base.minReturn,
      maxSma50DeviationPct:
        overrides.symbolMaxSma50DeviationPctOverride[sym] ?? base.maxSma50DeviationPct,
      requireAboveSma50: overrides.symbolRequireAboveSma50Override[sym] ?? base.requireAboveSma50,
    }
  }
  return rules
}
