import type { AppBindings } from '../../app'
import type { Env } from '../../config/env'
import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import { resolveTradingEnabled } from '../../trading/runtime/killSwitch'
import { esc, fmtJst } from './shared'
import { CHART_THEME_STATIC_PATH } from './charts/shared'

// `killSwitchState` is loaded once by a `use('*')` middleware so every route
// can read it without its own D1 round trip.
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

// Design tokens: every color in this file reads from these custom
// properties (never a literal hex) so a page picks up dark mode and any
// future palette change without its own edit. Dark values are applied both
// by `prefers-color-scheme` (auto) and by `data-theme` (explicit user
// choice, set by the theme-toggle script below) — the `:not([data-theme=
// "light"])` guard lets an explicit "light" choice override a dark OS
// preference.
const TOKENS = `
  :root{
    --bg:#f5f6f8;--surface:#ffffff;--surface-2:#f0f2f5;--surface-3:#e7eaef;
    --border:#e2e5ea;--border-strong:#cdd2da;
    --text:#111827;--text-2:#4b5563;--text-3:#8b93a1;
    --accent:#2f6fed;--accent-soft:#e7eefe;--accent-text:#1d4fd7;
    --up:#0e8a5f;--up-soft:#e3f5ec;--down:#d4453b;--down-soft:#fdeaea;
    --warn:#b45309;--warn-soft:#fdf1e2;--info:#4b6a9b;--info-soft:#eaf0f8;
    --radius:10px;--radius-sm:7px;
    --shadow:0 1px 2px rgba(16,24,40,.04);--shadow-pop:0 8px 24px rgba(16,24,40,.14);
    --font:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",system-ui,sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  @media(prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
      --bg:#0d1117;--surface:#151b23;--surface-2:#1c232d;--surface-3:#252e3a;
      --border:#262f3b;--border-strong:#364152;
      --text:#e6e9ee;--text-2:#aab2bf;--text-3:#7a8494;
      --accent:#5b8cff;--accent-soft:#1b2a4a;--accent-text:#8fb0ff;
      --up:#2fbf85;--up-soft:#12301f;--down:#f06a60;--down-soft:#3a1715;
      --warn:#e0a24a;--warn-soft:#33240f;--info:#8aa6d6;--info-soft:#18233a;
      --shadow:0 1px 2px rgba(0,0,0,.3);--shadow-pop:0 8px 24px rgba(0,0,0,.5);
    }
  }
  :root[data-theme="dark"]{
    --bg:#0d1117;--surface:#151b23;--surface-2:#1c232d;--surface-3:#252e3a;
    --border:#262f3b;--border-strong:#364152;
    --text:#e6e9ee;--text-2:#aab2bf;--text-3:#7a8494;
    --accent:#5b8cff;--accent-soft:#1b2a4a;--accent-text:#8fb0ff;
    --up:#2fbf85;--up-soft:#12301f;--down:#f06a60;--down-soft:#3a1715;
    --warn:#e0a24a;--warn-soft:#33240f;--info:#8aa6d6;--info-soft:#18233a;
    --shadow:0 1px 2px rgba(0,0,0,.3);--shadow-pop:0 8px 24px rgba(0,0,0,.5);
  }
`

const STYLE = `
  ${TOKENS}
  *{box-sizing:border-box}
  body{font-family:var(--font);margin:0;padding:0;background:var(--bg);color:var(--text);font-variant-numeric:tabular-nums}
  a{color:var(--accent-text);text-decoration:none}
  a:hover{text-decoration:underline}
  h1{margin:0 0 16px;font-size:22px}
  /* shell: 上部グローバル nav + main (グローバルメニュー上部化 — 左はページ固有
     コンテンツ用に空ける。チャート個別銘柄タブの銘柄レール等)。
     header は topnav (1段目) + ページ固有 subnav (2段目、例: チャートの
     レビューの 約定履歴/成績/... など) の最大2段で sticky。 */
  .header{position:sticky;top:0;z-index:100;background:var(--surface);border-bottom:1px solid var(--border)}
  .topnav{display:flex;align-items:center;gap:4px;padding:6px 16px;flex-wrap:wrap}
  .topnav .brand{font-weight:700;font-size:15px;margin-right:12px;white-space:nowrap;color:var(--text)}
  .topnav nav{display:flex;align-items:center;gap:2px;flex-wrap:wrap;flex:1;min-width:0}
  .topnav-right{display:flex;align-items:center;gap:8px;margin-left:auto;flex:0 0 auto}
  /* テーマ切替ボタン: 円グリフ1つで auto/light/dark を巡回。状態はグリフでは
     出さず title (aria-label) に持たせる — glyph を状態別に出し分けると
     「今何色か」を判定するアイコンセットが要り、過剰装飾になる。 */
  .theme-toggle{width:28px;height:28px;border-radius:50%;border:1px solid var(--border-strong);background:var(--surface);color:var(--text-2);font-size:14px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
  .theme-toggle:hover{background:var(--surface-2);color:var(--text)}
  /* #dashboard-ia: 運転状態帯のカード。左の色帯で状態を形でも読めるようにする
     (数値だけだと「取引 OFF」を見落とす)。 */
  .state-band{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch;margin-bottom:4px}
  /* flex-grow を持たせると 5 枚が画面幅いっぱいに引き伸ばされ、ラベルと値の
     間が間延びする。自然幅で左詰めにし、余りは緊急停止ボタンの前に残す。 */
  .state-card{flex:0 1 auto;min-width:118px;border:1px solid var(--border);border-left:3px solid var(--border-strong);border-radius:var(--radius-sm);padding:8px 14px;background:var(--surface)}
  .state-card.live{border-left-color:var(--up)}
  .state-card.hold{border-left-color:var(--warn)}
  .state-card.alarm{border-left-color:var(--down)}
  .state-value{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:2px}
  .state-value a{color:inherit;text-decoration:none}
  .state-value a:hover{text-decoration:underline}
  .state-kill{align-self:center;margin-left:auto;background:var(--down-soft);color:var(--down);border:1px solid var(--down);border-radius:var(--radius-sm);padding:8px 14px;font-weight:700;font-size:13px;text-decoration:none;white-space:nowrap}
  .state-kill:hover{filter:brightness(0.96)}
  /* 一行ステータス帯: label/value を縦区切り線で並べる (ホーム運転状態向け)。
     state-band と役割は同じだが、カード単位でなく1本の帯で軽く出したい箇所用。 */
  .stat-strip{display:flex;flex-wrap:wrap;align-items:stretch;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:10px 16px}
  .stat-strip .stat{display:flex;flex-direction:column;gap:2px;padding:2px 16px;border-left:1px solid var(--border)}
  .stat-strip .stat:first-child{border-left:none;padding-left:2px}
  .stat-strip .stat-label{font-size:12px;color:var(--text-3)}
  .stat-strip .stat-value{font-size:15px;font-weight:650;font-variant-numeric:tabular-nums}
  /* #dashboard-ia Phase 3: ホームの領域見出し (運転状態 / リスクと保有銘柄 / 最近の活動)。 */
  .area-label{font-size:11px;letter-spacing:.12em;color:var(--text-3);margin:18px 0 6px;display:flex;align-items:center;gap:8px}
  .area-label::after{content:"";flex:1;height:1px;background:var(--border)}
  .topnav .nav-sep{width:1px;height:18px;background:var(--border);margin:0 8px;flex:0 0 auto}
  .topnav .nav-link{color:var(--text-2);text-decoration:none;padding:5px 9px;border-radius:var(--radius-sm);font-size:13px;white-space:nowrap;box-shadow:inset 0 -2px 0 0 transparent}
  .topnav .nav-link:hover{background:var(--surface-2);color:var(--text)}
  /* underline-indicator タブ: 塗りつぶしピルではなく下線2pxでアクティブを示す
     (#ui-redesign 視覚方針)。box-shadow で敷くので padding/レイアウトは動かない。 */
  .topnav .nav-link.active{background:none;color:var(--accent-text);font-weight:600;box-shadow:inset 0 -2px 0 0 var(--accent)}
  /* kill switch: 上部バー右端の badge + ドロップダウン (details/summary) */
  .topnav-killswitch{margin:0;position:relative;flex:0 0 auto}
  .topnav-killswitch summary{list-style:none;cursor:pointer;padding:4px 10px;border:1px solid var(--border-strong);border-radius:var(--radius-sm);font-size:12px;font-weight:600;background:var(--surface);white-space:nowrap}
  .topnav-killswitch summary::-webkit-details-marker{display:none}
  .topnav-killswitch[open] summary{background:var(--surface-2)}
  .ks-pop{position:absolute;right:0;top:calc(100% + 6px);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px;width:240px;box-shadow:var(--shadow-pop);z-index:110;font-size:13px}
  .ks-pop .ks-title{font-weight:600;font-size:12px;margin-bottom:2px}
  /* 運用ドロップダウン (#dashboard-ia): kill switch と同じ details パターンを
     nav 内に置く。運用系 6 ページ (設定/銘柄管理/イベント/監査/診断/token) を
     1 グループに畳んでグローバル nav を 4 項目に保つ。 */
  .topnav-ops{margin:0;position:relative;flex:0 0 auto}
  .topnav-ops summary{list-style:none;cursor:pointer;font-weight:400}
  .topnav-ops summary::-webkit-details-marker{display:none}
  .topnav-ops[open]>summary:not(.active){background:var(--surface-2)}
  .ops-pop{position:absolute;left:0;top:calc(100% + 6px);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px;min-width:170px;box-shadow:var(--shadow-pop);z-index:110;display:flex;flex-direction:column;gap:2px}
  .ops-pop .nav-link{display:block}
  /* ページ固有 subnav (header 2段目)。topnav active より薄い装飾で階層差を出す */
  .subnav{display:flex;align-items:center;gap:2px;padding:3px 16px 6px;flex-wrap:wrap;border-top:1px solid var(--border)}
  .subnav-link{color:var(--text-2);text-decoration:none;padding:3px 10px;border-radius:6px;font-size:12.5px;white-space:nowrap;box-shadow:inset 0 -2px 0 0 transparent}
  .subnav-link:hover{background:var(--surface-2);color:var(--text)}
  .subnav-link.active{background:none;color:var(--accent-text);font-weight:600;box-shadow:inset 0 -2px 0 0 var(--accent)}
  .nav-toggle{display:none;background:none;border:none;font-size:22px;cursor:pointer;padding:4px 8px;color:var(--text);line-height:1}
  /* 読み幅の上限は全ページ共通 1360px (#ui-redesign)。ページごとに変えると、
     ホームから約定履歴へ移った瞬間に器の幅が変わって落ち着かない。横に長い表
     (約定履歴 / 銘柄管理) は overflow-x で内側にスクロールさせる。 */
  .main{min-width:0;padding:24px;overflow-x:auto;max-width:1360px;margin:0 auto;width:100%}
  @media(max-width:780px){
    .main{padding:12px 8px}
    .nav-toggle{display:block}
    .topnav nav{display:none;width:100%;flex-basis:100%;order:10}
    .topnav nav.open{display:flex}
    .topnav .nav-sep{display:none}
    .topnav .nav-link{font-size:14px;padding:8px 12px}
    .topnav-right{order:5}
    /* 折り畳み nav 内ではドロップダウンをインライン展開 (絶対配置 popup は
       折り畳みメニューの高さ計算を壊すため) */
    .topnav-ops{width:100%}
    .ops-pop{position:static;box-shadow:none;border:none;padding:2px 0 2px 14px}
  }
  /* グリッドユーティリティ (#ui-redesign): ページ側は .grid + .cols-N /
     .span-N の組み合わせだけでレイアウトでき、個別に grid-template を書かずに済む。 */
  .grid{display:grid;gap:16px}
  .grid.cols-2{grid-template-columns:repeat(2,1fr)}
  .grid.cols-3{grid-template-columns:repeat(3,1fr)}
  .grid.cols-12{grid-template-columns:repeat(12,1fr)}
  .grid .span-4{grid-column:span 4}
  .grid .span-8{grid-column:span 8}
  @media(max-width:900px){
    .grid.cols-2,.grid.cols-3,.grid.cols-12{grid-template-columns:1fr}
    .grid .span-4,.grid .span-8{grid-column:auto}
  }
  /* KPI カード (spec の .kpi は .kpi-card の別名 — 既存呼び出し元を壊さず
     新規ページから短い名前で書けるようにする) */
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
  .kpi-card,.kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px}
  .kpi-label{color:var(--text-3);font-size:12px;margin-bottom:6px}
  .kpi-value{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums}
  .kpi-value.hero{font-size:32px}
  .kpi-sub{font-size:12px;margin-top:4px;font-variant-numeric:tabular-nums}
  /* パネル / カード (.card は .panel の別名)。card-head はタイトル行
     (card-title + 任意の info-tip + 右寄せ card-actions) をまとめる。
     チャートはこの中に収め、タイトルは in-canvas ではなく card-head に置く。 */
  .panel,.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:16px;margin-bottom:16px}
  .panel>.panel-title{margin:0 0 12px;font-size:14px;font-weight:600}
  .card-head{display:flex;align-items:center;gap:8px;margin:0 0 12px;flex-wrap:wrap}
  .card-title{font-size:14px;font-weight:600;color:var(--text);margin:0}
  .card-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .card-body{font-size:13px}
  .panel-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media(max-width:780px){.panel-row{grid-template-columns:1fr}}
  .panel table{border:none;border-radius:0}
  /* bar (構成比 / movers) */
  .bar-track{background:var(--surface-2);border-radius:4px;height:8px;overflow:hidden;margin-top:3px}
  .bar-fill{height:8px;border-radius:4px;background:var(--accent)}
  .bar-fill.up{background:var(--up)}.bar-fill.down{background:var(--down)}
  .rank-row{display:flex;justify-content:space-between;gap:8px;padding:4px 0;font-size:13px;font-variant-numeric:tabular-nums}
  .pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700}
  .pill.dry{background:var(--up);color:#fff}.pill.live{background:var(--down);color:#fff}
  .pill.on{background:var(--up);color:#fff}.pill.off{background:var(--text-3);color:#fff}
  /* 状態 pill の色 variant (#dashboard-design)。旧 pillStyle() インライン展開の
     置換 — 効果値 (600 / nowrap / 各色) は旧 pillStyle と同一。 */
  .pill.ok,.pill.warn,.pill.err,.pill.info,.pill.neutral,.pill.buy,.pill.sell{font-weight:600;white-space:nowrap}
  .pill.ok{background:var(--up-soft);color:var(--up)}.pill.warn{background:var(--warn-soft);color:var(--warn)}
  .pill.err{background:var(--down-soft);color:var(--down)}.pill.info{background:var(--info-soft);color:var(--info)}
  .pill.neutral{background:var(--surface-3);color:var(--text-3)}
  /* SELL は損失ではない (建玉解消・利確売りも含む) ので --down を使わない。
     BUY/SELL の色分けは損益ではなく「向き」の表示に留める。 */
  .pill.buy{background:var(--accent-soft);color:var(--accent-text)}
  .pill.sell{background:var(--surface-3);color:var(--text)}
  /* 丸チップ (view 切替 / filter pill / JSON リンク / AI コピー)。active は反転 */
  .chip{padding:3px 12px;border-radius:14px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font-size:12px;text-decoration:none}
  .chip.active{background:var(--text);border-color:var(--text);color:var(--bg)}
  button.chip{cursor:pointer}
  /* セグメント (排他選択): range / period ピルなど。 */
  .seg{display:inline-flex;align-items:center;gap:4px;background:var(--surface-2);border-radius:999px;padding:2px;flex-wrap:wrap}
  .seg>a,.seg>button{padding:4px 12px;font-size:12.5px;border-radius:999px;border:none;background:transparent;color:var(--text-2);cursor:pointer;text-decoration:none;white-space:nowrap;font-family:inherit}
  .seg>a:hover,.seg>button:hover{color:var(--text)}
  .seg>a.active,.seg>button.active,.seg>a.tab-active,.seg>button.tab-active{background:var(--surface);color:var(--text);font-weight:600;box-shadow:var(--shadow)}
  .tab-strip{display:inline-flex;align-items:center;gap:4px;background:var(--surface-2);border-radius:999px;padding:2px}
  .tab{padding:4px 12px;font-size:12.5px;border-radius:999px;color:var(--text-2);text-decoration:none;white-space:nowrap}
  .tab:hover{color:var(--text)}
  .tab.tab-active{background:var(--surface);color:var(--text);font-weight:600;box-shadow:var(--shadow)}
  /* info-tip (#ui-redesign): 長文の運用説明はチャート上に置かず ? アイコンの
     ホバー/フォーカスに退避する。多段落が要る場合は details 版を使う。 */
  .info-tip{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--surface-3);color:var(--text-2);font-size:11px;font-weight:700;cursor:help;position:relative;vertical-align:middle}
  .info-tip:hover::after,.info-tip:focus-visible::after{content:attr(data-tip);position:absolute;left:50%;top:calc(100% + 6px);transform:translateX(-50%);background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);box-shadow:var(--shadow-pop);padding:8px 10px;font-size:12.5px;font-weight:400;white-space:normal;width:max-content;max-width:360px;z-index:200;text-align:left;line-height:1.4}
  .info-tip:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .info-tip-details{display:inline-block}
  .info-tip-details summary{list-style:none;cursor:pointer;display:inline-flex;width:16px;height:16px;border-radius:50%;background:var(--surface-3);color:var(--text-2);font-size:11px;font-weight:700;align-items:center;justify-content:center}
  .info-tip-details summary::-webkit-details-marker{display:none}
  .info-tip-details[open]>:not(summary){margin-top:6px;font-size:12.5px;color:var(--text-2);max-width:360px}
  /* 空状態: 80px の空カードにしない。アイコンなし、1行で済ませる。 */
  .empty{color:var(--text-3);font-size:13px;padding:10px 2px}
  /* ボタン。.btn-sm は既存の「小さいボタン」用サイズ修飾子として維持
     (kill switch フォーム等が単独で使う — .btn と併用させると POC 期の
     呼び出し元を全部書き換える必要が出るため、独立クラスのまま残す)。 */
  .btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;font-size:13px;border-radius:var(--radius-sm);border:1px solid var(--border-strong);background:var(--surface);color:var(--text);cursor:pointer;text-decoration:none;line-height:1.3;font-family:inherit}
  .btn:hover{background:var(--surface-2)}
  .btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  .btn.danger{background:var(--down);border-color:var(--down);color:#fff}
  .btn-sm{padding:3px 8px;font-size:12px;cursor:pointer;border-radius:var(--radius-sm);border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font-family:inherit}
  a.btn-sm{text-decoration:none;display:inline-block}
  .btn-sm.danger{background:var(--down);color:#fff;border:none}
  .btn-sm.ok{background:var(--up);color:#fff;border:none}
  /* 絞り込み中バナー (trades / cron 上部の説明行) */
  .filter-banner{color:var(--text-3);font-size:12px;margin:0 0 6px}
  /* セクション見出し (小ヘッダ)。sh-more は右端の「詳しく見る」導線 */
  .section-head{display:flex;align-items:baseline;gap:10px;margin:0 2px 6px;font-size:13px;font-weight:700}
  .section-head .sh-more{margin-left:auto;font-size:12px;font-weight:400}
  /* ページ内の中見出し (h2/h3 のインライン指定を統一) */
  .sub-head{margin:20px 0 6px;font-size:14px;font-weight:700}
  /* 右寄せ数値セル */
  .num{text-align:right;font-variant-numeric:tabular-nums}
  /* 列数の多い表 (約定履歴 / 銘柄管理) は器の幅に収まらない。ページ全体を
     横スクロールさせると nav ごと動いて操作しづらいので、表だけを内側で
     スクロールさせる。長い表は thead を sticky にして見出しを保つ。 */
  .tablewrap{overflow-x:auto}
  .tablewrap thead th{position:sticky;top:0;z-index:1}
  table{border-collapse:collapse;width:100%;background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden}
  /* table.fit: 列幅を「役割」で決める表。**1 列目に余りを寄せる指定はしない** —
     時刻や状態のような短い列に幅が回ると、値が 1 文字ずつ縦に折り返す。
     既定で全セル nowrap にし、余りは grow を付けた列 (通常は銘柄) だけが吸う。
     ホーム / 約定履歴のように「1 行 1 レコードで読ませたい」表に付ける。 */
  table.fit{table-layout:auto}
  table.fit th,table.fit td{white-space:nowrap}
  table.fit th.grow,table.fit td.grow{width:99%;white-space:normal}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--border);font-size:13px;font-variant-numeric:tabular-nums}
  th{background:var(--surface-2);font-weight:600;color:var(--text-2);font-size:12px}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:var(--surface-2)}
  .muted{color:var(--text-3)}
  .warn{color:var(--warn)}
  .err{color:var(--down)}
  .ok{color:var(--up)}
  .footer{margin-top:24px;font-size:11px;color:var(--text-3)}
  details{margin-top:16px}
  summary{cursor:pointer;padding:6px 0;font-weight:600}
  .reason-details{margin:0;min-width:260px}
  .reason-details summary{padding:0;color:var(--accent-text);font-weight:400}
  .reason-panel{margin-top:8px;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text);max-width:680px}
  .reason-panel div{margin:0 0 8px}
  .reason-panel div:last-child{margin-bottom:0}
  .reason-panel ul{margin:4px 0 10px;padding-left:20px}
  .trace-ladder{margin:6px 0 0;font-size:12px}
  .tl-step{display:flex;align-items:baseline;gap:8px;padding:4px 8px;border-left:3px solid transparent;border-radius:4px;flex-wrap:wrap}
  .tl-step.tl-ok{background:var(--up-soft)}
  .tl-step.tl-fail{background:var(--down-soft)}
  .tl-step.tl-decisive{border-left-color:var(--accent);font-weight:600;box-shadow:0 0 0 1px var(--accent-soft) inset}
  .tl-mark{flex:0 0 auto}
  .tl-label{flex:1 1 auto;min-width:140px}
  .tl-cmp{color:var(--text);font-variant-numeric:tabular-nums}
  .tl-cmp b{color:var(--accent-text)}
  .tl-msg{color:var(--text-3);font-style:italic}
  .tl-pick{color:var(--accent-text);font-weight:700;font-size:11px}
  .tl-arrow{text-align:center;color:var(--text-3);line-height:1.1;margin:2px 0}
  .tl-output{padding:6px 10px;border-radius:6px;background:var(--accent-soft);border:1px solid var(--border)}
  .tl-output.tl-out-buy{background:var(--up-soft);border-color:var(--up)}
  .tl-output.tl-out-sell{background:var(--down-soft);border-color:var(--down)}
  .tl-output.tl-out-skip,.tl-output.tl-out-reject,.tl-output.tl-out-error{background:var(--warn-soft);border-color:var(--warn)}
  .reason-panel code{white-space:pre-wrap;word-break:break-word}
  .reason-panel pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12px}
  .symbol-disabled{opacity:0.5;font-style:italic;text-decoration:line-through}
  tr.symbol-disabled-row{background:var(--surface-2)}
  tr.symbol-disabled-row td{color:var(--text-3)}
  /* チャート個別銘柄タブの銘柄レール (左固定)。sticky top は topnav の高さ分逃がす */
  .symbol-layout{display:flex;gap:14px;align-items:flex-start}
  /* sticky の top は「自然位置と同じ高さ」に合わせる (--header-h は layout の
     inline script が実測でセット)。top と自然位置がズレていると、スクロール開始
     直後にズレ分だけ要素が動いてから張り付く微妙な jump が出る。
     rail の自然位置 = header 実高 + main padding 24px。 */
  /* レールは白カード枠を持たず page 背景に溶かし、active/hover は header subnav
     (.subnav-link) と同じトークン (--accent-soft/--accent-text, --surface-2) を
     使う — 他ページとの見た目統一 (#symbol-rail-restyle)。 */
  .symbol-rail{flex:0 0 172px;position:sticky;top:calc(var(--header-h,86px) + 24px);display:flex;flex-direction:column;gap:2px;max-height:calc(100vh - var(--header-h,86px) - 40px);overflow-y:auto;box-sizing:border-box}
  .symbol-rail .rail-head{font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.05em;padding:2px 8px 6px}
  .rail-item{display:flex;flex-direction:column;padding:6px 10px;border-radius:6px;text-decoration:none;color:var(--text)}
  .rail-item:hover{background:var(--surface-2)}
  .rail-item.active{background:var(--accent-soft);color:var(--accent-text)}
  .rail-item.active .rail-name{color:inherit}
  .rail-item.inactive{opacity:0.55}
  .rail-item.inactive .rail-sym{text-decoration:line-through;font-style:italic}
  .rail-sym{font-weight:600;font-size:13px}
  .rail-name{font-size:11px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .symbol-main{flex:1;min-width:0}
  /* クライアント側銘柄切替 (partial swap) 中の軽い loading フィードバック
     (#charts-symbol-redesign Phase C)。fetch 中だけ付与し、成功/フォールバック
     どちらでも解除される。 */
  .symbol-main.symbol-main-loading{opacity:0.45;transition:opacity 0.15s;pointer-events:none}
  @media(max-width:780px){
    .symbol-layout{flex-direction:column}
    .symbol-rail{position:static;flex-direction:row;flex-wrap:wrap;width:100%;max-height:none}
    .symbol-rail .rail-head{width:100%}
  }
`

// Runs synchronously in <head>, before <style>/<body> — a deferred or
// DOMContentLoaded-gated script would paint the wrong theme for one frame
// (FOUC) whenever the stored choice disagrees with the OS preference.
const THEME_INIT_SCRIPT = `(function(){try{var m=localStorage.getItem('wt-theme');if(m==='light'||m==='dark'){document.documentElement.setAttribute('data-theme',m);}}catch(e){}})();`

function themeToggleLabel(mode: 'auto' | 'light' | 'dark'): string {
  if (mode === 'light') return 'テーマ: ライト固定 (クリックでダークへ)'
  if (mode === 'dark') return 'テーマ: ダーク固定 (クリックで自動へ)'
  return 'テーマ: 自動 (OS 設定に追従、クリックでライト固定へ)'
}

// Wires the button after it exists in the DOM (this script tag sits right
// after it, so no DOMContentLoaded wait is needed). Kept separate from
// THEME_INIT_SCRIPT: that one must run before <style> with zero DOM
// dependency, this one only needs to run before the button is clickable.
function renderThemeToggle(): string {
  const initialTitle = esc(themeToggleLabel('auto'))
  return `<button type="button" class="theme-toggle" id="theme-toggle" aria-label="表示テーマ切替" title="${initialTitle}">◐</button>
  <script id="theme-toggle-script">
    (function () {
      function read() { try { return localStorage.getItem('wt-theme') || 'auto' } catch (e) { return 'auto' } }
      function label(m) {
        if (m === 'light') return ${JSON.stringify(themeToggleLabel('light'))};
        if (m === 'dark') return ${JSON.stringify(themeToggleLabel('dark'))};
        return ${JSON.stringify(themeToggleLabel('auto'))};
      }
      function apply(m) {
        if (m === 'light' || m === 'dark') document.documentElement.setAttribute('data-theme', m);
        else document.documentElement.removeAttribute('data-theme');
        var btn = document.getElementById('theme-toggle');
        if (btn) btn.title = label(m);
      }
      var btn = document.getElementById('theme-toggle');
      if (btn) {
        btn.addEventListener('click', function () {
          var cur = read();
          var next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
          try { localStorage.setItem('wt-theme', next) } catch (e) {}
          apply(next);
        });
      }
      apply(read());
    })();
  </script>`
}

export function renderLayout(
  c: {
    req: { path: string; url: string }
    env: unknown
    var: { killSwitchState: KillSwitchBannerState | null }
  },
  title: string,
  body: string,
  subnav = '',
  pageStyle = '',
): string {
  const killSwitch = killSwitchTopnav(c.var.killSwitchState)
  // /charts splits into '銘柄' vs 'レビュー' by ?tab=, so path alone isn't enough.
  let tab: string | null = null
  try {
    tab = new URL(c.req.url).searchParams.get('tab')
  } catch {
    // Unparseable (e.g. a relative URL) falls back to no tab.
  }
  return layout(title, body, resolveActiveNavGroup(c.req.path, tab), killSwitch, subnav, pageStyle)
}

// `ops` = write-capable pages only. `diag` = rarely opened but not removable:
// it's the only path to incident evidence (alert → requestId → judgment log),
// and MCP depends on the same D1 data so it can't substitute. /positions and
// /portfolio stay URL-reachable but out of the nav (folded into home).
export type NavGroupKey = 'home' | 'symbol' | 'review' | 'ops' | 'diag'

const NAV_GROUPS: ReadonlyArray<{
  key: NavGroupKey
  href: string
  text: string
  title?: string
}> = [
  { key: 'home', href: '/dashboard', text: 'ホーム', title: '今日の状況 (運転状態 / 保有銘柄 / 直近の活動)' },
  { key: 'symbol', href: '/dashboard/charts?tab=symbol', text: '銘柄', title: '個別銘柄チャート (判定 pin / ラダー / 約定マーカー)' },
  { key: 'review', href: '/dashboard/trades', text: 'レビュー', title: '約定履歴 / 成績 / 実現損益の推移' },
]

const OPS_NAV_LINKS: ReadonlyArray<{ href: string; text: string; title?: string }> = [
  { href: '/dashboard/config', text: '設定' },
  { href: '/dashboard/symbols', text: '銘柄管理' },
  { href: '/dashboard/events', text: 'イベント' },
]

const DIAG_NAV_LINKS: ReadonlyArray<{ href: string; text: string; title?: string }> = [
  { href: '/dashboard/alerts', text: 'アラート', title: '通知の履歴 (severity / cause で絞り込み)' },
  { href: '/dashboard/cron', text: '判定ログ', title: 'なぜ買った / 買わなかったかを requestId で追う' },
  { href: '/dashboard/audit', text: '監査ログ', title: '設定変更の before/after と実行者' },
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
  {
    href: '/dashboard/extended-hours',
    text: '時間外参考',
    title: 'US プレマーケット帯の Yahoo 時間外値の参考観測 (#709、売買判断には未接続)',
  },
]

// Prefix match per nav group. /positions and /portfolio are reachable by
// URL but not in the nav, so they resolve to null rather than a group.
export function resolveActiveNavGroup(activePath?: string, tab?: string | null): NavGroupKey | null {
  if (!activePath) return null
  if (activePath === '/dashboard' || activePath === '/dashboard/') return 'home'
  if (activePath === '/dashboard/charts') {
    return tab === 'symbol' || tab === 'grid' ? 'symbol' : 'review'
  }
  if (activePath === '/dashboard/trades' || activePath.startsWith('/dashboard/trades/')) {
    return 'review'
  }
  if (activePath === '/dashboard/lifecycle') {
    return 'review'
  }
  for (const p of ['/dashboard/cron', '/dashboard/alerts', '/dashboard/audit', '/dashboard/broker-probe', '/dashboard/webull-token', '/dashboard/extended-hours']) {
    if (activePath === p || activePath.startsWith(`${p}/`)) return 'diag'
  }
  for (const l of OPS_NAV_LINKS) {
    if (activePath === l.href || activePath.startsWith(`${l.href}/`)) return 'ops'
  }
  return null
}

function renderTopNav(active?: NavGroupKey | null): string {
  const links = NAV_GROUPS.map((g) => {
    const activeCls = active === g.key ? ' active' : ''
    const t = g.title ? ` title="${esc(g.title)}"` : ''
    return `<a class="nav-link${activeCls}" href="${g.href}"${t}>${esc(g.text)}</a>`
  }).join('')
  const popLinks = (items: ReadonlyArray<{ href: string; text: string; title?: string }>) =>
    items
      .map((l) => {
        const t = l.title ? ` title="${esc(l.title)}"` : ''
        return `<a class="nav-link" href="${l.href}"${t}>${esc(l.text)}</a>`
      })
      .join('')
  return `${links}<span class="nav-sep"></span><details class="topnav-ops">
    <summary class="nav-link${active === 'ops' ? ' active' : ''}">管理 ▾</summary>
    <div class="ops-pop">${popLinks(OPS_NAV_LINKS)}</div>
  </details><details class="topnav-ops">
    <summary class="nav-link nav-link-quiet${active === 'diag' ? ' active' : ''}">診断 ▾</summary>
    <div class="ops-pop">${popLinks(DIAG_NAV_LINKS)}</div>
  </details>`
}

// 'cron' / 'alerts' keys stay even though the diag nav owns those pages now —
// pages that still render this subnav need the key to not render as active.
export type AnalysisSubnavKey = 'trades' | 'cron' | 'quality' | 'equity' | 'alerts' | 'lifecycle'

const ANALYSIS_SUBNAV_ITEMS: ReadonlyArray<{
  key: AnalysisSubnavKey
  href: string
  label: string
}> = [
  { key: 'trades', href: '/dashboard/trades', label: '約定履歴' },
  // Labelled "成績" not "取引品質": the content is win rate / PF / expected
  // value / PnL distribution, not slippage or fill rate.
  { key: 'quality', href: '/dashboard/charts?tab=quality', label: '成績' },
  // Labelled to distinguish from account-level portfolio equity.
  { key: 'equity', href: '/dashboard/charts', label: '実現損益の推移' },
  { key: 'lifecycle', href: '/dashboard/lifecycle', label: 'ライフサイクル' },
]

// Diag pages get their own subnav (unlike review) because alert → judgment
// log → audit cross-navigation happens during incident response.
export type DiagSubnavKey = 'alerts' | 'cron' | 'audit' | 'probe' | 'token' | 'extendedHours'

const DIAG_SUBNAV_KEY_BY_HREF: Record<string, DiagSubnavKey> = {
  '/dashboard/alerts': 'alerts',
  '/dashboard/cron': 'cron',
  '/dashboard/audit': 'audit',
  '/dashboard/broker-probe': 'probe',
  '/dashboard/webull-token': 'token',
  '/dashboard/extended-hours': 'extendedHours',
}

export function renderDiagSubnav(active: DiagSubnavKey): string {
  return DIAG_NAV_LINKS.map((l) => {
    const key = DIAG_SUBNAV_KEY_BY_HREF[l.href]
    if (key === active) {
      return `<span class="subnav-link active">${esc(l.text)}</span>`
    }
    return `<a class="subnav-link" href="${l.href}">${esc(l.text)}</a>`
  }).join('')
}

export function renderAnalysisSubnav(active: AnalysisSubnavKey): string {
  return ANALYSIS_SUBNAV_ITEMS.map((i) => {
    if (i.key === active) {
      return `<span class="subnav-link active">${esc(i.label)}</span>`
    }
    return `<a class="subnav-link" href="${i.href}">${esc(i.label)}</a>`
  }).join('')
}

// Status label / env-override note / stop-resume form text and action must
// stay byte-for-byte what they were before this moved to the topnav —
// existing tests and operator muscle memory depend on the exact wording.
function killSwitchTopnav(state: KillSwitchBannerState | null): string {
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
        <button type="submit" ${disabled} class="btn-sm danger">取引停止</button>
       </form>`
    : `<form method="post" action="/admin/trading/toggle" class="kill-switch-form" onsubmit="return confirm('取引を再開します。本当によろしいですか？');" style="display:flex;flex-direction:column;gap:5px;margin-top:6px">
        <input type="hidden" name="enabled" value="true"/>
        <input type="text" name="reason" placeholder="再開理由 (必須)" required maxlength="256" style="padding:4px 6px;font-size:12px;width:100%;box-sizing:border-box"/>
        <button type="submit" ${disabled} class="btn-sm ok">取引再開</button>
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

// No h1: active-nav highlighting already shows current location, so a page
// title would be redundant (per operator request). Kept in <title> only.
function layout(
  title: string,
  body: string,
  activeNav?: NavGroupKey | null,
  navRight = '',
  subnav = '',
  pageStyle = '',
): string {
  return `<!doctype html>
<html lang="ja">
<head>
<script id="theme-init-script">${THEME_INIT_SCRIPT}</script>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)} — Webull Trading</title>
<style>${STYLE}</style>
${pageStyle ? `<style>${pageStyle}</style>` : ''}
</head>
<body>
<header class="header">
  <div class="topnav">
    <div class="brand">Webull Trading</div>
    <button class="nav-toggle" onclick="this.nextElementSibling.classList.toggle('open')" aria-label="メニュー">☰</button>
    <nav>${renderTopNav(activeNav)}</nav>
    <div class="topnav-right">
      ${renderThemeToggle()}
      ${navRight}
    </div>
  </div>
  ${subnav ? `<nav class="subnav">${subnav}</nav>` : ''}
</header>
<script src="${CHART_THEME_STATIC_PATH}" defer></script>
<script id="header-h-script">
  // Measured (not fixed CSS) header height, since nav wrapping changes it —
  // a fixed value would drift from the sticky rail/pin's natural position.
  // The id attribute lets the XSS-regression test tell this script tag
  // apart from an unescaped payload's own raw script tag — do not write a
  // literal script tag string in this comment, or that check breaks.
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
<main class="main${activeNav === 'home' ? ' main-narrow' : ''}">
  ${body}
  <div class="footer">画面生成時刻: ${esc(fmtJst(new Date()))}</div>
</main>
</body>
</html>`
}
