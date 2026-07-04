import type { AppBindings } from '../../app'
import type { Env } from '../../config/env'
import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import { resolveTradingEnabled } from '../../trading/runtime/killSwitch'
import { esc, fmtJst } from './shared'

/**
 * Dashboard-local Hono context shape。`AppBindings.Variables` の `requestId` に
 * 加え、kill-switch banner state を `use('*')` middleware で初頭 load して
 * 全 route から参照可能にする (#276)。
 */
export type DashboardBindings = AppBindings & {
  Variables: AppBindings['Variables'] & {
    killSwitchState: KillSwitchBannerState | null
  }
}

export interface KillSwitchBannerState {
  dbEnabled: boolean
  effective: boolean
  envOverrideActive: boolean
}

export async function loadKillSwitchState(env: Env): Promise<KillSwitchBannerState | null> {
  if (!env.DB) return null
  try {
    const global = await loadGlobalConfigFrom(env)
    const effective = resolveTradingEnabled(global.tradingEnabled, env.TRADING_ENABLED)
    return {
      dbEnabled: global.tradingEnabled,
      effective,
      envOverrideActive: effective !== global.tradingEnabled,
    }
  } catch {
    return null
  }
}

export const STYLE = `
  body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:0;background:#f5f5f7;color:#1d1d1f}
  h1{margin:0 0 16px;font-size:22px}
  /* shell: 上部グローバル nav + main (グローバルメニュー上部化 — 左はページ固有
     コンテンツ用に空ける。チャート個別銘柄タブの銘柄レール等)。
     header は topnav (1段目) + ページ固有 subnav (2段目、例: チャートの
     概要/取引品質/個別銘柄/銘柄グリッド) の最大2段で sticky。 */
  .header{position:sticky;top:0;z-index:100;background:#fff;border-bottom:1px solid #d0d0d5}
  .topnav{display:flex;align-items:center;gap:4px;padding:6px 16px;flex-wrap:wrap}
  .topnav .brand{font-weight:700;font-size:15px;margin-right:12px;white-space:nowrap;color:#1d1d1f}
  .topnav nav{display:flex;align-items:center;gap:2px;flex-wrap:wrap;flex:1;min-width:0}
  .topnav .nav-sep{width:1px;height:18px;background:#d0d0d5;margin:0 8px;flex:0 0 auto}
  .topnav .nav-link{color:#1d1d1f;text-decoration:none;padding:5px 9px;border-radius:7px;font-size:13px;white-space:nowrap}
  .topnav .nav-link:hover{background:#f0f0f3}
  .topnav .nav-link.active{background:#06c;color:#fff;font-weight:600}
  /* kill switch: 上部バー右端の badge + ドロップダウン (details/summary) */
  .topnav-killswitch{margin:0;margin-left:auto;position:relative;flex:0 0 auto}
  .topnav-killswitch summary{list-style:none;cursor:pointer;padding:4px 10px;border:1px solid #d0d0d5;border-radius:7px;font-size:12px;font-weight:600;background:#fafafa;white-space:nowrap}
  .topnav-killswitch summary::-webkit-details-marker{display:none}
  .topnav-killswitch[open] summary{background:#f0f0f3}
  .ks-pop{position:absolute;right:0;top:calc(100% + 6px);background:#fff;border:1px solid #d0d0d5;border-radius:8px;padding:10px 12px;width:240px;box-shadow:0 4px 16px rgba(0,0,0,0.12);z-index:110;font-size:13px}
  .ks-pop .ks-title{font-weight:600;font-size:12px;margin-bottom:2px}
  /* ページ固有 subnav (header 2段目)。topnav active より薄い装飾で階層差を出す */
  .subnav{display:flex;align-items:center;gap:2px;padding:3px 16px 6px;flex-wrap:wrap;border-top:1px solid #f0f0f3}
  .subnav-link{color:#1d1d1f;text-decoration:none;padding:3px 10px;border-radius:6px;font-size:12.5px;white-space:nowrap}
  .subnav-link:hover{background:#f0f0f3}
  .subnav-link.active{background:#e8f0fe;color:#06c;font-weight:600}
  .nav-toggle{display:none;background:none;border:none;font-size:22px;cursor:pointer;padding:4px 8px;color:#1d1d1f;line-height:1}
  .main{min-width:0;padding:24px;overflow-x:auto}
  @media(max-width:780px){
    .main{padding:12px 8px}
    .nav-toggle{display:block}
    .topnav nav{display:none;width:100%;flex-basis:100%;order:10}
    .topnav nav.open{display:flex}
    .topnav .nav-sep{display:none}
    .topnav .nav-link{font-size:14px;padding:8px 12px}
    .topnav-killswitch{order:5}
  }
  /* KPI カード */
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
  .kpi-card{background:#fff;border:1px solid #d0d0d5;border-radius:10px;padding:14px}
  .kpi-label{color:#86868b;font-size:12px;margin-bottom:6px}
  .kpi-value{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
  .kpi-sub{font-size:12px;margin-top:4px;font-variant-numeric:tabular-nums}
  /* パネル (カード) */
  .panel{background:#fff;border:1px solid #d0d0d5;border-radius:10px;padding:16px;margin-bottom:16px}
  .panel>.panel-title{margin:0 0 12px;font-size:14px;font-weight:700}
  .panel-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media(max-width:780px){.panel-row{grid-template-columns:1fr}}
  .panel table{border:none;border-radius:0}
  /* bar (構成比 / movers) */
  .bar-track{background:#f0f0f3;border-radius:4px;height:8px;overflow:hidden;margin-top:3px}
  .bar-fill{height:8px;border-radius:4px;background:#06c}
  .bar-fill.up{background:#057a55}.bar-fill.down{background:#c22}
  .rank-row{display:flex;justify-content:space-between;gap:8px;padding:4px 0;font-size:13px;font-variant-numeric:tabular-nums}
  .pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700}
  .pill.dry{background:#057a55;color:#fff}.pill.live{background:#c22;color:#fff}
  .pill.on{background:#057a55;color:#fff}.pill.off{background:#86868b;color:#fff}
  table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #d0d0d5;border-radius:6px;overflow:hidden}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #e5e5ea;font-size:13px;font-variant-numeric:tabular-nums}
  th{background:#fafafa;font-weight:600}
  tr:last-child td{border-bottom:none}
  .muted{color:#86868b}
  .warn{color:#b25000}
  .err{color:#c22}
  .ok{color:#057a55}
  .footer{margin-top:24px;font-size:11px;color:#86868b}
  details{margin-top:16px}
  summary{cursor:pointer;padding:6px 0;font-weight:600}
  .reason-details{margin:0;min-width:260px}
  .reason-details summary{padding:0;color:#06c;font-weight:400}
  .reason-panel{margin-top:8px;padding:10px;border:1px solid #e5e5ea;border-radius:6px;background:#fafafa;color:#1d1d1f;max-width:680px}
  .reason-panel div{margin:0 0 8px}
  .reason-panel div:last-child{margin-bottom:0}
  .reason-panel ul{margin:4px 0 10px;padding-left:20px}
  .trace-ladder{margin:6px 0 0;font-size:12px}
  .tl-step{display:flex;align-items:baseline;gap:8px;padding:4px 8px;border-left:3px solid transparent;border-radius:4px;flex-wrap:wrap}
  .tl-step.tl-ok{background:#f1f8f4}
  .tl-step.tl-fail{background:#fdf0f0}
  .tl-step.tl-decisive{border-left-color:#06c;font-weight:600;box-shadow:0 0 0 1px #cfe0ff inset}
  .tl-mark{flex:0 0 auto}
  .tl-label{flex:1 1 auto;min-width:140px}
  .tl-cmp{color:#222;font-variant-numeric:tabular-nums}
  .tl-cmp b{color:#06c}
  .tl-msg{color:#86868b;font-style:italic}
  .tl-pick{color:#06c;font-weight:700;font-size:11px}
  .tl-arrow{text-align:center;color:#86868b;line-height:1.1;margin:2px 0}
  .tl-output{padding:6px 10px;border-radius:6px;background:#eef;border:1px solid #cfe0ff}
  .tl-output.tl-out-buy{background:#eafaf0;border-color:#a8e0bf}
  .tl-output.tl-out-sell{background:#fdeeee;border-color:#f0bcbc}
  .tl-output.tl-out-skip,.tl-output.tl-out-reject,.tl-output.tl-out-error{background:#fdf2e8;border-color:#f0d2a8}
  .reason-panel code{white-space:pre-wrap;word-break:break-word}
  .reason-panel pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12px}
  .symbol-disabled{opacity:0.5;font-style:italic;text-decoration:line-through}
  tr.symbol-disabled-row{background:#fafafa}
  tr.symbol-disabled-row td{color:#86868b}
  .grid-panel.symbol-inactive{background:#fafafa;opacity:0.65}
  /* チャート個別銘柄タブの銘柄レール (左固定)。sticky top は topnav の高さ分逃がす */
  .symbol-layout{display:flex;gap:14px;align-items:flex-start}
  /* sticky の top は「自然位置と同じ高さ」に合わせる (--header-h は layout の
     inline script が実測でセット)。top と自然位置がズレていると、スクロール開始
     直後にズレ分だけ要素が動いてから張り付く微妙な jump が出る。
     rail の自然位置 = header 実高 + main padding 24px。 */
  .symbol-rail{flex:0 0 172px;position:sticky;top:calc(var(--header-h,86px) + 24px);background:#fff;border:1px solid #d0d0d5;border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:2px;max-height:calc(100vh - var(--header-h,86px) - 40px);overflow-y:auto;box-sizing:border-box}
  .symbol-rail .rail-head{font-size:11px;color:#86868b;text-transform:uppercase;letter-spacing:0.05em;padding:2px 8px 6px}
  .rail-item{display:flex;flex-direction:column;padding:6px 8px;border-radius:6px;text-decoration:none;color:#1d1d1f}
  .rail-item:hover{background:#f0f0f3}
  .rail-item.active{background:#06c;color:#fff}
  .rail-item.active .rail-name{color:#dce8ff}
  .rail-item.inactive{opacity:0.55}
  .rail-item.inactive .rail-sym{text-decoration:line-through;font-style:italic}
  .rail-sym{font-weight:600;font-size:13px}
  .rail-name{font-size:11px;color:#86868b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .symbol-main{flex:1;min-width:0}
  /* Google Finance 風 range ピル (チャート直下)。active はクリックで JS が付替 */
  .zoom-preset{padding:4px 14px;font-size:12.5px;background:#fff;border:1px solid #dadce0;border-radius:16px;cursor:pointer;color:#3c4043;margin-right:6px}
  .zoom-preset:hover{background:#f8f9fa}
  .zoom-preset.active{background:#e8f0fe;border-color:#e8f0fe;color:#1967d2;font-weight:600}
  /* チャートを sticky 固定: 下の説明 panel 群 (入場ゲート / 判定 trace) を読む間も
     グラフが見え続ける。下からスクロールしてくる panel は z-index と page 背景色で
     チャートの裏に隠す。STYLE は全 page の <style> に埋まるため、コメントにも
     page 本文の assertion に使われる日本語 label をそのまま書かないこと。 */
  /* pin は margin-top:-24px + padding-top:24px で main padding を自前で吸収し、
     自然位置 (= header 直下) と sticky top を一致させて jump をゼロにする。
     吸収した 24px は pin の背景になるので、scroll 中に panel が透けて見える
     隙間も出ない。 */
  .symbol-chart-pin{position:sticky;top:var(--header-h,86px);z-index:50;background:#f5f5f7;margin-top:-24px;padding-top:24px;padding-bottom:8px}
  @media(max-width:780px){
    .symbol-layout{flex-direction:column}
    .symbol-rail{position:static;flex-direction:row;flex-wrap:wrap;width:100%;max-height:none}
    .symbol-rail .rail-head{width:100%}
    /* 小画面では 460px のチャート固定が viewport を食い潰すため解除 */
    .symbol-chart-pin{position:static;margin-top:0;padding-top:0}
  }
`

export function renderLayout(
  c: {
    req: { path: string }
    env: unknown
    var: { killSwitchState: KillSwitchBannerState | null }
  },
  title: string,
  body: string,
  subnav = '',
): string {
  const killSwitch = killSwitchTopnav(c.var.killSwitchState)
  return layout(title, body, c.req.path, killSwitch, subnav)
}

/** グローバル nav 定義 (上部バー)。active link は path 完全一致で強調。 */
export const NAV_GROUPS: ReadonlyArray<{
  label?: string
  links: ReadonlyArray<{ href: string; text: string; title?: string }>
}> = [
  { links: [{ href: '/dashboard', text: 'ホーム' }] },
  {
    label: '取引状況',
    links: [
      { href: '/dashboard/positions', text: 'ポートフォリオ' },
      { href: '/dashboard/portfolio', text: '口座サマリ' },
      { href: '/dashboard/trades', text: '約定履歴' },
    ],
  },
  {
    label: '戦略・監視',
    links: [
      { href: '/dashboard/cron', text: '戦略判定' },
      { href: '/dashboard/charts', text: 'チャート' },
      { href: '/dashboard/alerts', text: 'アラート' },
      { href: '/dashboard/events', text: 'イベント' },
    ],
  },
  {
    label: '運用',
    links: [
      { href: '/dashboard/config', text: '設定' },
      { href: '/dashboard/symbols', text: '銘柄管理' },
      { href: '/dashboard/audit', text: '監査ログ' },
      {
        href: '/dashboard/broker-probe',
        text: 'broker 診断',
        title: 'Webull broker に直接 quote/positions を投げて raw レスポンスを表示する診断ページ',
      },
      {
        href: '/dashboard/webull-token',
        text: 'Webull token',
        title: 'Webull x-access-token の状態確認 / 投入 / refresh (#21 Phase B)',
      },
    ],
  },
]

export function renderTopNav(activePath?: string): string {
  // 上部バーではグループ label を出さず縦罫線で区切る (横幅節約)。
  // グループの意味は各 link の title (hint) で補う。
  return NAV_GROUPS.map((g) => {
    return g.links
      .map((l) => {
        const active = activePath === l.href ? ' active' : ''
        const t = l.title ? ` title="${esc(l.title)}"` : g.label ? ` title="${esc(g.label)}"` : ''
        return `<a class="nav-link${active}" href="${l.href}"${t}>${esc(l.text)}</a>`
      })
      .join('')
  }).join('<span class="nav-sep"></span>')
}

/**
 * 取引 ON/OFF (kill switch) を上部バー右端の badge + ドロップダウンで出す
 * (#276 banner → sidebar → topnav と配置変更)。status ラベル / env override 注記 /
 * 停止・再開フォームは従来と同じ文言・action を維持 (テスト・運用の互換)。
 */
export function killSwitchTopnav(state: KillSwitchBannerState | null): string {
  if (state === null) {
    return `<details class="topnav-killswitch">
      <summary><span class="muted">取引状態: 取得不能</span></summary>
      <div class="ks-pop"><div class="ks-title">取引状態</div><span class="muted" style="font-size:12px">取得不能 (D1 未接続)</span></div>
    </details>`
  }
  const statusLabel = state.effective
    ? '<span class="ok">取引 ON (有効)</span>'
    : '<span class="err">取引 OFF (停止中)</span>'
  const envNote = state.envOverrideActive
    ? `<div class="warn" style="font-size:10px;margin-top:4px;line-height:1.3">⚠ env TRADING_ENABLED で deploy-gate ON: DB を ${state.dbEnabled ? 'ON' : 'OFF'} にしても effective は OFF</div>`
    : ''
  const disabled = state.envOverrideActive ? 'disabled' : ''
  const buttonForm = state.effective
    ? `<form method="post" action="/admin/trading/toggle" class="kill-switch-form" style="display:flex;flex-direction:column;gap:5px;margin-top:6px">
        <input type="hidden" name="enabled" value="false"/>
        <input type="text" name="reason" placeholder="停止理由 (必須)" required maxlength="256" style="padding:4px 6px;font-size:12px;width:100%;box-sizing:border-box"/>
        <button type="submit" ${disabled} style="padding:5px 10px;font-size:12px;background:#c22;color:#fff;border:none;border-radius:4px;cursor:pointer">取引停止</button>
       </form>`
    : `<form method="post" action="/admin/trading/toggle" class="kill-switch-form" onsubmit="return confirm('取引を再開します。本当によろしいですか？');" style="display:flex;flex-direction:column;gap:5px;margin-top:6px">
        <input type="hidden" name="enabled" value="true"/>
        <input type="text" name="reason" placeholder="再開理由 (必須)" required maxlength="256" style="padding:4px 6px;font-size:12px;width:100%;box-sizing:border-box"/>
        <button type="submit" ${disabled} style="padding:5px 10px;font-size:12px;background:#057a55;color:#fff;border:none;border-radius:4px;cursor:pointer">取引再開</button>
       </form>`
  return `<details class="topnav-killswitch">
    <summary>${statusLabel}</summary>
    <div class="ks-pop">
      <div class="ks-title">取引状態: ${statusLabel}</div>
      ${envNote}
      ${buttonForm}
    </div>
  </details>`
}

// ページタイトル h1 は出さない (上部 nav の active 強調で現在地が分かるため
// 冗長 — operator 要望)。title は <title> にのみ残す。
export function layout(
  title: string,
  body: string,
  activePath?: string,
  navRight = '',
  subnav = '',
): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)} — Webull Trading</title>
<style>${STYLE}</style>
</head>
<body>
<header class="header">
  <div class="topnav">
    <div class="brand">Webull Trading</div>
    <button class="nav-toggle" onclick="this.nextElementSibling.classList.toggle('open')" aria-label="メニュー">☰</button>
    <nav>${renderTopNav(activePath)}</nav>
    ${navRight}
  </div>
  ${subnav ? `<nav class="subnav">${subnav}</nav>` : ''}
</header>
<script id="header-h-script">
  // sticky 要素 (.symbol-rail / .symbol-chart-pin) の top に使う header 実高。
  // nav の折り返しで高さが変わるため実測でセットする (CSS 固定値だと自然位置と
  // ズレてスクロール開始時に jump する)。
  // 注: XSS 回帰テストが「未エスケープ payload の生 script 開始タグ」を検出する
  // ため、layout 由来の script tag には属性 (id) を付けて区別する。タグ文字列を
  // この comment 内にもそのまま書かないこと。
  (function () {
    var h = document.querySelector('.header');
    if (!h) return;
    var set = function () {
      document.documentElement.style.setProperty('--header-h', h.offsetHeight + 'px');
    };
    set();
    window.addEventListener('resize', set);
  })();
</script>
<main class="main">
  ${body}
  <div class="footer">画面生成時刻: ${esc(fmtJst(new Date()))}</div>
</main>
</body>
</html>`
}
