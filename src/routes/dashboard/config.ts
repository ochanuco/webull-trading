import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { ALL_OVERVIEW_PANELS, OVERVIEW_PANEL_LABELS, type OverviewPanel } from './overview'
import { displaySymbol, esc, inactiveTooltip, isSymbolInactive } from './shared'
import { FIELD_STYLE } from './webullToken'

export function configBody(
  global: Awaited<ReturnType<typeof loadGlobalConfigFrom>>,
  universe: Awaited<ReturnType<typeof loadSymbolUniverse>>,
  overviewPanels: Set<OverviewPanel>,
): string {
  const panelForm = `<div class="card">
    <div class="card-head"><h2 class="card-title">ダッシュボードの表示パネル設定</h2></div>
    <div class="card-body">
      <form method="post" action="/dashboard/config/overview-panels" style="display:flex;flex-direction:column;gap:2px;max-width:560px">
        ${ALL_OVERVIEW_PANELS.map((k) => `<label class="field-check"><input type="checkbox" name="panels" value="${k}"${overviewPanels.has(k) ? ' checked' : ''}/> ${esc(OVERVIEW_PANEL_LABELS[k])}</label>`).join('')}
        <div style="margin-top:6px"><button type="submit" class="btn primary">保存</button></div>
      </form>
      <p class="muted" style="font-size:12px;margin:8px 0 0"><code>/dashboard</code> の概要に表示するパネルを選ぶ。全てオフにすると全パネル表示に戻る。</p>
    </div>
  </div>`
  // Keys stay in snake_case (not translated) so a row can be pasted straight into
  // `UPDATE global_config SET xxx = ...`; the Japanese explanation lives in its own column.
  const globalRows = Object.entries(global as unknown as Record<string, unknown>)
    .filter(([k]) => k !== 'source')
    .map(([k, v]) => {
      const camelKey = k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
      // Column names disagree on the underscore-before-digit convention (min_return_50d has
      // one, require_above_sma50 doesn't), so try the naive form before this variant.
      const camelKeyWithDigitUnderscore = camelKey.replace(/([a-z])(\d)/g, '$1_$2')
      const meta =
        CONFIG_KEY_META[camelKey] ??
        CONFIG_KEY_META[camelKeyWithDigitUnderscore] ??
        CONFIG_KEY_META[k]
      const label = meta?.label ?? '—'
      const detail = meta?.detail ?? '—'
      return `<tr><th style="white-space:nowrap">${esc(camelKey)}</th><td>${esc(formatConfigValue(v))}</td><td class="muted">${esc(label)}</td><td class="muted" style="font-size:12px">${mdBoldToStrong(esc(detail))}</td></tr>`
    })
    .join('')
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
  return `<style>${FIELD_STYLE}</style>
  ${panelForm}

  <div class="card">
    <div class="card-head">
      <h2 class="card-title">グローバル設定</h2>
      <span class="card-actions"><a href="/dashboard/audit">監査ログ</a></span>
    </div>
    <div class="card-body tablewrap">
      <table>
        <thead><tr><th style="white-space:nowrap">設定キー</th><th>値</th><th>説明</th><th>詳細</th></tr></thead>
        <tbody>${globalRows}</tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <h2 class="card-title">銘柄別設定 (active ${universe.allowedSymbols.length} / inactive ${universe.inactiveSymbols.length} 銘柄)</h2>
      <span class="info-tip" tabindex="0" aria-label="無効銘柄の扱い" data-tip="無効 (active=0) の銘柄も一覧に表示する。判定処理の対象は有効銘柄のみで、無効銘柄は灰色斜体と取消線で区別する。再有効化は銘柄編集画面から行う。">?</span>
    </div>
    <div class="card-body tablewrap">
      <table>
        <thead><tr><th>銘柄</th><th>状態</th><th>通貨</th><th title="max_notional">1注文あたり上限</th><th title="inverse">インバース対</th><th title="notes">メモ</th></tr></thead>
        <tbody>${symRows}</tbody>
      </table>
    </div>
  </div>`
}

interface ConfigKeyMeta {
  label: string
  detail: string
}

const CONFIG_KEY_META: Record<string, ConfigKeyMeta> = {
  dry_run: {
    label: 'dry-run (bool)',
    detail: 'true にすると実際には注文せず動作確認だけ。false で証券会社へ本当に注文します。テスト中は true、本番のみ false に。',
  },
  trading_enabled: {
    label: 'trading enabled (bool)',
    detail: 'false にすると全ての注文を拒否します。緊急停止用のスイッチ。止めたい時だけ false に。',
  },
  market_hours_check: {
    label: '場中チェック',
    detail: 'true で市場時間外の注文を防ぎます。false は 24 時間発注可 (動作確認用)。',
  },
  session_window_gate_enabled: {
    label: '開場前ゲート',
    detail:
      'true なら開場30分前から引けまでの時間外は戦略判定を見送る (US 09:00–16:00 ET / JP 08:30–15:30 JST)。false でも通常取引時間外の BUY は見送る。',
  },
  max_order_notional: {
    label: '1注文上限 (非推奨)',
    detail: '旧上限。現在は使われていない。',
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
      '損切り幅ベースでリスク率を使う US 株の資本基準 (ドル)。配分比率指定銘柄は通貨によらず運用資本 (JPY) の共通プールを使うため設定不要。USD でリスク率方式を使う銘柄がある場合のみ設定する。',
  },
  total_capital_jpy: {
    label: '運用資本 (JPY / 口座総額)',
    detail:
      '口座の運用資本 (円)。配分比率指定の銘柄は通貨によらずこの円総額を共通プールとして使う (USD 銘柄も USD/JPY で円換算)。リスク率方式の日本株資本基準も兼ね、買付余力プールの円換算基準でもある。',
  },
  max_portfolio_exposure_pct: {
    label: '同時保有の上限率 (比率)',
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
    label: '寄付ギャップ上限 (比率)',
    detail: '前日終値からの寄付 gap がこの率を超えた銘柄は買わない。0.03 = 3% 以上の gap で見送り。寄付の高値掴みを防ぐ。',
  },
  spread_limit_pct_us: {
    label: 'スプレッド上限 (US、比率)',
    detail: '買値と売値の差 (spread) がこの率を超えた銘柄は流動性不足で見送り。US は 0.25% 目安。',
  },
  spread_limit_pct_jp: {
    label: 'スプレッド上限 (JP、比率)',
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
    detail: '保有を継続する最大日数。この日数を超えても利食い/損切りに達しなければ強制売却。10 = 約 2 週間。',
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
    detail: '過去 20 営業日の騰落率がこの値以上の銘柄だけ押し目買い対象 (0.08 = +8%)。上昇トレンド銘柄を絞るフィルター。列名は 50d のままだが実際の参照期間は 20 営業日。',
  },
  pullback_default_require_above_sma50: {
    label: 'SMA50 超必須',
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
    detail: '1 回のトレードで失ってよい割合 (対 総資本)。0.004 = 0.4%。大きくすると 1 回あたりの買付数量↑、連敗時の損失↑。',
  },
  risk_dd_half_threshold: {
    label: 'リスク半減閾値 (比率、負)',
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
    label: 'VIX 警戒時の発注数量縮小率 (比率)',
    detail: 'VIX 警戒時 (warning ≤ VIX < critical) の発注数量倍率。0.5 = 半分に縮小。1.0 で縮小なし、0 で停止と同義。',
  },
  news_shock_mode: {
    label: 'ニュース急落ゲート モード',
    detail: 'Google/Yahoo の見出し判定で動く。off は無効 (既定)。observe は判定と通知のみ。enforce は shock 0.5 以上で数量縮小、0.8 以上かつ risk_off で新規買い停止。',
  },
  news_shock_warn_size_scale: {
    label: 'ニュース急落 警戒時の発注数量縮小率 (比率)',
    detail: '警戒時の発注数量倍率。0.5 = 半分に縮小。VIX の縮小率と乗算で合成される。',
  },
  attention_stale_policy: {
    label: 'ニュース判定不能時の挙動',
    detail: '最新のニュース判定が無い・45分より古い・取得失敗のとき。fail_open は通常どおり BUY を許可 (既定)。block_buy は新規買いを止める。',
  },
}

function formatConfigValue(v: unknown): string {
  // Em-dash, not the string "null": an operator could mistake literal "null" for a string value.
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

// CONFIG_KEY_META.detail uses `**word**` (author convenience, some notes
// rely on the emphasis to disambiguate e.g. which side of a lookback window
// a number refers to). Input must already be HTML-escaped — this only adds
// trusted `<strong>` tags, so escaping first keeps a literal `<`/`>` in a
// detail string from becoming a tag instead of merely losing its emphasis.
function mdBoldToStrong(escaped: string): string {
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}
