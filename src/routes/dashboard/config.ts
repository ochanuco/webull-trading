import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { ALL_OVERVIEW_PANELS, OVERVIEW_PANEL_LABELS, type OverviewPanel } from './overview'
import { displaySymbol, esc, inactiveTooltip, isSymbolInactive } from './shared'

export function configBody(
  global: Awaited<ReturnType<typeof loadGlobalConfigFrom>>,
  universe: Awaited<ReturnType<typeof loadSymbolUniverse>>,
  overviewPanels: Set<OverviewPanel>,
): string {
  // #dashboard-mf-layout: overview パネル ON/OFF。POST → PRG redirect (#293 と同型)。
  const panelForm = `<details open>
    <summary>ダッシュボード overview パネル表示</summary>
    <form method="post" action="/dashboard/config/overview-panels" style="margin:8px 0;display:flex;flex-direction:column;gap:6px;max-width:560px">
      ${ALL_OVERVIEW_PANELS.map((k) => `<label style="font-size:13px"><input type="checkbox" name="panels" value="${k}"${overviewPanels.has(k) ? ' checked' : ''}/> ${esc(OVERVIEW_PANEL_LABELS[k])}</label>`).join('')}
      <div><button type="submit" style="padding:4px 12px;font-size:13px;background:#06c;color:#fff;border:none;border-radius:6px;cursor:pointer">保存</button></div>
    </form>
    <p class="muted" style="font-size:12px"><code>/dashboard</code> の overview に表示するパネル。全て OFF にすると全表示に戻ります。</p>
  </details>`
  // 列名 (snake_case) は SQL での copy-paste 互換のため英字のまま残し、
  // 日本語説明は別列に分離。これで `UPDATE global_config SET xxx = ...` が
  // そのまま使える。
  const globalRows = Object.entries(global as unknown as Record<string, unknown>)
    .filter(([k]) => k !== 'source')
    .map(([k, v]) => {
      const camelKey = k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
      // DB 列名の digit 前 underscore は列ごとに揺れがある
      // (min_return_50d は有 / require_above_sma50 は無)。
      // naive 版 → digit 前 underscore 版の順でフォールバック。
      const camelKeyWithDigitUnderscore = camelKey.replace(/([a-z])(\d)/g, '$1_$2')
      const meta =
        CONFIG_KEY_META[camelKey] ??
        CONFIG_KEY_META[camelKeyWithDigitUnderscore] ??
        CONFIG_KEY_META[k]
      const label = meta?.label ?? '—'
      const detail = meta?.detail ?? '—'
      return `<tr><th>${esc(camelKey)}</th><td>${esc(formatConfigValue(v))}</td><td class="muted">${esc(label)}</td><td class="muted" style="font-size:11px">${esc(detail)}</td></tr>`
    })
    .join('')
  // active + inactive 両方を 1 つの table で表示。inactive 行は grayed-out 化し、
  // 「状態」「メモ (notes)」列で disable 経緯が読める。cron 評価対象は active=1 のみ
  // (allowedSymbols)、表示のみ全件出すのが今 PR の趣旨。
  const allConfigSymbols = [...universe.allowedSymbols, ...universe.inactiveSymbols]
  const symRows = allConfigSymbols
    .map((sym) => {
      const inactive = isSymbolInactive(sym, universe)
      const rowClass = inactive ? ' class="symbol-disabled-row"' : ''
      const symbolClass = inactive ? ' class="symbol-disabled"' : ''
      const titleAttr = inactive ? ` title="${esc(inactiveTooltip(sym, universe))}"` : ''
      const stateCell = inactive
        ? '<span class="muted">inactive</span>'
        : '<span class="ok">active</span>'
      const noteText = universe.symbolNotes[sym] ?? null
      const noteCell = noteText ? esc(noteText) : '<span class="muted">—</span>'
      return `<tr${rowClass}>
          <td><strong><span${symbolClass}${titleAttr}>${esc(displaySymbol(sym, universe))}</span></strong></td>
          <td>${stateCell}</td>
          <td>${esc(universe.symbolCurrency[sym] ?? '—')}</td>
          <td>${universe.symbolMaxNotional[sym] != null ? esc(universe.symbolMaxNotional[sym]) : '<span class="muted">—</span>'}</td>
          <td>${universe.inversePairs[sym] ? esc(universe.inversePairs[sym]) : '<span class="muted">—</span>'}</td>
          <td>${noteCell}</td>
        </tr>`
    })
    .join('')
  return `${panelForm}
  <p class="muted" style="font-size:12px;margin:0 0 10px">
    設定変更は before/after が記録されます — <a href="/dashboard/audit">監査ログを見る →</a>
  </p>
  <details open>
    <summary>グローバル設定 (global_config)</summary>
    <table>
      <thead><tr><th>Key</th><th>値</th><th>説明</th><th>詳細</th></tr></thead>
      <tbody>${globalRows}</tbody>
    </table>
  </details>
  <details open>
    <summary>銘柄別設定 (symbol_config) — active ${universe.allowedSymbols.length} / inactive ${universe.inactiveSymbols.length} 銘柄</summary>
    <p class="muted" style="font-size:12px">
      inactive (active=0) 銘柄も表示しています。cron / risk gate の評価対象は active=1 のみで、
      inactive 銘柄は灰色斜体・取消線で区別しています。再有効化は <code>UPDATE symbol_config SET active = 1 WHERE symbol = '...'</code>。
    </p>
    <table>
      <thead><tr><th>銘柄</th><th>状態</th><th>通貨</th><th>1注文あたり上限 (max_notional)</th><th>インバース対 (inverse)</th><th>メモ (notes)</th></tr></thead>
      <tbody>${symRows}</tbody>
    </table>
  </details>`
}

/**
 * global_config 列のメタ情報 (label + detail)。
 *
 * - `label`: 短い見出し (単位込み)。IT / 汎用英単語 (dry-run / drawdown / spread
 *   等) は英字のまま、日本株固有語 (押し目 / 建玉 / 利食い / 損切り / 騰落率)
 *   のみ日本語化。
 * - `detail`: 株初心者向け advisory。1-3 文、「何をするか」「大小で何が変わるか」
 *   「目安」の順で記述。技術用語を避け具体的な動作で説明。
 *
 * 未登録 key の fallback は em-dash。
 */
export interface ConfigKeyMeta {
  label: string
  detail: string
}

export const CONFIG_KEY_META: Record<string, ConfigKeyMeta> = {
  dry_run: {
    label: 'dry-run (bool)',
    detail: 'true にすると実際には注文せず動作確認だけ。false で証券会社へ本当に注文します。テスト中は true、本番のみ false に。',
  },
  trading_enabled: {
    label: 'trading enabled (bool)',
    detail: 'false にすると全ての注文を拒否します。緊急停止用のスイッチ。止めたい時だけ false に。',
  },
  market_hours_check: {
    label: '場中チェック (bool)',
    detail: 'true で市場時間外の注文を防ぎます。false は 24 時間発注可 (sandbox 確認用)。',
  },
  session_window_gate_enabled: {
    label: '開場前ゲート (bool)',
    detail:
      'true で開場30分前〜引けの窓外は戦略判定を skip (US 09:00–16:00 ET / JP 08:30–15:30 JST、市場ごと)。cron は発火しますが評価しません。false は従来通り常時評価。',
  },
  max_order_notional: {
    label: '1注文上限 (非推奨)',
    detail: '旧 generic 上限 (通貨別 cap 導入前の互換)。現在は参照されないので触らなくて OK。',
  },
  max_order_notional_usd: {
    label: '1注文上限 (USD)',
    detail: 'US 株 1 回あたりの発注上限額 (ドル)。大きすぎる注文を防ぐ安全装置。$2000 なら 1 銘柄最大 $2000 まで。',
  },
  max_order_notional_jpy: {
    label: '1注文上限 (JPY)',
    detail: '日本株 1 回あたりの発注上限額 (円)。同上の円版。¥100000 なら 1 銘柄最大 10 万円まで。',
  },
  total_capital_usd: {
    label: '運用資本 (USD)',
    detail:
      'risk-% sizing (stop 距離ベース) の US 株 equity 基準 (ドル)。budget配分% (budget_alloc_pct) 指定銘柄は通貨に関係なく total_capital_jpy 単一プールを使うため、こちらは不要 (USD risk-% 銘柄がある時のみ設定)。',
  },
  total_capital_jpy: {
    label: '運用資本 (JPY / 口座総額)',
    detail:
      '口座の運用資本 (円)。budget配分% (budget_alloc_pct) 指定銘柄は通貨に関係なく **この円総額が単一プール基準** (USD 銘柄も USD/JPY で円換算して sizing、#407)。risk-% sizing の日本株 equity 基準も兼ねる。買付余力 pool ゲートの円換算基準でもある (#415)。',
  },
  max_portfolio_exposure_pct: {
    label: 'portfolio exposure 上限率 (比率)',
    detail: '同時保有の合計上限を「資本 × この率」で決めます。0.6 なら 60%。大きくすると分散度↑、損失時の衝撃↑。',
  },
  drawdown_kill_threshold: {
    label: 'drawdown kill 閾値 (比率、負)',
    detail: 'その日の損失がこの割合を超えたら、その日は新規売買を止めます。きつく -2% だと早く止まる、緩く -8% だと下げを我慢して継続。',
  },
  stale_quote_ms: {
    label: '気配値鮮度上限 (ms)',
    detail: '気配値が古すぎる時に判定を止める閾値。900000 = 15 分。短いと厳格、長いと古い気配でも売買。',
  },
  gap_reject_pct: {
    label: 'gap reject 閾値 (比率)',
    detail: '前日終値からの寄付 gap がこの率を超えた銘柄は買わない。0.03 = 3% 以上の gap で見送り。寄付の高値掴みを防ぐ。',
  },
  spread_limit_pct_us: {
    label: 'spread 上限率 (US、比率)',
    detail: '買値と売値の差 (spread) がこの率を超えた銘柄は流動性不足で見送り。US は 0.25% 目安。',
  },
  spread_limit_pct_jp: {
    label: 'spread 上限率 (JP、比率)',
    detail: '買値と売値の差 (spread) がこの率を超えた銘柄は流動性不足で見送り。日本株は 0.6% 目安。',
  },
  pullback_default_stop_pct: {
    label: '損切り幅 (比率、負)',
    detail: '損切りライン。買値からこの率下がったら売却。-0.04 = -4%。深いと耐えるが大損失リスク、浅いと早く切るが騙し上げで空振り。',
  },
  pullback_default_take_profit_pct: {
    label: '利食い目標 (比率)',
    detail: '利食い目標。買値からこの率上がったら売却。0.07 = +7%。高いと大きな利益を狙うが取り逃す、低いとコツコツ確定。',
  },
  pullback_default_time_stop_days: {
    label: '最大保有日数 (営業日)',
    detail: '建玉を保有する最大日数。この日数を超えても利食い/損切りに達しなければ強制売却。10 = 約 2 週間。',
  },
  pullback_default_pullback_max: {
    label: '押し目上限 (比率、負)',
    detail: '押し目買いを狙う「浅い側」の下落率閾値。**直近 10 営業日の高値**から -0.03 なら「-3% 以上下げた銘柄を候補に」。緩めると機会↑、騙し↑。',
  },
  pullback_default_pullback_min: {
    label: '押し目下限 (比率、負)',
    detail: '押し目買いを狙う「深い側」の下落率閾値。**直近 10 営業日の高値**から -0.06 なら「-6% より深い下げは敬遠」。深すぎる下げは反発せず転換の可能性。',
  },
  pullback_default_min_return_50d: {
    label: '20日最低騰落率 (比率)',
    detail: '過去 **20 営業日** の騰落率がこの値以上の銘柄だけ押し目買い対象。0.08 = +8%。上昇トレンド銘柄を絞るフィルター。列名の `50d` は #318 で lookback を 50→20 日に短縮した際の名残 (storage 互換のため据え置き)。',
  },
  pullback_default_require_above_sma50: {
    label: 'SMA50 超必須 (bool)',
    detail: 'true で 50 日移動平均線より上の銘柄だけ買い対象。上昇トレンドフィルターを厳しくする。',
  },
  pullback_default_k_atr: {
    label: 'ATR 倍率',
    detail: '損切り幅を ATR (日々の値動き幅) の何倍にするか。2.0 が標準。大きくすると激しい値動き銘柄でも余裕を持って保有、小さいと早めに損切り。',
  },
  pullback_default_max_sma50_deviation_pct: {
    label: '過熱ガード: SMA50 上方乖離上限 (比率)',
    detail: '株価が 50 日移動平均をこの比率超で上回る過熱局面では押し目買いを見送る。0.6 = +60%。+3x レバ ETF の高値掴み回避。小さいほど厳しく BUY を抑制。',
  },
  pullback_default_max_atr_ratio: {
    label: '過熱ガード: ATR比上限 (倍)',
    detail: '直近 ATR が baseline (**直近 20 日を除いた**長期平均) のこの倍率を超える高ボラ局面では押し目買いを見送る。1.5 = baseline の 1.5 倍。ボラ・レジーム破綻時の entry を抑制。',
  },
  risk_base_per_trade_pct: {
    label: '基本リスク率 (比率)',
    detail: '1 回のトレードで失ってよい割合 (対 総資本)。0.004 = 0.4%。大きくすると 1 回あたりの建玉サイズ↑、連敗時の損失↑。',
  },
  risk_dd_half_threshold: {
    label: 'risk half 閾値 (比率、負)',
    detail: '日次損失がこの率を超えたら 1 回のリスクを半分に減らす。-0.05 = -5%。連敗時の傷を浅く保つ自動ブレーキ。',
  },
  risk_dd_halt_threshold: {
    label: 'risk halt 閾値 (比率、負)',
    detail: '日次損失がこの率を超えたら 1 回のリスクを 0 に (新規 entry 停止)。-0.10 = -10%。drawdown_kill より前の緊急ブレーキ。',
  },
  vix_warning_threshold: {
    label: 'VIX 警戒閾値',
    detail: '恐怖指数 (VIX) がこの値を超えたら新規買いの数量を縮小。25 が標準。下げると早めに用心、上げると VIX 高でも普段通り。',
  },
  vix_critical_threshold: {
    label: 'VIX 緊急閾値',
    detail: '恐怖指数 (VIX) がこの値を超えたら新規買いを全停止 (売却は通常通り)。30 が標準。下げると守り重視、上げると荒れ相場でも買いに行く。',
  },
  vix_warning_size_scale: {
    label: 'VIX 警戒時の建玉縮小率 (比率)',
    detail: 'VIX 警戒時 (warning ≤ VIX < critical) の発注数量倍率。0.5 = 半分に縮小。1.0 で縮小なし、0 で停止と同義。',
  },
  news_shock_mode: {
    label: 'ニュース過熱ゲート モード',
    detail: 'off (無効、既定) / observe (判定を記録するだけで数量は変えない) / enforce (実際に数量を縮小/停止)。',
  },
  news_shock_warn_ratio: {
    label: 'ニュース過熱 警戒倍率',
    detail: '直近報道量の最大値が baseline (直近の中央値) のこの倍率を超えたら警戒 (数量縮小)。2.3 が標準 (GDELT 実測 上位10%相当)。',
  },
  news_shock_block_ratio: {
    label: 'ニュース過熱 緊急倍率',
    detail: '警戒倍率に加え、この倍率を超え、かつ論調悪化条件も満たすと新規買いを全停止。4.4 が標準 (GDELT 実測 上位1%相当)。',
  },
  news_shock_warn_size_scale: {
    label: 'ニュース過熱 警戒時の建玉縮小率 (比率)',
    detail: '警戒時の発注数量倍率。0.5 = 半分に縮小。VIX の縮小率と乗算で合成される。',
  },
  news_shock_tone_drop_threshold: {
    label: 'ニュース過熱 論調悪化しきい値',
    detail: '緊急停止に追加で要求する論調の悪化幅 (baseline 論調 − 直近論調)。報道量が増えただけ (好材料) では止めないための条件。',
  },
  news_shock_require_tone: {
    label: 'ニュース過熱 論調条件を要求 (bool)',
    detail: 'true (既定) で緊急停止に論調悪化を必須にする。false なら報道量急増だけで緊急停止しうる。',
  },
  news_shock_baseline_days: {
    label: 'ニュース過熱 baseline 日数',
    detail: '報道量の「通常水準」を測る trailing 日数。7 が標準。',
  },
  news_shock_min_samples: {
    label: 'ニュース過熱 baseline 最小サンプル数',
    detail: 'baseline 算出に必要な観測点の下限。未満なら判定不能扱い (縮小/停止しない)。200 が標準。',
  },
  news_shock_window_min: {
    label: 'ニュース過熱 直近窓 (分)',
    detail: '報道量の急増を見る直近窓の長さ。120分 (2時間) が標準。',
  },
  news_shock_max_age_min: {
    label: 'ニュース過熱 観測の鮮度上限 (分)',
    detail: '最新観測がこれより古いと判定不能 (stale) 扱い。90分が標準。',
  },
  attention_stale_policy: {
    label: 'ニュース観測 stale 時の挙動',
    detail: 'fail_open (既定、判定不能なら通常通り BUY を許可) / block_buy (判定不能なら新規買いを止める、operator の明示的な安全側切替)。',
  },
}

export function formatConfigValue(v: unknown): string {
  // null placeholder は他ページと同じ em-dash (—) に統一。"null" 文字列は
  // 運用者が誤って "null" という string 値と混同するリスクがあるので避ける。
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}
