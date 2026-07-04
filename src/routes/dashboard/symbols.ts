import type { SymbolRole } from '../../infrastructure/db/symbolConfigRepo'
import { parseCashFallbacksJson, SYMBOL_ROLES } from '../../infrastructure/db/symbolConfigRepo'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import type { TradableAllowlist, TradableStatus } from '../../infrastructure/db/tradableInstrumentsRepo'
import { symbolConfig, type SymbolConfigRow } from '../../infrastructure/db/schema'
import type { PairRegimeEntry } from '../../trading/strategy/pairRegime'
import { asc, eq, or } from 'drizzle-orm'
import { layout } from './layout'
import { buyingPowerBadge } from './overview'
import { esc, fmtPct, safeJsonScript, unavailable } from './shared'

/**
 * 銘柄管理 (#292) ページの SELECT。`symbol_config` 全行 (active + inactive)
 * を symbol ASC で返す。dashboard 表示専用。
 */
export async function loadAllSymbolConfigRows(db: D1Database): Promise<SymbolConfigRow[]> {
  const drizzle = createDb(db)
  return await drizzle.select().from(symbolConfig).orderBy(asc(symbolConfig.symbol))
}

export async function findSymbolConfigForView(
  db: D1Database,
  symbol: string,
): Promise<SymbolConfigRow | null> {
  const drizzle = createDb(db)
  const rows = await drizzle
    .select()
    .from(symbolConfig)
    .where(eq(symbolConfig.symbol, symbol))
    .limit(1)
  return rows[0] ?? null
}

export interface SymbolsListFilter {
  status: 'all' | 'active' | 'inactive'
  market: 'all' | 'US' | 'JP'
  q: string
}

export function applySymbolsListFilter(rows: SymbolConfigRow[], f: SymbolsListFilter): SymbolConfigRow[] {
  const needle = f.q.trim().toLowerCase()
  return rows.filter((r) => {
    if (f.status === 'active' && !r.active) return false
    if (f.status === 'inactive' && r.active) return false
    if (f.market !== 'all' && r.market !== f.market) return false
    if (needle) {
      const hay = `${r.symbol} ${r.name ?? ''}`.toLowerCase()
      if (hay.indexOf(needle) === -1) return false
    }
    return true
  })
}

export const ROLE_NODE_COLORS: Record<string, string> = {
  cash_parking: '#5b8c5a',
  core_trend: '#1a56db',
  leveraged_trend: '#d97706',
  low_volatility: '#7e3af2',
  sector_trend: '#0e9f9f',
  inverse_hedge: '#c22d2d',
}

/**
 * 配分マップキャンバス (#symbol-relation-map)。描画単位は **unit (対 = 1 カード、
 * 単独銘柄 = 1 カード)** — 対を 2 カード + 連動パッチ (ミラー線・連動移動・
 * 共有側ポート非表示) で表現していた旧方式は edit/view で不整合が漏れ続けた
 * ため、operator の指定で一塊に再設計した。
 *
 *   - ペアカード: `SOXL ⇄ SOXS`。両側の状態を 1 枚に表示、配分は対で 1 枠
 *   - 口座 → unit = 配分 1 本 (1/枝)。unit → unit = 退避 1 本 (緑破線) で、
 *     適用時に**側別に展開** (対→対は role で側合わせ、対→単独は両側→同一先)
 *   - 単独 → 対の退避は側を特定できないため不可 (理由付き拒否)
 *   - 'view' はノード移動のみ可 (編集系は封印)、'edit' は draft + 適用
 * DB / API は従来の銘柄単位のまま — 展開はこのキャンバスの適用時のみ。
 */
export function symbolMapEditorBody(
  rows: SymbolConfigRow[],
  inversePairs: Record<string, string>,
  amounts: Record<string, { native: string; jpy: number }>,
  opts: { mode?: 'edit' | 'view'; pairRegimes?: PairRegimeEntry[]; tradable?: TradableAllowlist } = {},
): string {
  const mode = opts.mode ?? 'edit'
  const pairRegimes = opts.pairRegimes ?? []
  const tradable: TradableAllowlist = opts.tradable ?? new Map()
  // unit の取扱 status = メンバー中で最も重い状態 (unknown > disappeared > tradable)。
  // ペアで片側が取扱不可なら警告を出す。
  const tradeRank: Record<TradableStatus, number> = { tradable: 0, disappeared: 1, unknown: 2 }
  const unitTradeBadge = (syms: string[]): string => {
    let worst: TradableStatus = 'tradable'
    for (const x of syms) {
      const s = tradable.get(x.toUpperCase())?.status ?? 'unknown'
      if (tradeRank[s] > tradeRank[worst]) worst = s
    }
    return tradableBadgeHtml(worst)
  }
  const bySym = new Map(rows.map((r) => [r.symbol.toUpperCase(), r]))
  const pctOf = (r: SymbolConfigRow): number =>
    r.budgetAllocPct != null ? Math.round(r.budgetAllocPct * 1000) / 10 : 0

  // unit 構築: 対 (両方登録済み) は 1 unit。並びは leveraged 側を先頭に。
  interface Unit {
    id: string
    syms: string[]
    label: string
    currency: string
    color: string
    roles: Record<string, string | null>
    pct: number
    active: boolean
    held: Record<string, string>
    entryRequired: boolean
    fallbackSyms: Record<string, string[]>
    y: number
  }
  const units: Unit[] = []
  const unitOfSym: Record<string, string> = {}
  const usedSyms = new Set<string>()
  for (const r of rows) {
    const sym = r.symbol.toUpperCase()
    if (usedSyms.has(sym)) continue
    const partnerSym = inversePairs[sym]?.toUpperCase()
    const partner = partnerSym !== undefined ? bySym.get(partnerSym) : undefined
    let syms = [sym]
    if (partner !== undefined) {
      usedSyms.add(partnerSym!)
      syms = [sym, partnerSym!]
      // leveraged (bull) 側を先頭に揃える (側合わせの基準)。
      syms.sort((a, b) => {
        const ra = bySym.get(a)?.role === 'leveraged_trend' ? 0 : 1
        const rb = bySym.get(b)?.role === 'leveraged_trend' ? 0 : 1
        return ra - rb || a.localeCompare(b)
      })
    }
    usedSyms.add(sym)
    const members = syms.map((x) => bySym.get(x)!)
    const unit: Unit = {
      id: syms.join('/'),
      syms,
      label: syms.join(' ⇄ '),
      currency: r.currency,
      color: ROLE_NODE_COLORS[members[0]!.role ?? ''] ?? '#5f6368',
      roles: Object.fromEntries(syms.map((x) => [x, bySym.get(x)?.role ?? null])),
      pct: Math.max(...members.map(pctOf)),
      active: members.some((m) => m.active),
      held: Object.fromEntries(
        syms.filter((x) => amounts[x] !== undefined).map((x) => [x, amounts[x]!.native]),
      ),
      entryRequired: members.some((m) => m.entryRequired === true),
      fallbackSyms: Object.fromEntries(
        syms.map((x) => [x, parseCashFallbacksJson(bySym.get(x)?.cashFallbackSymbols, x)]),
      ),
      y: 0,
    }
    for (const x of syms) unitOfSym[x] = unit.id
    units.push(unit)
  }
  const onCanvas = units.filter((u) => u.active)
  if (onCanvas.length === 0) {
    return `<p class="muted">有効な銘柄がありません。</p>`
  }
  // unit の退避先 (unit 単位、#496 多分岐): 各側の fallback リストが指す unit
  // 群の和集合。側ごとの食い違い (旧データの片側欠け等) は適用で側別に正規化
  // される。
  const fallbackUnitsOf = (u: Unit): string[] => {
    const targets = u.syms
      .flatMap((x) => u.fallbackSyms[x] ?? [])
      .map((x) => unitOfSym[x] ?? null)
      .filter((x): x is string => x !== null)
    return [...new Set(targets)]
  }
  // JPY 群 → USD 群で縦に並べる。
  let yCursor = 30
  for (const ccy of ['JPY', 'USD']) {
    for (const u of onCanvas.filter((x) => x.currency === ccy)) {
      u.y = yCursor
      yCursor += 130
    }
  }
  const payload = {
    mode,
    units: onCanvas.map((u) => ({
      id: u.id,
      syms: u.syms,
      label: u.label,
      currency: u.currency,
      color: u.color,
      roles: u.roles,
      pct: u.pct,
      held: u.held,
      entryRequired: u.entryRequired,
      fallbacks: fallbackUnitsOf(u),
      // #460: OpenAPI 取扱バッジ HTML (tradable は空文字)。card に innerHTML 挿入。
      tradeBadge: unitTradeBadge(u.syms),
      y: u.y,
    })),
    // スポーン在庫: 盤面に無い (= 全側 inactive) unit。
    inventory: units
      .filter((u) => !u.active)
      .map((u) => ({
        id: u.id,
        syms: u.syms,
        label: u.label,
        currency: u.currency,
        color: u.color,
        roles: u.roles,
        tradeBadge: unitTradeBadge(u.syms),
      })),
    unitOfSym,
  }

  // 脚注チップ: regime proxy (盤面の unit に関係するもののみ)。misconfig は警告。
  const activeSyms = new Set(onCanvas.flatMap((u) => u.syms))
  const chips: string[] = []
  for (const pair of pairRegimes) {
    const members = [pair.proxySymbol, pair.bullSymbol, pair.bearSymbol].map((x) => x.toUpperCase())
    if (!members.some((x) => activeSyms.has(x))) continue
    if (pair.invalidConfig !== null) {
      chips.push(`<span style="padding:2px 8px;border-radius:10px;background:#fff4e5;color:#9a5b00;font-size:11px">⚠ regime misconfig ${esc(pair.bullSymbol.toUpperCase())}/${esc(pair.bearSymbol.toUpperCase())}: ${esc(pair.invalidConfig)} (zone=unknown で両側 BUY 停止中)</span>`)
      continue
    }
    chips.push(`<span style="padding:2px 8px;border-radius:10px;background:#f1ebfd;color:#7e3af2;font-size:11px">regime proxy ${esc(pair.proxySymbol.toUpperCase())} → ${esc(pair.bullSymbol.toUpperCase())}/${esc(pair.bearSymbol.toUpperCase())}</span>`)
  }
  const chipRow = chips.length > 0
    ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${chips.join('')}</div>`
    : ''
  const legend = `塗り: <span style="background:#5f6368;border:1px solid #3c4043;color:#fff;padding:0 6px;border-radius:4px">口座</span>
      <span style="background:#fdf3f2;border:1px solid #d4a09a;padding:0 6px;border-radius:4px">JPY</span>
      <span style="background:#f0f6ff;border:1px solid #9ab8dd;padding:0 6px;border-radius:4px">USD</span>
      <span style="color:#8a8f98">実線 = 配分</span>
      <span style="color:#0e9f6e">緑破線 = 退避</span>`
  const helpText = [
    '口座 → カードの線 = 配分 (1/枝 均等。対は 1 カード = 1 枠)',
    'カード → カードの線 = 退避先 (緑破線)。対→対は適用時に側別へ展開 (bull→bull / bear→bear)',
    '単独銘柄 → 対への退避は側を特定できないため不可',
    '線の削除 = 線を選択 → Backspace / Delete',
    '線を空中で放す = 既存 Inactive を呼び出して紐づけ (適用で有効化)',
    '口座から到達できないカードは適用時に無効化 (保有中は除く)',
    '変更は「適用」までは保存されない',
  ].join('\n')
  const header = mode === 'edit'
    ? `<p style="margin:0 0 6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <a href="/dashboard/symbols" style="font-size:13px">← 銘柄管理</a>
    <button type="button" id="sm-simulate" style="padding:4px 12px;background:#fff;border:1px solid #06c;color:#06c;border-radius:6px;cursor:pointer;font-size:12px">シミュレート</button>
    <button type="button" id="sm-delete-conn" disabled style="padding:4px 12px;background:#fff;border:1px solid #ccc;color:#999;border-radius:6px;cursor:pointer;font-size:12px">選択中の線を削除</button>
    <span title="${esc(helpText)}" style="cursor:help;color:#9aa0a6;font-size:14px;border:1px solid #d0d0d5;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center">?</span>
    <span class="muted" style="font-size:12px">${legend}</span>
  </p>
  <div id="sm-changes-bar" hidden style="position:sticky;top:0;z-index:10;display:flex;gap:10px;align-items:flex-start;padding:8px 12px;background:#fff8e6;border:1px solid #e6c46a;border-radius:8px;margin-bottom:8px">
    <div style="flex:1;min-width:0">
      <strong style="font-size:12px">未適用の変更</strong>
      <ul id="sm-changes-list" style="margin:4px 0 0 16px;padding:0;font-size:12px"></ul>
    </div>
    <button type="button" id="sm-apply" style="padding:6px 18px;background:#06c;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">適用</button>
    <button type="button" id="sm-reset" style="padding:6px 12px;background:#fff;border:1px solid #ccc;border-radius:6px;cursor:pointer;font-size:13px">リセット</button>
  </div>`
    : `<p class="muted" style="margin:0 0 6px;font-size:12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <a href="/dashboard/symbols/map">✏️ 編集モード</a>
    <button type="button" id="sm-simulate" style="padding:3px 10px;background:#fff;border:1px solid #06c;color:#06c;border-radius:6px;cursor:pointer;font-size:12px">シミュレート</button>
    <span title="${esc(helpText)}" style="cursor:help;color:#9aa0a6;font-size:13px;border:1px solid #d0d0d5;border-radius:50%;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center">?</span>
    <span>${legend}</span>
  </p>`
  const canvasHeight = mode === 'edit'
    ? 'height:calc(100vh - 150px);min-height:520px'
    : `height:${Math.max(300, yCursor + 60)}px`
  return `${header}
  <div id="sm-sim-meta" hidden style="display:flex;gap:10px;align-items:center;margin:0 0 6px;padding:6px 10px;background:#eafaf1;border:1px solid #0e9f6e;border-radius:8px;font-size:12px">
    <strong style="color:#0e9f6e">シミュレーション表示中</strong>
    <span id="sm-sim-meta-text" class="muted" style="flex:1;min-width:0"></span>
    <button type="button" id="sm-sim-clear" style="padding:2px 10px;background:#fff;border:1px solid #0e9f6e;color:#0e9f6e;border-radius:6px;cursor:pointer;font-size:12px">クリア</button>
  </div>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/drawflow@0.0.60/dist/drawflow.min.css">
  <style>
  #symbol-map-editor{${canvasHeight};background:#fafafa;border:1px solid #d0d0d5;border-radius:8px}
  #symbol-map-editor .drawflow .drawflow-node{background:#fff;border:2px solid #d0d0d5;border-radius:10px;padding:0;width:210px;box-shadow:0 1px 4px rgba(0,0,0,0.08)}
  #symbol-map-editor .drawflow .drawflow-node.selected{border-color:#06c}
  #symbol-map-editor .drawflow .drawflow-node.sm-dirty{border-color:#e6a23c;box-shadow:0 0 0 3px rgba(230,162,60,0.25)}
  #symbol-map-editor .drawflow .drawflow-node.sm-account{background:#5f6368;border-color:#3c4043}
  #symbol-map-editor .drawflow .drawflow-node.sm-jpy{background:#fdf3f2;border-color:#d4a09a}
  #symbol-map-editor .drawflow .drawflow-node.sm-usd{background:#f0f6ff;border-color:#9ab8dd}
  #symbol-map-editor .drawflow .drawflow-node .input,
  #symbol-map-editor .drawflow .drawflow-node .output{background:#9aa0a6;border:2px solid #6e6e73;width:14px;height:14px}
  #symbol-map-editor .drawflow .drawflow-node .input:hover,
  #symbol-map-editor .drawflow .drawflow-node .output:hover{background:#6e6e73}
  #symbol-map-editor.sm-view .drawflow .drawflow-node .input,
  #symbol-map-editor.sm-view .drawflow .drawflow-node .output{pointer-events:none}
  /* 退避線は保存済みでも緑破線 (配分の実線と常に区別がつくように)。 */
  #symbol-map-editor svg.connection.sm-fallback path{stroke:#0e9f6e !important;stroke-dasharray:7 5;stroke-width:2.5px}
  #symbol-map-editor svg.connection.sm-pending path{stroke-width:3.5px !important}
  .sm-card{padding:8px 10px;font-size:12px}
  .sm-card .sm-title{font-size:14px;font-weight:700}
  .sm-card .sm-status-active{color:#0e9f6e;font-size:11px}
  .sm-card .sm-status-pending{color:#b25000;font-size:11px}
  .sm-card .sm-meta{color:#6e6e73;font-size:10px;margin-top:2px}
  .sm-card .sm-share{font-weight:600}
  /* シミュレーション結果はカードの「外」に浮かせる (#496 follow-up): フロー内に
     置くとカードが伸び、Drawflow が線の端点を再計算しないため点と線がズレる。
     absolute overlay なら几何が一切変わらない。 */
  #symbol-map-editor .drawflow .drawflow-node{overflow:visible}
  .sm-sim-wrap{position:absolute;top:calc(100% + 4px);left:2px;right:2px;z-index:6;display:flex;flex-direction:column;gap:3px;pointer-events:none}
  .sm-sim{padding:3px 6px;border-radius:6px;font-size:10px;line-height:1.5;box-shadow:0 1px 4px rgba(0,0,0,0.18)}
  .sm-sim.sm-sim-active{background:#eafaf1;color:#0b6e4f}
  .sm-sim.sm-sim-reroute{background:#fff4e5;color:#9a5b00}
  .sm-sim.sm-sim-recv{background:#eafaf1;color:#0b6e4f;border:1px dashed #0e9f6e}
  #symbol-map-editor svg.connection.sm-sim-flow path{stroke:#0e9f6e !important;stroke-width:4px;stroke-dasharray:10 6;animation:smflow 1.2s linear infinite}
  #symbol-map-editor svg.connection.sm-sim-dim path{opacity:0.25}
  @keyframes smflow{to{stroke-dashoffset:-32}}
  </style>
  <div id="symbol-map-editor"></div>
  ${chipRow}
  ${safeJsonScript('__symbolMapEditor', payload)}
  <script src="https://cdn.jsdelivr.net/npm/drawflow@0.0.60/dist/drawflow.min.js"></script>
  <script>
  document.addEventListener('DOMContentLoaded', function () {
    var data = window.__symbolMapEditor;
    var el = document.getElementById('symbol-map-editor');
    if (!data || !el || typeof Drawflow === 'undefined') return;
    var isView = data.mode === 'view';
    var editor = new Drawflow(el);
    editor.reroute = false;
    editor.start();
    if (isView) el.classList.add('sm-view');

    // 盤面レイアウトの記憶 (#496 follow-up): ノード位置とパン/ズームを
    // localStorage に保存する (origin 単位・管理画面のみなのでティッカーと座標が
    // 残る程度は許容、operator 合意)。view/edit でキーを共有して同じ配置に。
    var LAYOUT_KEY = 'webull-sm-map-layout-v1';
    var savedLayout = {};
    try {
      savedLayout = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') || {};
    } catch (e) { savedLayout = {}; }
    var savedPos = savedLayout.pos || {};
    function persistLayout() {
      try {
        var pos = {};
        Object.keys(idOf).forEach(function (uid) {
          var d2 = editor.drawflow.drawflow[editor.module].data[idOf[uid]];
          if (d2) pos[uid] = { x: d2.pos_x, y: d2.pos_y };
        });
        Object.keys(accountIds).forEach(function (ccy) {
          var d2 = editor.drawflow.drawflow[editor.module].data[accountIds[ccy]];
          if (d2) pos['__account_' + ccy + '__'] = { x: d2.pos_x, y: d2.pos_y };
        });
        localStorage.setItem(LAYOUT_KEY, JSON.stringify({
          pos: pos,
          zoom: editor.zoom,
          canvasX: editor.canvas_x,
          canvasY: editor.canvas_y,
        }));
      } catch (e) { /* private mode 等は黙って諦める (表示専用機能) */ }
    }

    var idOf = {};      // unitId -> drawflow node id
    var unitOf = {};    // drawflow node id -> unitId
    var unitBy = {};    // unitId -> unit payload
    var baseline = {};  // unitId -> { pct, fallback, active }
    var draft = {};     // unitId -> { connected, fallback }
    var programmatic = false;

    var currencies = [];
    data.units.forEach(function (u) { if (currencies.indexOf(u.currency) === -1) currencies.push(u.currency); });
    currencies.sort();
    var accountIds = {};
    var accountCcyOf = {};
    var nJpy = data.units.filter(function (u) { return u.currency === 'JPY'; }).length;
    currencies.forEach(function (ccy) {
      var label = ccy === 'JPY' ? '日本口座 (JPY)' : '米国口座 (USD)';
      var y = ccy === 'JPY' ? 30 + ((Math.max(nJpy, 1) - 1) * 130) / 2 : 30 + nJpy * 130 + ((Math.max(data.units.length - nJpy, 1) - 1) * 130) / 2;
      var saved = savedPos['__account_' + ccy + '__'];
      var id = editor.addNode('口座' + ccy, 0, 1, saved ? saved.x : 40, saved ? saved.y : y, 'sm-node sm-account',
        { unit: '口座' + ccy },
        '<div class="sm-card"><div class="sm-title" style="color:#fff">' + label + '</div>' +
        '<div class="sm-meta" style="color:#e8eaed">—</div></div>');
      accountIds[ccy] = id;
      unitOf[id] = '__account_' + ccy + '__';
      accountCcyOf['__account_' + ccy + '__'] = ccy;
    });

    function unitCardHtml(u, spawned) {
      var heldSyms = Object.keys(u.held || {});
      var statusHtml = heldSyms.length > 0
        ? '<div class="sm-status-active">Active ・ ' + heldSyms.map(function (x) { return x + ' ' + u.held[x]; }).join(' / ') + '</div>'
        : spawned
          ? '<div class="sm-status-pending">Inactive (適用で有効化)</div>'
          : '<div class="sm-status-pending">Pending (様子見' + (u.entryRequired ? '・条件連動 ON' : '') + ')</div>';
      var roleShorts = u.syms.map(function (x) { return u.roles[x]; }).filter(Boolean);
      var metaParts = [];
      if (roleShorts.length > 0) metaParts.push(roleShorts.join(' / '));
      metaParts.push(u.currency);
      // #460: OpenAPI 取扱バッジ (server 生成済み HTML、tradable は空)。
      var tradeBadgeHtml = u.tradeBadge ? '<div style="margin-top:4px">' + u.tradeBadge + '</div>' : '';
      return '<div class="sm-card">' +
        '<div class="sm-title" style="color:' + u.color + '">' + u.label + '</div>' +
        statusHtml +
        tradeBadgeHtml +
        '<div style="margin-top:4px">配分 <span class="sm-share" id="sm-share-' + u.id.replace('/', '_') + '">—</span></div>' +
        '<div class="sm-meta">' + metaParts.join(' ・ ') + '</div>' +
        '</div>';
    }
    function addUnitNode(u, x, y, opts2) {
      var spawned = !!(opts2 && opts2.spawned);
      unitBy[u.id] = u;
      baseline[u.id] = baseline[u.id] || { pct: u.pct || 0, fallbacks: (u.fallbacks || []).slice().sort(), active: !spawned };
      draft[u.id] = { connected: (u.pct || 0) > 0, fallbacks: (u.fallbacks || []).slice() };
      var id = editor.addNode(u.id, 1, 1, x, y, 'sm-node ' + (u.currency === 'JPY' ? 'sm-jpy' : 'sm-usd'), { unit: u.id }, unitCardHtml(u, spawned));
      idOf[u.id] = id;
      unitOf[id] = u.id;
      return id;
    }
    data.units.forEach(function (u) {
      var saved = savedPos[u.id];
      addUnitNode(u, saved ? saved.x : (u.pct > 0 ? 360 : 760), saved ? saved.y : u.y);
    });

    function tagConnectionClass(srcId, dstId, cls) {
      var conn = el.querySelector('svg.connection.node_in_node-' + dstId + '.node_out_node-' + srcId);
      if (conn) conn.classList.add(cls);
    }
    programmatic = true;
    data.units.forEach(function (u) {
      if (u.pct > 0) editor.addConnection(accountIds[u.currency], idOf[u.id], 'output_1', 'input_1');
      (u.fallbacks || []).forEach(function (fb) {
        if (!idOf[fb]) return;
        editor.addConnection(idOf[u.id], idOf[fb], 'output_1', 'input_1');
        tagConnectionClass(idOf[u.id], idOf[fb], 'sm-fallback');
      });
    });
    programmatic = false;

    // パン/ズームの復元と、移動・ズームのたびの保存。
    if (typeof savedLayout.zoom === 'number' && savedLayout.zoom > 0.2 && savedLayout.zoom <= 2) {
      editor.zoom = savedLayout.zoom;
      editor.canvas_x = savedLayout.canvasX || 0;
      editor.canvas_y = savedLayout.canvasY || 0;
      editor.zoom_refresh();
    }
    editor.on('nodeMoved', function () { persistLayout(); });
    editor.on('zoom', function () { persistLayout(); });
    editor.on('translate', function () { persistLayout(); });

    function deriveShares() {
      var branches = 0;
      Object.keys(draft).forEach(function (uid) { if (draft[uid].connected) branches += 1; });
      var share = branches > 0 ? Math.round((100 / branches) * 10) / 10 : 0;
      var shares = {};
      Object.keys(draft).forEach(function (uid) { shares[uid] = draft[uid].connected ? share : 0; });
      return { branches: branches, share: share, shares: shares };
    }
    function renderShares() {
      var d = deriveShares();
      Object.keys(draft).forEach(function (uid) {
        var span = document.getElementById('sm-share-' + uid.replace('/', '_'));
        if (!span) return;
        span.textContent = draft[uid].connected ? '1/' + d.branches + ' = ' + d.share + '%' : 'なし (risk-%)';
      });
      currencies.forEach(function (ccy) {
        var accountEl = document.getElementById('node-' + accountIds[ccy]);
        if (!accountEl) return;
        var meta = accountEl.querySelector('.sm-meta');
        if (!meta) return;
        var n = 0;
        Object.keys(draft).forEach(function (uid) {
          if (draft[uid].connected && unitBy[uid].currency === ccy) n += 1;
        });
        var subtotal = Math.round(n * d.share * 10) / 10;
        meta.textContent = n + ' 枝 ・ 小計 ' + subtotal + '% (全体 ' + d.branches + ' 枝 ・ 1 枝 = ' + (d.branches > 0 ? d.share + '%' : '—') + ')';
      });
      return d;
    }

    // ---- シミュレーション (両モード共通)。結果は銘柄 → unit カードに重ねる。
    var simBtn = document.getElementById('sm-simulate');
    function clearSim() {
      el.querySelectorAll('.sm-sim-wrap').forEach(function (n) { n.remove(); });
      el.querySelectorAll('svg.connection.sm-sim-flow').forEach(function (n) { n.classList.remove('sm-sim-flow'); });
      el.querySelectorAll('svg.connection.sm-sim-dim').forEach(function (n) { n.classList.remove('sm-sim-dim'); });
      document.getElementById('sm-sim-meta').hidden = true;
    }
    var clearBtn = document.getElementById('sm-sim-clear');
    if (clearBtn) clearBtn.addEventListener('click', clearSim);
    function simBadge(uid, cls, html) {
      var nodeEl = document.getElementById('node-' + idOf[uid]);
      if (!nodeEl) return;
      var wrap = nodeEl.querySelector('.sm-sim-wrap');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'sm-sim-wrap';
        nodeEl.appendChild(wrap);
      }
      var div = document.createElement('div');
      div.className = 'sm-sim ' + cls;
      div.innerHTML = html;
      wrap.appendChild(div);
    }
    // 適用/シミュレートで使う「unit → 銘柄ごとの fallback 展開」(#496 多分岐)。
    // 各 src 側は dst unit ごとに 1 銘柄ずつ受け取る:
    //   対→対: 役割で側合わせ (leveraged↔leveraged)、なければ並び順。
    //   対→単独: 両側 → 同一先。単独→単独: そのまま。
    function expandFallbacks(srcUid, dstUids) {
      var src = unitBy[srcUid];
      var out = {};
      src.syms.forEach(function (x) { out[x] = (dstUids && dstUids.length > 0) ? [] : null; });
      (dstUids || []).forEach(function (dstUid) {
        var dst = unitBy[dstUid];
        src.syms.forEach(function (x, i) {
          var pick;
          if (dst.syms.length === 1) {
            pick = dst.syms[0];
          } else {
            var role = src.roles[x];
            var match = null;
            dst.syms.forEach(function (y) { if (dst.roles[y] === role && role) match = y; });
            pick = match || dst.syms[Math.min(i, dst.syms.length - 1)];
          }
          out[x].push(pick);
        });
      });
      return out;
    }
    function fallbacksChanged(uid) {
      var a = (draft[uid].fallbacks || []).slice().sort().join(',');
      var b = (baseline[uid].fallbacks || []).slice().sort().join(',');
      return a !== b;
    }
    if (simBtn) simBtn.addEventListener('click', function () {
      simBtn.disabled = true;
      simBtn.textContent = '計算中…';
      var bodyPayload = {};
      if (!isView) {
        var d = deriveShares();
        var pcts = {};
        var fallbacks = {};
        Object.keys(draft).forEach(function (uid) {
          var u = unitBy[uid];
          if (d.shares[uid] !== baseline[uid].pct) {
            u.syms.forEach(function (x) { pcts[x] = d.shares[uid] > 0 ? d.shares[uid] : null; });
          }
          if (fallbacksChanged(uid)) {
            var exp = expandFallbacks(uid, draft[uid].fallbacks);
            Object.keys(exp).forEach(function (x) { fallbacks[x] = exp[x]; });
          }
        });
        bodyPayload = { pcts: pcts, fallbacks: fallbacks };
      }
      fetch('/admin/allocation/simulate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
      })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (res) {
          clearSim();
          var pctTxt = function (w) { return Math.round(w * 1000) / 10 + '%'; };
          Object.keys(draft).forEach(function (uid) {
            (draft[uid].fallbacks || []).forEach(function (fb) {
              if (idOf[fb]) tagConnectionClass(idOf[uid], idOf[fb], 'sm-sim-dim');
            });
          });
          var planBySym = {};
          if (res.plan) res.plan.orders.forEach(function (o) { planBySym[o.symbol] = o; });
          Object.keys(res.allocations).forEach(function (sym) {
            var uid = data.unitOfSym[sym];
            if (!uid || !idOf[uid]) return;
            var a = res.allocations[sym];
            var status = res.entryStatuses[sym] || '—';
            var held = res.heldSymbols.indexOf(sym) !== -1;
            var prefix = unitBy[uid].syms.length > 1 ? sym + ': ' : '';
            if (a.rerouteTo) {
              var targets = Array.isArray(a.rerouteTo) ? a.rerouteTo : [a.rerouteTo];
              var per = targets.length > 1 ? ' (各 ' + pctTxt(a.targetWeight / targets.length) + ')' : '';
              simBadge(uid, 'sm-sim-reroute', prefix + '判定 ' + status + ' → <strong>' + pctTxt(a.targetWeight) + ' を ' + targets.join('/') + ' へ退避' + per + '</strong>');
              targets.forEach(function (t) {
                var dstUid = data.unitOfSym[t];
                if (dstUid && idOf[dstUid]) {
                  var conn = el.querySelector('svg.connection.node_in_node-' + idOf[dstUid] + '.node_out_node-' + idOf[uid]);
                  if (conn) { conn.classList.remove('sm-sim-dim'); conn.classList.add('sm-sim-flow'); }
                }
              });
            } else {
              simBadge(uid, 'sm-sim-active', prefix + (held ? '保有中' : '判定 ' + status) + ' ・ <strong>active ' + pctTxt(a.activeWeight) + '</strong>');
            }
            if (a.reroutedInWeight > 0) {
              var order = planBySym[sym];
              simBadge(uid, 'sm-sim-recv', prefix + '受入 +' + pctTxt(a.reroutedInWeight) +
                (order ? ' ・ <strong>' + order.quantity + ' 単位 買付予定</strong>' : ''));
            }
          });
          var metaBits = [(res.draftApplied ? '未適用 draft 込み' : '保存済み設定'), 'cron と同一ロジック ・ 発注なし'];
          if (res.plan && !res.ordersEnabledFlag && res.plan.orders.length > 0) metaBits.push('自動発注 flag OFF (cron は判定のみ)');
          if (res.plan) res.plan.skipped.forEach(function (k) { metaBits.push('⚠ ' + k.symbol + ' skip: ' + k.reason); });
          res.notes.forEach(function (n) { metaBits.push('⚠ ' + n); });
          document.getElementById('sm-sim-meta-text').textContent = metaBits.join(' ・ ');
          document.getElementById('sm-sim-meta').hidden = false;
        })
        .catch(function (e) {
          document.getElementById('sm-sim-meta-text').textContent = 'シミュレーション失敗: ' + e.message;
          document.getElementById('sm-sim-meta').hidden = false;
        })
        .then(function () {
          simBtn.disabled = false;
          simBtn.textContent = 'シミュレート';
        });
    });

    if (isView) {
      // view: ノード移動・パン・ズーム・シミュレートのみ。編集系は封印。
      editor.on('connectionCreated', function (info) {
        editor.removeSingleConnection(info.output_id, info.input_id, info.output_class, info.input_class);
      });
      editor.on('nodeRemoved', function () { location.reload(); });
      el.addEventListener('keydown', function (ev) {
        if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.stopPropagation(); ev.preventDefault(); }
      }, true);
      el.addEventListener('contextmenu', function (ev) { ev.stopPropagation(); ev.preventDefault(); }, true);
      renderShares();
      return;
    }

    // ---- ここから edit 専用 ----
    function markConnectionPending(srcId, dstId) {
      tagConnectionClass(srcId, dstId, 'sm-pending');
    }
    function setCardDirty(uid, dirty) {
      var nodeEl = document.getElementById('node-' + idOf[uid]);
      if (nodeEl) nodeEl.classList.toggle('sm-dirty', dirty);
    }
    function reachableSet() {
      var seen = {};
      var queue = Object.keys(draft).filter(function (uid) { return draft[uid].connected; });
      while (queue.length > 0) {
        var uid = queue.pop();
        if (seen[uid]) continue;
        seen[uid] = true;
        (draft[uid].fallbacks || []).forEach(function (fb) {
          if (draft[fb] && !seen[fb]) queue.push(fb);
        });
      }
      return seen;
    }
    function activeDiffs() {
      var reach = reachableSet();
      var activate = [];
      var deactivate = [];
      var heldSkip = [];
      Object.keys(draft).forEach(function (uid) {
        var willActive = !!reach[uid];
        var wasActive = baseline[uid].active !== false;
        if (willActive && !wasActive) activate.push(uid);
        if (!willActive && wasActive) {
          if (Object.keys(unitBy[uid].held || {}).length > 0) heldSkip.push(uid);
          else deactivate.push(uid);
        }
      });
      return { activate: activate, deactivate: deactivate, heldSkip: heldSkip };
    }
    function renderChanges() {
      var d = renderShares();
      var bar = document.getElementById('sm-changes-bar');
      var list = document.getElementById('sm-changes-list');
      var items = [];
      Object.keys(draft).forEach(function (uid) {
        var b = baseline[uid];
        var u = unitBy[uid];
        var newPct = d.shares[uid];
        var pctChanged = newPct !== b.pct;
        var fbChanged = fallbacksChanged(uid);
        if (pctChanged) {
          items.push(u.label + ': 配分 ' + (b.pct ? b.pct + '%' : 'なし') + ' → ' + (newPct ? '1/' + d.branches + ' = ' + newPct + '%' : '解除 (risk-%)'));
        }
        if (fbChanged) {
          var fbs = draft[uid].fallbacks || [];
          if (fbs.length > 0) {
            var exp = expandFallbacks(uid, fbs);
            var detail = u.syms.map(function (x) { return x + '→' + exp[x].join('+'); }).join(' / ');
            var split = fbs.length > 1 ? '、各 1/' + fbs.length + ' に等分割' : '';
            items.push(u.label + ': 退避先 → ' + fbs.map(function (f) { return unitBy[f].label; }).join(' + ') + ' (' + detail + split + '、条件連動 ON)');
          } else {
            items.push(u.label + ': 退避先を解除');
          }
        }
        setCardDirty(uid, pctChanged || fbChanged);
      });
      var ad = activeDiffs();
      ad.activate.forEach(function (uid) { items.push(unitBy[uid].label + ': 有効化 (口座に接続)'); });
      ad.deactivate.forEach(function (uid) {
        items.push(unitBy[uid].label + ': 無効化 (口座から到達不能)');
        setCardDirty(uid, true);
      });
      ad.heldSkip.forEach(function (uid) { items.push(unitBy[uid].label + ': 到達不能だが保有中のため無効化しません (手動で対応)'); });
      list.innerHTML = items.map(function (t) { return '<li>' + t + '</li>'; }).join('');
      bar.hidden = items.length === 0;
      return d;
    }
    renderChanges();

    // ---- カード削除 = 盤面から下ろす (在庫に戻る) ----
    var removedOnCanvas = {};
    editor.on('nodeRemoved', function (id) {
      var uid = unitOf[id];
      if (!uid) return;
      if (accountCcyOf[uid]) {
        alert('口座カードは削除できません。再読込します。');
        location.reload();
        return;
      }
      delete unitOf[id];
      delete idOf[uid];
      removedOnCanvas[uid] = true;
      draft[uid].connected = false;
      draft[uid].fallbacks = [];
      Object.keys(draft).forEach(function (x) {
        draft[x].fallbacks = (draft[x].fallbacks || []).filter(function (f) { return f !== uid; });
      });
      renderChanges();
    });

    // ---- 接続の作成/削除 ----
    editor.on('connectionCreated', function (info) {
      if (programmatic) return;
      var src = unitOf[info.output_id];
      var dst = unitOf[info.input_id];
      if (!src || !dst || accountCcyOf[dst]) {
        programmatic = true;
        editor.removeSingleConnection(info.output_id, info.input_id, info.output_class, info.input_class);
        programmatic = false;
        return;
      }
      if (accountCcyOf[src]) {
        if (unitBy[dst].currency !== accountCcyOf[src]) {
          programmatic = true;
          editor.removeSingleConnection(info.output_id, info.input_id, info.output_class, info.input_class);
          programmatic = false;
          alert(unitBy[dst].label + ' は ' + unitBy[dst].currency + ' です。' + accountCcyOf[src] + ' 口座からは接続できません。');
          return;
        }
        draft[dst].connected = true;
        markConnectionPending(info.output_id, info.input_id);
        renderChanges();
        return;
      }
      // 退避: 単独 → 対は側を特定できないため不可。通貨も一致必須。
      if (unitBy[src].syms.length === 1 && unitBy[dst].syms.length > 1) {
        programmatic = true;
        editor.removeSingleConnection(info.output_id, info.input_id, info.output_class, info.input_class);
        programmatic = false;
        alert('単独銘柄から対 (' + unitBy[dst].label + ') への退避は側を特定できないため設定できません。');
        return;
      }
      if (unitBy[src].currency !== unitBy[dst].currency) {
        programmatic = true;
        editor.removeSingleConnection(info.output_id, info.input_id, info.output_class, info.input_class);
        programmatic = false;
        alert('異通貨の退避先は設定できません (同一通貨のみ)。');
        return;
      }
      // 退避は多分岐可 (#496): 追加で**等分割**される。重複と上限 (4) のみ防ぐ。
      var cur = draft[src].fallbacks || [];
      if (cur.indexOf(dst) !== -1 || cur.length >= 4) {
        programmatic = true;
        editor.removeSingleConnection(info.output_id, info.input_id, info.output_class, info.input_class);
        programmatic = false;
        if (cur.length >= 4) alert('退避先は最大 4 つまでです。');
        return;
      }
      draft[src].fallbacks = cur.concat([dst]);
      tagConnectionClass(info.output_id, info.input_id, 'sm-fallback');
      markConnectionPending(info.output_id, info.input_id);
      renderChanges();
    });

    editor.on('connectionRemoved', function (info) {
      if (programmatic) return;
      var src = unitOf[info.output_id];
      var dst = unitOf[info.input_id];
      if (!src || !dst) return;
      if (accountCcyOf[src]) {
        draft[dst].connected = false;
        renderChanges();
        return;
      }
      draft[src].fallbacks = (draft[src].fallbacks || []).filter(function (f) { return f !== dst; });
      renderChanges();
    });

    // ---- 空中リリース → 在庫から spawn ----
    var connStartId = null;
    var connConsumed = false;
    var picker = document.createElement('div');
    picker.id = 'sm-spawn-picker';
    picker.hidden = true;
    picker.style.cssText = 'position:fixed;z-index:50;background:#fff;border:1px solid #d0d0d5;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.15);padding:6px;font-size:12px;max-height:240px;overflow:auto';
    document.body.appendChild(picker);
    function hidePicker() { picker.hidden = true; connStartId = null; }
    document.addEventListener('mousedown', function (ev) {
      if (!picker.hidden && !picker.contains(ev.target)) hidePicker();
    });
    function canvasPos(clientX, clientY) {
      var pre = editor.precanvas;
      var rect = pre.getBoundingClientRect();
      var zoom = pre.clientWidth / (pre.clientWidth * editor.zoom);
      return { x: clientX * zoom - rect.x * zoom, y: clientY * zoom - rect.y * zoom };
    }
    function spawnAndConnect(item, srcNodeId, clientX, clientY) {
      var pos = canvasPos(clientX, clientY);
      var known = unitBy[item.id];
      var u = known || {
        id: item.id,
        syms: item.syms,
        label: item.label,
        currency: item.currency,
        color: item.color,
        roles: item.roles,
        pct: 0,
        held: {},
        entryRequired: false,
        fallback: { id: null, mixed: false },
        y: 0,
      };
      programmatic = true;
      var newId = addUnitNode(u, pos.x, pos.y, { spawned: baseline[u.id] ? baseline[u.id].active === false : true });
      editor.addConnection(srcNodeId, newId, 'output_1', 'input_1');
      programmatic = false;
      var src = unitOf[srcNodeId];
      if (accountCcyOf[src]) {
        draft[u.id].connected = true;
      } else {
        draft[src].fallbacks = (draft[src].fallbacks || []).concat([u.id]);
        tagConnectionClass(srcNodeId, newId, 'sm-fallback');
      }
      markConnectionPending(srcNodeId, newId);
      delete removedOnCanvas[u.id];
      data.inventory = data.inventory.filter(function (x) { return x.id !== u.id; });
      renderChanges();
    }
    function showPicker(srcNodeId, clientX, clientY) {
      var src = unitOf[srcNodeId];
      var srcIsAccount = !!accountCcyOf[src];
      var ccy = srcIsAccount ? accountCcyOf[src] : unitBy[src].currency;
      var removedItems = Object.keys(removedOnCanvas).map(function (uid) {
        var u = unitBy[uid];
        return { id: u.id, syms: u.syms, label: u.label, currency: u.currency, color: u.color, roles: u.roles };
      });
      var candidates = data.inventory.concat(removedItems).filter(function (x) { return x.currency === ccy; });
      // 単独銘柄からの退避先候補に対は出さない (側を特定できない)。
      if (!srcIsAccount && unitBy[src].syms.length === 1) {
        candidates = candidates.filter(function (x) { return x.syms.length === 1; });
      }
      if (candidates.length === 0) return;
      picker.innerHTML = '<div class="muted" style="padding:2px 6px 6px">既存 Inactive を紐づけ (' + ccy + ')</div>' +
        candidates.map(function (x) {
          return '<div class="sm-spawn-item" data-uid="' + x.id + '" style="padding:5px 10px;border-radius:6px;cursor:pointer">' +
            '<strong style="color:' + x.color + '">' + x.label + '</strong>' +
            (x.syms.length > 1 ? ' <span class="muted" style="font-size:10px">対</span>' : '') + '</div>';
        }).join('');
      picker.style.left = clientX + 'px';
      picker.style.top = clientY + 'px';
      picker.hidden = false;
      var sx = clientX;
      var sy = clientY;
      picker.querySelectorAll('.sm-spawn-item').forEach(function (itemEl) {
        itemEl.addEventListener('mouseenter', function () { itemEl.style.background = '#f0f6ff'; });
        itemEl.addEventListener('mouseleave', function () { itemEl.style.background = ''; });
        itemEl.addEventListener('click', function () {
          var uid = itemEl.getAttribute('data-uid');
          var item = null;
          candidates.forEach(function (x) { if (x.id === uid) item = x; });
          var srcId = srcNodeId;
          hidePicker();
          if (item) spawnAndConnect(item, srcId, sx, sy);
        });
      });
    }
    el.addEventListener('mousedown', function (ev) {
      var out = ev.target && ev.target.closest ? ev.target.closest('.output') : null;
      if (!out) return;
      var nodeEl = ev.target.closest('.drawflow-node');
      if (!nodeEl) return;
      connStartId = parseInt(nodeEl.id.replace('node-', ''), 10);
      connConsumed = false;
    });
    editor.on('connectionCreated', function () { connConsumed = true; connStartId = null; });
    document.addEventListener('mouseup', function (ev) {
      if (connStartId === null) return;
      var srcId = connStartId;
      var mx = ev.clientX;
      var my = ev.clientY;
      setTimeout(function () {
        if (connConsumed) { connStartId = null; return; }
        connStartId = null;
        showPicker(srcId, mx, my);
      }, 30);
    });

    // ---- 入力ポートドラッグで線の付け替え ----
    var retarget = null;
    var guide = null;
    function portCenter(nodeId, cls) {
      var port = el.querySelector('#node-' + nodeId + ' .' + cls);
      if (!port) return null;
      var r = port.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    function showGuide(from, to) {
      if (!guide) {
        guide = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        guide.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:40';
        guide.innerHTML = '<line stroke="#6e6e73" stroke-width="2.5" stroke-dasharray="6 5"/>';
        document.body.appendChild(guide);
      }
      var line = guide.querySelector('line');
      line.setAttribute('x1', from.x);
      line.setAttribute('y1', from.y);
      line.setAttribute('x2', to.x);
      line.setAttribute('y2', to.y);
    }
    function hideGuide() { if (guide) { guide.remove(); guide = null; } }
    el.addEventListener('mousedown', function (ev) {
      var inp = ev.target && ev.target.closest ? ev.target.closest('.input') : null;
      if (!inp) return;
      var nodeEl = ev.target.closest('.drawflow-node');
      if (!nodeEl) return;
      var dstId = parseInt(nodeEl.id.replace('node-', ''), 10);
      var dstUid = unitOf[dstId];
      if (!dstUid || accountCcyOf[dstUid]) return;
      var moduleData = editor.drawflow.drawflow[editor.module].data[dstId];
      var conns = moduleData && moduleData.inputs && moduleData.inputs.input_1 ? moduleData.inputs.input_1.connections : [];
      if (!conns || conns.length === 0) return;
      var srcId = parseInt(conns[conns.length - 1].node, 10);
      ev.preventDefault();
      ev.stopPropagation();
      retarget = { srcId: srcId, oldDstId: dstId };
      var from = portCenter(srcId, 'output') || { x: ev.clientX, y: ev.clientY };
      showGuide(from, { x: ev.clientX, y: ev.clientY });
    }, true);
    document.addEventListener('mousemove', function (ev) {
      if (!retarget) return;
      var from = portCenter(retarget.srcId, 'output') || { x: ev.clientX, y: ev.clientY };
      showGuide(from, { x: ev.clientX, y: ev.clientY });
    });
    document.addEventListener('mouseup', function (ev) {
      if (!retarget) return;
      var state = retarget;
      retarget = null;
      hideGuide();
      var dropNode = document.elementFromPoint(ev.clientX, ev.clientY);
      dropNode = dropNode && dropNode.closest ? dropNode.closest('.drawflow-node') : null;
      if (!dropNode) return;
      var newDstId = parseInt(dropNode.id.replace('node-', ''), 10);
      var newDst = unitOf[newDstId];
      var src = unitOf[state.srcId];
      var oldDst = unitOf[state.oldDstId];
      if (!newDst || accountCcyOf[newDst] || newDst === oldDst || newDst === src) return;
      // 旧線を外す。
      programmatic = true;
      editor.removeSingleConnection(state.srcId, state.oldDstId, 'output_1', 'input_1');
      programmatic = false;
      if (accountCcyOf[src]) {
        draft[oldDst].connected = false;
        if (unitBy[newDst].currency !== accountCcyOf[src]) {
          alert(unitBy[newDst].label + ' は ' + unitBy[newDst].currency + ' です。元に戻します。');
          programmatic = true;
          editor.addConnection(state.srcId, state.oldDstId, 'output_1', 'input_1');
          programmatic = false;
          draft[oldDst].connected = true;
          renderChanges();
          return;
        }
        programmatic = true;
        editor.addConnection(state.srcId, idOf[newDst], 'output_1', 'input_1');
        programmatic = false;
        draft[newDst].connected = true;
        markConnectionPending(state.srcId, idOf[newDst]);
      } else {
        draft[src].fallbacks = (draft[src].fallbacks || []).filter(function (f) { return f !== oldDst; });
        var invalid = (unitBy[src].syms.length === 1 && unitBy[newDst].syms.length > 1) ||
          unitBy[src].currency !== unitBy[newDst].currency ||
          (draft[src].fallbacks || []).indexOf(newDst) !== -1;
        if (invalid) {
          alert('その付け替えはできません (単独→対 / 異通貨 / 重複)。元に戻します。');
          programmatic = true;
          editor.addConnection(state.srcId, state.oldDstId, 'output_1', 'input_1');
          programmatic = false;
          tagConnectionClass(state.srcId, state.oldDstId, 'sm-fallback');
          draft[src].fallbacks = (draft[src].fallbacks || []).concat([oldDst]);
          renderChanges();
          return;
        }
        programmatic = true;
        editor.addConnection(state.srcId, idOf[newDst], 'output_1', 'input_1');
        programmatic = false;
        draft[src].fallbacks = (draft[src].fallbacks || []).concat([newDst]);
        tagConnectionClass(state.srcId, idOf[newDst], 'sm-fallback');
        markConnectionPending(state.srcId, idOf[newDst]);
      }
      renderChanges();
    });

    // ---- 線の削除 (選択 → Backspace/Delete or ボタン) ----
    var deleteBtn = document.getElementById('sm-delete-conn');
    function refreshDeleteBtn() {
      var has = editor.connection_selected != null;
      deleteBtn.disabled = !has;
      deleteBtn.style.color = has ? '#c22' : '#999';
      deleteBtn.style.borderColor = has ? '#c22' : '#ccc';
    }
    el.addEventListener('click', function () { setTimeout(refreshDeleteBtn, 0); });
    deleteBtn.addEventListener('click', function () {
      if (editor.connection_selected != null) editor.removeConnection();
      refreshDeleteBtn();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Backspace') return;
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (editor.connection_selected != null) {
        ev.preventDefault();
        editor.removeConnection();
        refreshDeleteBtn();
      }
    });

    // ---- 適用 (有効化 → 配分 → 退避 → 無効化) ----
    document.getElementById('sm-reset').addEventListener('click', function () { location.reload(); });
    document.getElementById('sm-apply').addEventListener('click', function () {
      var d = deriveShares();
      var ad = activeDiffs();
      var pctUnits = Object.keys(draft).filter(function (uid) { return d.shares[uid] !== baseline[uid].pct; });
      var fbUnits = Object.keys(draft).filter(function (uid) { return fallbacksChanged(uid); });
      if (pctUnits.length === 0 && fbUnits.length === 0 && ad.activate.length === 0 && ad.deactivate.length === 0) return;
      var confirmMsg = '表示中の変更をまとめて適用します (' + d.branches + ' 枝 ・ 1 枝 = ' + d.share + '%';
      if (ad.activate.length > 0) confirmMsg += ' ・ 有効化 ' + ad.activate.map(function (x) { return unitBy[x].label; }).join('/');
      if (ad.deactivate.length > 0) confirmMsg += ' ・ 無効化 ' + ad.deactivate.map(function (x) { return unitBy[x].label; }).join('/');
      confirmMsg += ')。よろしいですか？';
      if (!confirm(confirmMsg)) return;
      var steps = Promise.resolve();
      function toggleStep(sym, label) {
        return function () {
          return fetch('/admin/symbol-config/' + encodeURIComponent(sym) + '/toggle-active', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
          }).then(function (r) {
            if (!r.ok) throw new Error(sym + ' の' + label + 'に失敗 (HTTP ' + r.status + ')');
          });
        };
      }
      ad.activate.forEach(function (uid) {
        unitBy[uid].syms.forEach(function (sym) { steps = steps.then(toggleStep(sym, '有効化')); });
      });
      if (pctUnits.length > 0) {
        var form = new FormData();
        pctUnits.forEach(function (uid) {
          unitBy[uid].syms.forEach(function (sym) {
            form.append('pct_' + sym, d.shares[uid] > 0 ? String(d.shares[uid]) : '');
          });
        });
        steps = steps.then(function () {
          return fetch('/admin/symbol-config/budget-alloc', { method: 'POST', credentials: 'same-origin', body: form })
            .then(function (r) { if (!r.ok) throw new Error('配分の保存に失敗 (HTTP ' + r.status + ')'); });
        });
      }
      fbUnits.forEach(function (uid) {
        var exp = expandFallbacks(uid, draft[uid].fallbacks || []);
        Object.keys(exp).forEach(function (sym) {
          steps = steps.then(function () {
            return fetch('/admin/symbol-config/' + encodeURIComponent(sym) + '/cash-fallback', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ targets: exp[sym] }),
            }).then(function (r) {
              if (!r.ok) return r.json().then(function (b) { throw new Error(sym + ' の退避先の保存に失敗: ' + (b.error || 'HTTP ' + r.status)); });
            });
          });
        });
      });
      ad.deactivate.forEach(function (uid) {
        unitBy[uid].syms.forEach(function (sym) { steps = steps.then(toggleStep(sym, '無効化')); });
      });
      steps
        .then(function () { location.reload(); })
        .catch(function (e) { alert(e.message + ' — 再読込して状態を確認してください。'); location.reload(); });
    });
  });
  </script>`
}

export function symbolsListBody(args: {
  rows: SymbolConfigRow[]
  inversePairs?: Record<string, string>
  pairRegimes?: PairRegimeEntry[]
  mapAmounts?: Record<string, { native: string; jpy: number }>
  /** #460: OpenAPI 取扱 allowlist。各行/カードの取扱バッジに使う。 */
  tradable?: TradableAllowlist
  errorCode?: string | null
  errorSymbol?: string | null
  filter: SymbolsListFilter
  /** 'list' = 表 (default)、'workflow' = 配分キャンバス。マップ埋め込みでページが
   *  重くなったため tab 分離 (operator 要望)。Drawflow の読み込みも workflow 時のみ。 */
  tab?: 'list' | 'workflow'
}): string {
  const { rows, inversePairs = {}, pairRegimes = [], mapAmounts = {}, errorCode = null, errorSymbol = null, filter } = args
  const tradable: TradableAllowlist = args.tradable ?? new Map()
  const tab = args.tab ?? 'list'
  const tabBar = `<div style="display:flex;gap:4px;margin:0 0 12px;border-bottom:1px solid #e3e3e8">
    <a href="/dashboard/symbols" style="padding:6px 16px;font-size:13px;text-decoration:none;border-bottom:2px solid ${tab === 'list' ? '#06c' : 'transparent'};color:${tab === 'list' ? '#06c' : '#5f6368'};font-weight:${tab === 'list' ? '600' : 'normal'}">一覧</a>
    <a href="/dashboard/symbols?tab=workflow" style="padding:6px 16px;font-size:13px;text-decoration:none;border-bottom:2px solid ${tab === 'workflow' ? '#06c' : 'transparent'};color:${tab === 'workflow' ? '#06c' : '#5f6368'};font-weight:${tab === 'workflow' ? '600' : 'normal'}">ワークフロー</a>
  </div>`
  // #415: 買付余力バッジをページ最上部に (全 return が ${errorBanner} を先頭に持つので
  // ここに前置すると一覧・空・フィルタ 0 件の全ケースで表示される)。
  const errorBanner = buyingPowerBadge() + renderSymbolErrorBanner(errorCode, errorSymbol)
  const filtered = applySymbolsListFilter(rows, filter)
  const activeCount = rows.filter((r) => r.active).length
  const inactiveCount = rows.length - activeCount

  const sel = (cur: string, val: string) => (cur === val ? ' selected' : '')
  const filterBar = `<form method="get" action="/dashboard/symbols" style="margin:0 0 12px;padding:8px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
    <input type="search" name="q" value="${esc(filter.q)}" placeholder="🔍 銘柄 / 名前で絞り込み" style="padding:4px 8px;width:200px">
    <select name="status" style="padding:4px 6px">
      <option value="all"${sel(filter.status, 'all')}>全状態</option>
      <option value="active"${sel(filter.status, 'active')}>有効のみ</option>
      <option value="inactive"${sel(filter.status, 'inactive')}>無効のみ</option>
    </select>
    <select name="market" style="padding:4px 6px">
      <option value="all"${sel(filter.market, 'all')}>全市場</option>
      <option value="US"${sel(filter.market, 'US')}>US</option>
      <option value="JP"${sel(filter.market, 'JP')}>JP</option>
    </select>
    <button type="submit" style="padding:4px 12px;background:#06c;color:#fff;border:none;border-radius:4px;cursor:pointer">絞り込み</button>
    <a href="/dashboard/symbols" style="padding:4px 8px;text-decoration:none;font-size:12px;color:#86868b">リセット</a>
  </form>`

  // #460: allowlist の取得状況サマリ (操作判断のため最終取得日と件数を出す)。
  const tradableEntries = [...tradable.values()]
  const tradableCount = tradableEntries.filter((e) => e.status === 'tradable').length
  const lastSync = tradableEntries.reduce<string>(
    (acc, e) => (e.lastSeenAt && e.lastSeenAt > acc ? e.lastSeenAt : acc),
    '',
  )
  const allowlistNote =
    tradableEntries.length === 0
      ? '<span class="muted" style="font-size:12px">OpenAPI 取扱リスト: 未取得 — 「取扱リスト更新」で取得</span>'
      : `<span class="muted" style="font-size:12px" title="tradable/list を全件 sweep した結果のキャッシュ (#460)">OpenAPI 取扱リスト: ${tradableCount} 銘柄 (最終取得 ${esc(lastSync.slice(0, 10))})</span>`
  const headerBar = `<p style="margin:0 0 12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <a href="/dashboard/symbols/new" style="padding:6px 12px;background:#06c;color:#fff;border-radius:4px;text-decoration:none">+ 新規追加</a>
    <span class="muted" style="font-size:12px">${filtered.length} / ${rows.length} 件表示 (有効 ${activeCount} / 無効 ${inactiveCount})</span>
    <button type="button" id="tradable-refresh-btn" onclick="window.refreshTradableAllowlist()" style="padding:5px 10px;font-size:12px;background:#fff;border:1px solid #d0d0d5;border-radius:4px;cursor:pointer" title="Webull の OpenAPI 取扱可能銘柄リスト (tradable/list) を今すぐ再取得して allowlist を更新します。全件 sweep のため数十秒かかります (#460)">🔄 取扱リスト更新</button>
    ${allowlistNote}
    <span id="tradable-refresh-status" style="font-size:12px"></span>
  </p>
  <script>
  // #460: 全件 sweep は 1 リクエストの予算で完走できないので、チャンク式で
  // done になるまで連続 POST する。各 POST は ~15 ページ (~20秒) を処理し、
  // nextCursor + watermark を返すので同じ watermark で続きを叩く。件数は
  // total でライブ表示。done で再読込してバッジを反映。
  window.refreshTradableAllowlist = function () {
    var btn = document.getElementById('tradable-refresh-btn');
    var st = document.getElementById('tradable-refresh-status');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
    if (st) { st.textContent = '⏳ 取得中... (全件まで約1分)'; st.style.color = '#86868b'; }
    var step = function (cursor, watermark, guard) {
      if (guard > 40) { // 安全上限 (40 チャンク = 600 ページ相当)
        if (st) { st.textContent = '⚠ 取得が長すぎるため中断 (部分反映済み)'; st.style.color = '#b25000'; }
        if (btn) { btn.disabled = false; btn.style.opacity = ''; }
        return;
      }
      var qs = [];
      if (cursor) qs.push('cursor=' + encodeURIComponent(cursor));
      if (watermark) qs.push('watermark=' + encodeURIComponent(watermark));
      var url = '/admin/tradable-allowlist/refresh' + (qs.length ? '?' + qs.join('&') : '');
      fetch(url, { method: 'POST', credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!res || res.ok === false) {
            if (st) { st.textContent = '⚠ 取得失敗: ' + ((res && res.error) || 'unknown'); st.style.color = '#c22'; }
            if (btn) { btn.disabled = false; btn.style.opacity = ''; }
            return;
          }
          var n = res.total != null ? res.total : 0;
          if (res.done) {
            if (st) { st.textContent = '✓ ' + n + ' 銘柄取得完了' + (res.disappeared > 0 ? ' / ' + res.disappeared + ' 消失' : '') + ' — 再読込します'; st.style.color = '#0e9f6e'; }
            setTimeout(function () { window.location.reload(); }, 700);
            return;
          }
          if (st) { st.textContent = '⏳ 取得中... ' + n + ' 銘柄'; st.style.color = '#86868b'; }
          step(res.nextCursor, res.watermark, guard + 1);
        })
        .catch(function () {
          if (st) { st.textContent = '⚠ 通信エラー'; st.style.color = '#c22'; }
          if (btn) { btn.disabled = false; btn.style.opacity = ''; }
        });
    };
    step(null, null, 0);
  };
  </script>`

  if (tab === 'workflow') {
    return `${errorBanner}${tabBar}${symbolMapEditorBody(rows, inversePairs, mapAmounts, { mode: 'view', pairRegimes, tradable })}`
  }

  if (rows.length === 0) {
    return `${errorBanner}${tabBar}${headerBar}<p class="muted">登録銘柄なし。「+ 新規追加」から最初の symbol を登録してください。</p>`
  }
  if (filtered.length === 0) {
    return `${errorBanner}${tabBar}${filterBar}${headerBar}<p class="muted">フィルタに一致する銘柄無し。条件を緩めてください。</p>`
  }
  // #315: インバース対が隣接するよう並べ替え、ペアごとに交互の薄色背景 + ツリー表記。
  const ordered = orderRowsByPair(filtered, inversePairs)
  const pairColor = assignPairColors(ordered, inversePairs)
  const roles = pairRoles(ordered, inversePairs)
  // 共有 slider の初期値計算用 (対の max を採るため両側の % を引けるように)。
  const pctOf = new Map(
    ordered.map((r) => [
      r.symbol.toUpperCase(),
      r.budgetAllocPct != null ? Math.round(r.budgetAllocPct * 1000) / 10 : 0,
    ]),
  )
  const tbody = ordered
    .map((r) => {
      const inactive = !r.active
      const sym = r.symbol.toUpperCase()
      const inverse = inversePairs[sym] ?? null
      const role = roles.get(sym) ?? null
      const bg = pairColor.get(sym)
      const rowStyleParts: string[] = []
      if (inactive) rowStyleParts.push('opacity:0.5')
      if (bg) rowStyleParts.push(`background:${bg}`)
      const rowStyle = rowStyleParts.length ? ` style="${rowStyleParts.join(';')}"` : ''
      const symStyle = inactive ? ' style="text-decoration:line-through;color:#86868b"' : ''
      const toggleLabel = r.active ? '無効化' : '有効化'
      const editHref = `/dashboard/symbols/${encodeURIComponent(r.symbol)}/edit`
      const toggleAction = `/admin/symbol-config/${encodeURIComponent(r.symbol)}/toggle-active`
      const deleteAction = `/admin/symbol-config/${encodeURIComponent(r.symbol)}/delete`
      const deleteForm = r.active
        ? '<span class="muted" style="font-size:11px" title="削除するには先に無効化してください">—</span>'
        : `<form method="post" action="${esc(deleteAction)}" style="display:inline" onsubmit="return confirm('${esc(r.symbol)} を完全に削除します (DB row 自体を消去、インバース対のリンクも解除)。元に戻せません。よろしいですか？');">
            <button type="submit" style="padding:3px 8px;font-size:12px;background:#c22;color:#fff;border:none;border-radius:4px;cursor:pointer">削除</button>
          </form>`
      const maxNotionalCell = r.maxNotional === null
        ? '<span class="muted" title="未設定 = global の MAX_ORDER_NOTIONAL を使用">— (global)</span>'
        : `${esc(r.maxNotional.toLocaleString('ja-JP'))} <span class="muted" style="font-size:11px">${esc(r.currency)}</span>`
      // 売買単位 (lot_size)。未設定・不正値 (NULL/0/負/非整数) は cron sizing が
      // fail-closed (発注見送り) するので、一覧でも同じ判定で赤字警告を出す
      // (loadSymbolConfig の採用条件 = integer>=1 と揃える、CodeRabbit #409)。
      // 戦略ロール + 条件連動配分の要約 (#452)。NULL は従来挙動なので「—」。
      // entry 抑止 role (cash_parking / 定義のみ) は title で発注されない旨を明示。
      const roleCell = renderSymbolRoleCell(r)
      const lotSizeValid = Number.isInteger(r.lotSize) && (r.lotSize as number) >= 1
      const lotSizeCell = !lotSizeValid
        ? '<span class="err" title="売買単位が未設定または不正です。設定するまで BUY は発注されません (fail-closed)。編集から入力してください。">⚠ 未設定</span>'
        : `${esc(String(r.lotSize))} <span class="muted" style="font-size:11px">${r.lotSize === 1 ? '株/口' : '株'}</span>`
      // 予算配分 ladder slider (#budget-alloc): 5%刻み。確定するまで client 側で仮調整、
      // form="symbol-budget-form" で一括 POST。両側表示中のインバース対は 1 本の共有
      // slider (rowspan=2) に統合する — 同時に建つのは片側のみで予算消費は 1 回分
      // なのに、2 本並ぶと倍取られているように見えるため。初期値は両側の max、
      // POST に載らない相手側は server が同値同期する (admin #budget-alloc)。
      const allocPctNum =
        role === 'top'
          ? Math.max(pctOf.get(sym) ?? 0, pctOf.get(inverse!.toUpperCase()) ?? 0)
          : (pctOf.get(sym) ?? 0)
      const sliderHtml = `<div style="display:flex;align-items:center;gap:6px;min-width:170px">
          <input type="range" name="pct_${esc(r.symbol)}" form="symbol-budget-form" min="0" max="100" step="5" value="${allocPctNum}"
            data-symbol="${esc(r.symbol)}"${inverse ? ` data-inverse="${esc(inverse)}"` : ''}
            oninput="window.onBudgetSlide(this)" style="width:110px;vertical-align:middle">
          <span id="budget-label-${esc(r.symbol)}" class="muted" style="font-size:12px;width:42px;text-align:right;font-variant-numeric:tabular-nums">${allocPctNum === 0 ? 'risk' : allocPctNum + '%'}</span>
        </div>`
      const budgetTd =
        role === 'bottom'
          ? ''
          : role === 'top'
            ? `<td rowspan="2" style="vertical-align:middle">${sliderHtml}<div class="muted" style="font-size:11px;margin-top:2px">ペア共通 — 建玉は片側のみ、予算消費は1回分</div></td>`
            : `<td>${sliderHtml}</td>`
      // ツリー表記 (#315): 対を縦線で連結。上段は中央→下端に縦線 + 中央で右へ横棒
      // (┌)、下段は上端→中央に縦線 + 中央で右へ横棒 (└)。隣接行で左の縦線が
      // 行境界を跨いで連結し、1 本の bracket に見える。線は相手 edit へのリンク。
      const treeTitle = inverse
        ? `インバース対: ${esc(inverse)} (相手に建玉がある間は BUY 見送り #315)`
        : ''
      const connBase =
        'position:absolute;left:11px;width:9px;border-left:2px solid #06c;display:block'
      const connStyle =
        role === 'top'
          ? `${connBase};top:50%;bottom:0;border-top:2px solid #06c;border-top-left-radius:6px`
          : role === 'bottom'
            ? `${connBase};top:0;bottom:50%;border-bottom:2px solid #06c;border-bottom-left-radius:6px`
            : ''
      const treeCell = connStyle
        ? `<a href="/dashboard/symbols/${encodeURIComponent(inverse!)}/edit" title="${treeTitle}" style="${connStyle}"></a>`
        : ''
      const dateOnly = (r.updatedAt || '').slice(0, 10)
      // #460: OpenAPI 取扱 allowlist バッジ (tradable は出さない)。
      const tradBadge = tradableBadgeHtml(tradable.get(sym)?.status ?? 'unknown')
      const tradBadgeHtml = tradBadge ? `<div style="margin-top:2px">${tradBadge}</div>` : ''
      return `<tr${rowStyle}>
        <td style="position:relative;width:28px;padding:0">${treeCell}</td>
        <td><a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(r.symbol)}" title="チャート銘柄タブで見る" style="text-decoration:none"><strong><span${symStyle}>${esc(r.symbol)}</span></strong></a>${tradBadgeHtml}</td>
        <td>${esc(r.name ?? '')}</td>
        <td><code style="font-size:11px">${esc(r.market)}/${esc(r.currency)}</code></td>
        <td>${roleCell}</td>
        <td>${lotSizeCell}</td>
        <td>${maxNotionalCell}</td>
        ${budgetTd}
        <td>${esc(r.notes ?? '')}</td>
        <td class="muted" style="font-size:11px">${esc(dateOnly)}</td>
        <td>
          <a href="${esc(editHref)}" style="padding:3px 8px;font-size:12px;text-decoration:none">編集</a>
          <form method="post" action="${esc(toggleAction)}" style="display:inline">
            <button type="submit" style="padding:3px 8px;font-size:12px;cursor:pointer">${esc(toggleLabel)}</button>
          </form>
          ${deleteForm}
        </td>
      </tr>`
    })
    .join('')
  return `${errorBanner}${tabBar}${filterBar}${headerBar}
  <table>
    <thead><tr>
      <th style="width:28px" title="インバース対のツリー表記"></th>
      <th>銘柄</th>
      <th>銘柄名</th>
      <th>市場/通貨</th>
      <th>ロール</th>
      <th>売買単位</th>
      <th>1注文上限</th>
      <th>予算配分</th>
      <th>メモ</th>
      <th>更新日</th>
      <th>操作</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>
  ${budgetLadderControls()}
  ${safeJsonScript(
    '__budgetBaseline',
    rows
      .filter((r) => r.budgetAllocPct != null && r.budgetAllocPct > 0)
      .map((r) => ({
        s: r.symbol.toUpperCase(),
        pct: Math.round((r.budgetAllocPct as number) * 1000) / 10,
        inv: inversePairs[r.symbol.toUpperCase()] ?? null,
      })),
  )}
  <script>${BUDGET_LADDER_JS}</script>`
}

// #budget-alloc ladder の client JS: slider 移動でラベル更新 + 「未確定」バーを表示。
// 保存は確定ボタン押下の form POST のみ (即保存しない = 確定するまで仮)。
// インバース対は 1 本の共有 slider なので相手 slider の同期は不要 — POST に載らない
// 相手側は server が同値同期する (#315 regime hedge)。
export const BUDGET_LADDER_JS = `
  window.__budgetDirty = {};
  window.__fmtBudget = function (v) { return Number(v) <= 0 ? 'risk' : v + '%'; };
  window.onBudgetSlide = function (el) {
    var sym = el.getAttribute('data-symbol');
    var inv = el.getAttribute('data-inverse');
    var v = el.value;
    var lb = document.getElementById('budget-label-' + sym);
    if (lb) lb.textContent = window.__fmtBudget(v);
    // 保存時に server 同期で相手側も変わるので、dirty 数には相手も数える。
    window.__budgetDirty[sym] = true;
    if (inv) window.__budgetDirty[inv] = true;
    var bar = document.getElementById('symbol-budget-bar');
    var note = document.getElementById('symbol-budget-dirty');
    if (bar) bar.style.display = 'flex';
    if (note) note.textContent = Object.keys(window.__budgetDirty).length + ' 銘柄を変更中';
    window.__recomputeBudgetMeter();
  };
  // 同時建玉ベースの予算使用率を全 slider から再計算してメーターを再描画。
  // インバース対は max を 1 回だけ計上 (片側のみ建つため)。
  window.__recomputeBudgetMeter = function () {
    var barMeter = document.getElementById('symbol-budget-bar-meter');
    if (!barMeter) return;
    // 全銘柄の baseline 配分から開始し、表示中 slider の現在値で上書きする。
    // filter で非表示の銘柄の配分が meter から欠落しないようにするため (CodeRabbit #405)。
    var bySym = {};
    (window.__budgetBaseline || []).forEach(function (b) {
      if (b.pct > 0) bySym[b.s] = { pct: b.pct, inv: b.inv };
    });
    var sliders = document.querySelectorAll('input[name^="pct_"]');
    sliders.forEach(function (s) {
      var sym = s.getAttribute('data-symbol');
      var inv = s.getAttribute('data-inverse');
      var v = Number(s.value);
      // 対の共有 slider は両側を上書きする (相手の baseline が残ると max が
      // 旧値に張り付き、下げた時にメーターが追従しない)。
      if (v > 0) {
        bySym[sym] = { pct: v, inv: inv };
        if (inv) bySym[inv] = { pct: v, inv: sym };
      } else {
        // 0 にした表示中銘柄は除外 (baseline 値で復活させない)
        delete bySym[sym];
        if (inv) delete bySym[inv];
      }
    });
    // 口座(円)単一プールに対する使用率を 1 本で合算。インバース対は max を1回計上。
    var used = 0;
    var counted = {};
    Object.keys(bySym).forEach(function (sym) {
      var e = bySym[sym];
      if (e.inv) {
        var key = [sym, e.inv].sort().join('|');
        if (counted[key]) return;
        counted[key] = true;
        var invPct = bySym[e.inv] ? bySym[e.inv].pct : 0;
        used += Math.max(e.pct, invPct);
      } else {
        used += e.pct;
      }
    });
    if (used <= 0) { barMeter.innerHTML = ''; return; }
    var w = Math.min(100, used);
    var col = used > 100 ? '#c22' : used > 80 ? '#b25000' : '#057a55';
    barMeter.innerHTML = '<span title="同時建玉ベースの口座(円)予算使用率 (インバース対は max を1回計上)" style="display:flex;align-items:center;gap:6px;font-size:12px;flex:1;min-width:0">'
      + '<span class="muted" style="white-space:nowrap">口座予算</span>'
      + '<span class="bar-track" style="flex:1;min-width:40px;height:8px"><span class="bar-fill" style="display:block;width:' + w.toFixed(0) + '%;height:8px;background:' + col + '"></span></span>'
      + '<span style="font-variant-numeric:tabular-nums;color:' + col + ';white-space:nowrap">' + used.toFixed(0) + '% / 100%' + (used > 100 ? ' ⚠超過' : '') + '</span></span>';
  };
`

/** 予算配分 ladder の確定 / 取消 バー。slider は form attr で此処の form に紐づく。 */
export function budgetLadderControls(): string {
  return `<form id="symbol-budget-form" method="post" action="/admin/symbol-config/budget-alloc"></form>
  <div id="symbol-budget-bar" style="position:sticky;bottom:0;margin-top:12px;padding:10px 12px;background:#fff;border:1px solid #d0d0d5;border-radius:8px;display:none;align-items:center;gap:12px;box-shadow:0 -2px 8px rgba(0,0,0,0.06)">
    <strong style="font-size:13px">予算配分の変更（未確定）</strong>
    <span id="symbol-budget-dirty" class="muted" style="font-size:12px;white-space:nowrap"></span>
    <span id="symbol-budget-bar-meter" style="display:flex;gap:14px;align-items:center;flex:1"></span>
    <a href="/dashboard/symbols" style="padding:5px 12px;text-decoration:none;border:1px solid #d0d0d5;border-radius:6px;font-size:13px">取消</a>
    <button type="submit" form="symbol-budget-form" style="padding:5px 14px;background:#06c;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">確定して保存</button>
  </div>`
}

/**
 * #budget-jpy-base-fx: 同時建玉ベースの口座(円)予算使用率 (単一 %)。
 * budget_alloc_pct は通貨に関係なく「口座(円)全体に対する割合」なので、通貨で分けず
 * 1 本に合算する。インバース対は同時に片方しか建たないので max(両側) で1回だけ計上、
 * standalone と別ペアは加算 = 「口座に対する最大同時コミット率 (%)」。
 */
export function computeBudgetUsage(
  rows: Array<{ symbol: string; budgetAllocPct: number | null }>,
  inversePairs: Record<string, string>,
): number {
  const pctBySym = new Map<string, number>()
  for (const r of rows) {
    const pct = r.budgetAllocPct != null && r.budgetAllocPct > 0 ? r.budgetAllocPct * 100 : 0
    if (pct > 0) pctBySym.set(r.symbol.toUpperCase(), pct)
  }
  let used = 0
  const countedPair = new Set<string>()
  for (const [sym, pct] of pctBySym) {
    const inv = inversePairs[sym]
    if (inv) {
      const key = [sym, inv].sort().join('|')
      if (countedPair.has(key)) continue
      countedPair.add(key)
      used += Math.max(pct, pctBySym.get(inv) ?? 0)
    } else {
      used += pct
    }
  }
  return used
}

/**
 * #315: インバース対が隣接するよう並べ替える。各 symbol を symbol ASC で走査し、
 * 対の相手が未出力かつ filtered 内に在れば直後に続ける。対なし / 既出は単独。
 */
export function orderRowsByPair(
  rows: SymbolConfigRow[],
  inversePairs: Record<string, string>,
): SymbolConfigRow[] {
  const bySym = new Map(rows.map((r) => [r.symbol.toUpperCase(), r]))
  const emitted = new Set<string>()
  const out: SymbolConfigRow[] = []
  for (const r of rows) {
    const sym = r.symbol.toUpperCase()
    if (emitted.has(sym)) continue
    out.push(r)
    emitted.add(sym)
    const inv = inversePairs[sym]
    if (inv && !emitted.has(inv) && bySym.has(inv)) {
      out.push(bySym.get(inv)!)
      emitted.add(inv)
    }
  }
  return out
}

/**
 * ペアごとに薄色背景を交互割り当て (両 symbol が表示中の対のみ着色)。
 * 片側しか表示されていない対 / 対なしは無着色。
 */
export function assignPairColors(
  ordered: SymbolConfigRow[],
  inversePairs: Record<string, string>,
): Map<string, string> {
  const present = new Set(ordered.map((r) => r.symbol.toUpperCase()))
  const colors = ['#eef4ff', '#fff4ec'] as const // 薄青 / 薄橙を交互
  const color = new Map<string, string>()
  const assignedPair = new Set<string>()
  let idx = 0
  for (const r of ordered) {
    const sym = r.symbol.toUpperCase()
    const inv = inversePairs[sym]
    if (!inv || !present.has(inv)) continue
    const key = [sym, inv].sort().join('|')
    if (!assignedPair.has(key)) {
      assignedPair.add(key)
      const c = colors[idx % colors.length]!
      idx++
      color.set(sym, c)
      color.set(inv, c)
    }
  }
  return color
}

/**
 * ordered list 上で各 symbol のツリー位置を判定 (#315 ツリー表記)。
 * 直後が自分の対 → 'top' (┌)、直前が自分の対 → 'bottom' (└)、対なし → null。
 * orderRowsByPair で対は隣接済みなので前後 1 行で判定できる。
 */
export function pairRoles(
  ordered: SymbolConfigRow[],
  inversePairs: Record<string, string>,
): Map<string, 'top' | 'bottom'> {
  const roles = new Map<string, 'top' | 'bottom'>()
  for (let i = 0; i < ordered.length; i++) {
    const sym = ordered[i]!.symbol.toUpperCase()
    const inv = inversePairs[sym]
    if (!inv) continue
    const next = ordered[i + 1]?.symbol.toUpperCase()
    const prev = ordered[i - 1]?.symbol.toUpperCase()
    if (next === inv) roles.set(sym, 'top')
    else if (prev === inv) roles.set(sym, 'bottom')
  }
  return roles
}

/**
 * /admin/symbol-config 系 form POST が失敗時に redirect で渡してくる
 * `?error=...&symbol=...` を表示する banner。known code 以外は generic msg。
 */
export function renderSymbolErrorBanner(code: string | null, symbol: string | null): string {
  if (!code) return ''
  const msg = symbolErrorMessage(code, symbol)
  return `<p class="err" style="margin:0 0 12px">${esc(msg)}</p>`
}

export function symbolErrorMessage(code: string, symbol: string | null): string {
  const sym = symbol ?? ''
  switch (code) {
    case 'duplicate':
      return sym
        ? `symbol "${sym}" は既に登録済みです。`
        : 'symbol は既に登録済みです。'
    case 'not_found':
      return sym ? `symbol "${sym}" が見つかりません。` : 'symbol が見つかりません。'
    case 'still_active':
      return sym
        ? `symbol "${sym}" は有効化中のため削除できません。先に無効化してから削除してください。`
        : 'symbol が有効化中のため削除できません。先に無効化してください。'
    case 'validation':
      return '入力値に誤りがあります。'
    case 'inverse_self':
      return 'インバース銘柄に主銘柄と同じ symbol は指定できません。'
    default:
      return `エラーが発生しました (code=${code}).`
  }
}

export interface SymbolFormArgs {
  mode: 'new' | 'edit'
  row: SymbolConfigRow | null
  /** validation error message — POST handler が re-render する時に渡す。 */
  error: string | null
  /**
   * Pullback rule の global default。override 入力欄の placeholder に「空欄
   * なら N が適用される」と見せるために使う (#316)。読込失敗時 null。
   */
  globalDefaults: { timeStopDays: number; kAtr: number } | null
  /** 編集対象が既に対を組んでいる相手 symbol (#315)。未ペア / new は null。 */
  currentInverse?: string | null
  /** #460: OpenAPI 取扱 allowlist status (edit モードの server 描画用)。 */
  tradableStatus?: TradableStatus
}

/**
 * OpenAPI 取扱 allowlist (#460) のバッジ表現。tradable/list 由来の status を
 * operator が判断できる短い日本語ラベル + 色 + tooltip にまとめる。
 *   - tradable    : 直近 sweep で OpenAPI 取扱可
 *   - disappeared : 過去は取扱可だったが直近 sweep で消失 (取扱停止の可能性)
 *   - unknown     : allowlist 未観測 (OpenAPI で発注できない可能性)
 * 登録/発注は止めない警告レイヤー (ユーザー方針: 警告のみ)。`tradable` は
 * バッジを出さない (ノイズ削減 — 問題のある状態だけ目立たせる)。
 */
export const TRADABLE_BADGE: Record<
  Exclude<TradableStatus, 'tradable'>,
  { label: string; bg: string; fg: string; title: string }
> = {
  disappeared: {
    label: '⚠ 取扱消失',
    bg: '#fff4e5',
    fg: '#9a5b00',
    title:
      'OpenAPI 取扱リスト (tradable/list) に過去は在籍したが直近の sweep で消失。取扱停止された可能性 — 保有・運用中なら確認を (#460)',
  },
  unknown: {
    label: '⚠ 取扱未確認',
    bg: '#f1f1f4',
    fg: '#6e6e73',
    title:
      'OpenAPI 取扱リスト (tradable/list) に未観測。アプリで売買できても OpenAPI 経由では発注できない可能性 (USMV 等)。発注後に 417 で弾かれる場合あり (#460)',
  },
}

/** allowlist status → 一覧/フォーム用バッジ HTML。tradable は空 (バッジ無し)。 */
export function tradableBadgeHtml(status: TradableStatus): string {
  if (status === 'tradable') return ''
  const b = TRADABLE_BADGE[status]
  return `<span title="${esc(b.title)}" style="display:inline-block;padding:1px 6px;border-radius:6px;background:${b.bg};color:${b.fg};font-size:11px;font-weight:600;white-space:nowrap">${b.label}</span>`
}

/** role の短い日本語名 (#452)。一覧 / チャートタブのインライン表示用。 */
export const SYMBOL_ROLE_LABELS_SHORT: Record<SymbolRole, string> = {
  cash_parking: '待機資金ETF',
  core_trend: '非レバ・トレンド',
  leveraged_trend: 'レバETF・トレンド',
  low_volatility: '低ボラ',
  sector_trend: 'セクター',
  inverse_hedge: 'インバースヘッジ (短期)',
  momentum: 'モメンタム (⚠未検証)',
}

/** role select の表示ラベル (#452)。値は DB enum と同一、表示だけ日本語補足。 */
export const SYMBOL_ROLE_LABELS: Record<SymbolRole, string> = {
  cash_parking: 'cash_parking — 待機資金 ETF (SGOV / BIL 等)',
  core_trend: 'core_trend — 非レバ・トレンド (QQQ / VOO 等)',
  leveraged_trend: 'leveraged_trend — レバ ETF (TQQQ / SOXL 等)',
  low_volatility: 'low_volatility — 低ボラ ETF (USMV / SPLV 等)',
  sector_trend: 'sector_trend — 1x セクター ETF (SMH / SOXX 等)',
  inverse_hedge: 'inverse_hedge — 3x インバース・短期 (SQQQ / SOXS。1x は override 必須)',
  momentum: 'momentum — ⚠ モメンタム/ブレイク (1x向け・backtest未検証・要警告)',
}

/** 一覧テーブルの「ロール」セル (#452)。role + 配分の条件連動を 1 セルに要約する。 */
export function renderSymbolRoleCell(row: SymbolConfigRow): string {
  const role = row.role?.trim() || null
  const known = role !== null && (SYMBOL_ROLES as readonly string[]).includes(role)
  const roleBadge =
    role === null
      ? '<span class="muted" title="role 未設定 = 従来挙動">—</span>'
      : known
        ? `<code style="font-size:11px" title="${esc(SYMBOL_ROLE_LABELS[role as SymbolRole])}">${esc(role)}</code><div class="muted" style="font-size:11px">${esc(SYMBOL_ROLE_LABELS_SHORT[role as SymbolRole])}</div>`
        : `<span class="err" title="不正な role 値です。entry は抑止されます (fail-closed)。編集から正しい値を選んでください。">⚠ ${esc(role)}</span>`
  const notes: string[] = []
  if (row.alwaysActive) notes.push('<span title="判定に関わらず常時 target = active">常時配分</span>')
  if (row.entryRequired) notes.push('<span title="entry 判定 (ENTRY/HALF) 通過時のみ実配分有効">条件連動</span>')
  const fallbackList = parseCashFallbacksJson(row.cashFallbackSymbols, row.symbol)
  if (fallbackList.length > 0) {
    notes.push(
      `<span title="条件未通過時の退避先${fallbackList.length > 1 ? ' (等分割)' : ''}">→${fallbackList
        .map((fb) => `<a href="/dashboard/symbols/${encodeURIComponent(fb)}/edit">${esc(fb)}</a>`)
        .join('/')}</span>`,
    )
  }
  const noteHtml = notes.length
    ? `<div class="muted" style="font-size:11px;margin-top:2px">${notes.join(' / ')}</div>`
    : ''
  return `${roleBadge}${noteHtml}`
}

export function symbolFormBody(args: SymbolFormArgs): string {
  const { mode, row, error, globalDefaults } = args
  const currentInverse = args.currentInverse ?? null
  const action =
    mode === 'new' ? '/admin/symbol-config' : `/admin/symbol-config/${encodeURIComponent(row!.symbol)}/update`
  const symbolValue = row?.symbol ?? ''
  const nameValue = row?.name ?? ''
  const marketValue = row?.market ?? 'US'
  const currencyValue = row?.currency ?? 'USD'
  const activeChecked = (row?.active ?? true) ? ' checked' : ''
  const maxNotionalValue = row?.maxNotional === null || row?.maxNotional === undefined ? '' : String(row.maxNotional)
  const lotSizeValue = row?.lotSize === null || row?.lotSize === undefined ? '' : String(row.lotSize)
  const notesValue = row?.notes ?? ''
  const timeStopDaysOverrideValue =
    row?.timeStopDaysOverride === null || row?.timeStopDaysOverride === undefined
      ? ''
      : String(row.timeStopDaysOverride)
  const kAtrOverrideValue =
    row?.kAtrOverride === null || row?.kAtrOverride === undefined ? '' : String(row.kAtrOverride)
  // stop/TP override は DB に fraction 保存、表示は % (×100、stop は符号付き)。
  const stopPctOverrideValue =
    row?.stopPctOverride === null || row?.stopPctOverride === undefined
      ? ''
      : String(Math.round(row.stopPctOverride * 1000) / 10)
  const takeProfitPctOverrideValue =
    row?.takeProfitPctOverride === null || row?.takeProfitPctOverride === undefined
      ? ''
      : String(Math.round(row.takeProfitPctOverride * 1000) / 10)
  // 持ち越し設定は radio 2 択で両状態を明示する (「持ち越し」ラベル + 「持ち越さ
  // ない」checkbox の二重否定が ON/OFF どちらか読めない、という operator 指摘)。
  const intradayOnlyChecked = row?.intradayOnly ? ' checked' : ''
  // role / entry override (#452)。pullback / trend / 過伸長は
  // DB に fraction 保存、表示は % (×100)。ATR 比は ratio 生値。
  // 不正 role 値 (enum 外の DB 直書き) の fail-closed をフォームで弱めない
  // (CodeRabbit #453): 一致 option が無いと先頭 '' が選択され、保存で意図せず
  // 「未設定 = 従来挙動」へ silent に戻ってしまう。不正値はそのまま selected
  // option として出し、保存時は admin parse の enum 検証が 400 で弾く —
  // operator が明示的に正しい role を選び直すまで解除されない。
  const rawRoleValue = row?.role?.trim() ?? ''
  const roleIsKnown = rawRoleValue === '' || (SYMBOL_ROLES as readonly string[]).includes(rawRoleValue)
  const roleValue = rawRoleValue
  const pullbackMaxOverrideValue =
    row?.pullbackMaxOverride === null || row?.pullbackMaxOverride === undefined
      ? ''
      : String(Math.round(row.pullbackMaxOverride * 1000) / 10)
  const pullbackMinOverrideValue =
    row?.pullbackMinOverride === null || row?.pullbackMinOverride === undefined
      ? ''
      : String(Math.round(row.pullbackMinOverride * 1000) / 10)
  const minReturn50dOverrideValue =
    row?.minReturn50dOverride === null || row?.minReturn50dOverride === undefined
      ? ''
      : String(Math.round(row.minReturn50dOverride * 1000) / 10)
  const maxAtrRatioOverrideValue =
    row?.maxAtrRatioOverride === null || row?.maxAtrRatioOverride === undefined
      ? ''
      : String(row.maxAtrRatioOverride)
  const maxSma50DeviationPctOverrideValue =
    row?.maxSma50DeviationPctOverride === null || row?.maxSma50DeviationPctOverride === undefined
      ? ''
      : String(Math.round(row.maxSma50DeviationPctOverride * 1000) / 10)
  const requireAboveSma50OverrideValue =
    row?.requireAboveSma50Override === null || row?.requireAboveSma50Override === undefined
      ? ''
      : String(row.requireAboveSma50Override)
  // 条件連動配分 (#452 Layer 3)。
  const entryRequiredChecked = row?.entryRequired ? ' checked' : ''
  const alwaysActiveChecked = row?.alwaysActive ? ' checked' : ''
  const cashFallbackValue = row ? parseCashFallbacksJson(row.cashFallbackSymbols, row.symbol).join(', ') : ''
  const timeStopPlaceholder = globalDefaults
    ? `空欄で global default (${globalDefaults.timeStopDays}日) を使用`
    : '空欄で global default を使用'
  const kAtrPlaceholder = globalDefaults
    ? `空欄で global default (${globalDefaults.kAtr}) を使用`
    : '空欄で global default を使用'
  // 予算配分は DB に fraction (0..1) 保存、表示は % (×100)。
  const budgetAllocPctValue =
    row?.budgetAllocPct === null || row?.budgetAllocPct === undefined
      ? ''
      : String(Math.round(row.budgetAllocPct * 1000) / 10)
  // #460: edit モードは symbol 確定なので allowlist バッジを server 描画。
  const editAllowlistBadge =
    mode === 'edit'
      ? (() => {
          const badge = tradableBadgeHtml(args.tradableStatus ?? 'unknown')
          return badge
            ? `<div style="margin-top:6px">${badge}</div>`
            : `<div style="margin-top:6px"><span title="OpenAPI 取扱リスト (tradable/list) 在籍 — 発注可能" style="font-size:12px;color:#0e9f6e">✓ OpenAPI 取扱リスト在籍</span></div>`
        })()
      : ''
  const symbolField =
    mode === 'edit'
      ? // 値セルは必ず 1 要素 (div) に包む。複数の裸要素を出すと 2 列グリッドが
        // 1 セルずれて以降のラベル/値が全部崩れる (#layout)。
        `<div>
           <input type="text" name="symbol" value="${esc(symbolValue)}" readonly style="padding:6px;background:#eee">
           ${editAllowlistBadge}
           <p class="muted" style="margin:4px 0 0;font-size:11px">symbol は immutable です。変更したい場合は一度削除して再追加してください。</p>
         </div>`
      : `<div>
           <div style="position:relative;display:inline-block">
             <input type="text" name="symbol" id="symbol-form-symbol" value="${esc(symbolValue)}" required maxlength="10" pattern="[A-Za-z0-9]{1,10}" placeholder="SOXL / 7974 / 1570" autocomplete="off" data-1p-ignore="true" data-lpignore="true" data-form-type="other" oninput="window.searchSymbolSuggest(this.value)" onfocus="window.searchSymbolSuggest(this.value)" onblur="setTimeout(window.hideSymbolSuggest, 200)" style="padding:6px;width:200px;text-transform:uppercase">
             <ul id="symbol-form-symbol-suggest" style="display:none;position:absolute;top:100%;left:0;margin:2px 0 0;padding:0;list-style:none;background:#fff;border:1px solid #d0d0d5;border-radius:4px;width:380px;max-height:280px;overflow-y:auto;z-index:10;box-shadow:0 2px 6px rgba(0,0,0,0.1)"></ul>
           </div>
           <span id="symbol-tradability" style="margin-left:10px;font-size:13px"></span>
           <div id="symbol-allowlist" style="margin-top:4px;font-size:12px"></div>
         </div>`
  // #315: 登録モード選択 (単体 / インバース対)。new のみ。
  const modeSelector =
    mode === 'new'
      ? `<div style="grid-column:1/-1;display:flex;gap:16px;align-items:center;padding:8px 10px;background:#f5f5f7;border-radius:6px">
           <strong style="font-size:13px">登録モード:</strong>
           <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
             <input type="radio" name="reg_mode" value="single" checked onchange="window.setSymbolRegMode('single')"> 単体登録
           </label>
           <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
             <input type="radio" name="reg_mode" value="inverse" onchange="window.setSymbolRegMode('inverse')"> インバース対で登録
           </label>
         </div>`
      : ''
  // #315: インバース対。new ではモード選択で表示切替する入力欄 (銘柄欄と同じ Yahoo
  // autocomplete)、edit では現在の対を表示。
  const inverseField =
    mode === 'edit'
      ? `<label>インバース対 <span class="muted" style="font-size:11px">(inverse)</span></label>
         <div>
           ${
             currentInverse
               ? `<span>↔ <a href="/dashboard/symbols/${encodeURIComponent(currentInverse)}/edit"><strong>${esc(currentInverse)}</strong></a></span>
                  <p class="muted" style="margin:4px 0 0;font-size:11px">この銘柄は <strong>${esc(currentInverse)}</strong> と対です。相手に建玉がある間は BUY を見送ります (#315)。対の変更は一度削除して再登録してください。</p>`
               : `<span class="muted">未設定 (対なし)</span>
                  <p class="muted" style="margin:4px 0 0;font-size:11px">対を組むには、相手銘柄の新規追加時に「インバース対で登録」を選んでください。</p>`
           }
         </div>`
      : `<label id="symbol-form-inverse-label" style="display:none">インバース銘柄 <span class="muted" style="font-size:11px">(inverse)</span></label>
         <div id="symbol-form-inverse-row" style="display:none">
           <div style="position:relative;display:inline-block">
             <input type="text" name="inverse_symbol" id="symbol-form-inverse" value="" maxlength="10" pattern="[A-Za-z0-9]{1,10}" placeholder="例: SOXS" autocomplete="off" data-1p-ignore="true" data-lpignore="true" data-form-type="other" oninput="window.searchInverseSuggest(this.value)" onfocus="window.searchInverseSuggest(this.value)" onblur="setTimeout(window.hideInverseSuggest, 200)" style="padding:6px;width:200px;text-transform:uppercase">
             <ul id="symbol-form-inverse-suggest" style="display:none;position:absolute;top:100%;left:0;margin:2px 0 0;padding:0;list-style:none;background:#fff;border:1px solid #d0d0d5;border-radius:4px;width:380px;max-height:280px;overflow-y:auto;z-index:10;box-shadow:0 2px 6px rgba(0,0,0,0.1)"></ul>
             <input type="hidden" name="inverse_name" id="symbol-form-inverse-name" value="">
             <input type="hidden" name="inverse_market" id="symbol-form-inverse-market" value="">
             <input type="hidden" name="inverse_currency" id="symbol-form-inverse-currency" value="">
           </div>
         </div>`
  const errBlock = error ? `<p class="err" style="margin:0 0 12px">${esc(error)}</p>` : ''
  const heading = mode === 'new' ? '新規銘柄追加' : `編集: ${esc(symbolValue)}`
  // セクション開閉の初期状態: 値が入っている (= 編集で触った) セクションだけ開く。
  // 不正 role の警告はユーザーが見るべきなので強制 open。
  const hasSizingValues = maxNotionalValue !== '' || budgetAllocPctValue !== ''
  const hasStrategyValues =
    pullbackMaxOverrideValue !== '' ||
    pullbackMinOverrideValue !== '' ||
    minReturn50dOverrideValue !== '' ||
    maxAtrRatioOverrideValue !== '' ||
    maxSma50DeviationPctOverrideValue !== '' ||
    requireAboveSma50OverrideValue !== ''
  const hasExitValues =
    timeStopDaysOverrideValue !== '' ||
    kAtrOverrideValue !== '' ||
    stopPctOverrideValue !== '' ||
    takeProfitPctOverrideValue !== '' ||
    intradayOnlyChecked !== ''
  const hasAllocValues =
    entryRequiredChecked !== '' || alwaysActiveChecked !== '' || cashFallbackValue !== ''
  // 必須バッジ。任意 field は無印 (バッジだらけにしない)。
  const REQ =
    '<span style="display:inline-block;padding:0 6px;border-radius:8px;background:#fdecec;color:#c22;font-size:10px;font-weight:700;margin-left:4px;vertical-align:middle">必須</span>'
  const fieldGrid = 'display:grid;grid-template-columns:150px 1fr;gap:10px;align-items:center'
  const optSection = (title: string, hint: string, inner: string, open: boolean): string =>
    `<details${open ? ' open' : ''} style="border:1px solid #e3e3e8;border-radius:10px;background:#fff">
      <summary style="cursor:pointer;padding:10px 14px;font-size:13px;font-weight:600">${title} <span class="muted" style="font-size:11px;font-weight:normal">— ${hint} (任意)</span></summary>
      <div style="padding:2px 14px 14px;${fieldGrid}">${inner}</div>
    </details>`

  return `<h2 style="font-size:16px;margin:8px 0 12px">${heading}</h2>
  ${errBlock}
  <form method="post" action="${esc(action)}" style="max-width:680px;display:flex;flex-direction:column;gap:12px">
    ${modeSelector}
    <div style="border:1px solid #e3e3e8;border-radius:10px;background:#fff;padding:12px 14px">
      <div style="font-size:13px;font-weight:600;margin-bottom:2px">基本 <span class="muted" style="font-size:11px;font-weight:normal">— ${REQ} 以外は空欄で global 設定を使用</span></div>
      <div style="${fieldGrid}">
        <label>銘柄${REQ}</label>${symbolField}
        ${inverseField}
        <label>銘柄名</label>
        <input type="text" name="name" id="symbol-form-name" value="${esc(nameValue)}" maxlength="256" placeholder="Yahoo 選択で自動入力" style="padding:6px">
        <label>市場${REQ}</label>
        <select name="market" id="symbol-form-market" required style="padding:6px" onchange="window.syncSymbolFormCurrencyFromMarket(this.value)">
          <option value="US"${marketValue === 'US' ? ' selected' : ''}>US (米国)</option>
          <option value="JP"${marketValue === 'JP' ? ' selected' : ''}>JP (日本)</option>
        </select>
        <label>通貨${REQ}</label>
        <select name="currency" id="symbol-form-currency" required style="padding:6px;max-width:200px" onchange="window.syncSymbolFormCurrencyUnits(this.value)">
          <option value="USD"${currencyValue === 'USD' ? ' selected' : ''}>USD (米ドル)</option>
          <option value="JPY"${currencyValue === 'JPY' ? ' selected' : ''}>JPY (日本円)</option>
        </select>
        <label>売買単位${REQ}</label>
        <div>
          <input type="number" name="lot_size" id="symbol-form-lot-size" value="${esc(lotSizeValue)}" required step="1" min="1" max="100000" placeholder="JP 個別株=100 / ETF・US=1" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">株/口</span>
          <span id="symbol-form-lot-suggest" class="muted" style="font-size:11px;margin-left:6px"></span>
          <div class="muted" style="font-size:11px;margin-top:2px">未設定の銘柄は発注されません (fail-closed)</div>
        </div>
        <label>ロール${REQ}</label>
        <div style="flex:1 1 100%">
          <!-- #role-stats: select を廃止し、カードのギャラリー = ロール選択。クリックで
               選択 (hidden input に同期)、ホバーで画面右に大きいプレビュー (虚のチャート
               + 入場ゲート閾値、個別銘柄チャートタブの視覚言語を流用)。 -->
          <input type="hidden" name="role" id="symbol-form-role" value="${esc(roleValue)}">
          <div style="font-size:12px;margin-bottom:6px">選択中: <strong id="role-current" style="font-size:13px">—</strong></div>
          ${roleIsKnown ? '' : '<p class="err" style="margin:0 0 4px;font-size:11px">DB に enum 外の role 値が入っています。この銘柄の entry は抑止中 (fail-closed)。正しい role を選んで保存してください。</p>'}
          <!-- 2軸を構造で表現: タブ = 入場アーキ、タブ内のカード = 銘柄プロファイル。
               現状は「押し目」タブのみ有効。モメンタム/逆張りは設計中。 -->
          <div style="display:flex;gap:2px;border-bottom:1px solid #e3e3e8;margin-bottom:8px">
            <button type="button" class="role-arch-tab" data-arch="pullback" style="background:none;border:none;border-bottom:2px solid transparent;padding:6px 16px;font-size:13px;cursor:pointer">押し目</button>
            <button type="button" class="role-arch-tab" data-arch="momentum" style="background:none;border:none;border-bottom:2px solid transparent;padding:6px 16px;font-size:13px;cursor:pointer">モメンタム <span style="font-size:10px;color:#bbb">設計中</span></button>
            <button type="button" class="role-arch-tab" data-arch="reversion" style="background:none;border:none;border-bottom:2px solid transparent;padding:6px 16px;font-size:13px;cursor:pointer">逆張り <span style="font-size:10px;color:#bbb">設計中</span></button>
          </div>
          <div class="role-arch-panel" data-arch="pullback">
            <div id="role-gallery" style="display:flex;flex-wrap:wrap;gap:8px"></div>
          </div>
          <div class="role-arch-panel" data-arch="momentum" style="display:none">
            <div style="font-size:12px;color:#9a5b00;background:#fff4e5;border:1px solid #f0c98a;border-radius:8px;padding:10px 12px;line-height:1.55;margin-bottom:8px">
              <strong>⚠ 要注意ロール(エッジ未検証)</strong> — 新高値ブレイクの継続を取る入場アーキ。選択・取引は可能ですが、
              <b>backtest 上、発注可能なテーマ ETF (ICLN/TAN/QCLN) では成績まちまち〜不良 (TAN -60%DD)</b>。広域/テック 1x では有効だがそれらは OpenAPI 発注不可。<b>1x 銘柄のみ</b>に付け、少額・DRY_RUN から。
            </div>
            <div id="momentum-gallery" style="display:flex;flex-wrap:wrap;gap:8px"></div>
          </div>
          <div class="role-arch-panel" data-arch="reversion" style="display:none">
            <div style="font-size:12px;color:#9a5b00;background:#fff4e5;border:1px solid #f0c98a;border-radius:8px;padding:12px 14px;line-height:1.6">
              <strong>⚠ 使用不可(見送り)</strong> — 売られすぎの反発を拾う入場アーキ(1x向け)。<br>
              理由: red-team 評価で <b>$ POC のコスト/為替でエッジ証明困難</b>＋ <b>逆張りに適した 1x(広域指数)が OpenAPI 取扱外</b>(発注可の ICLN/TAN 等はテーマ ETF で逆張り不適=ナイフ掴み)。<br>
              現状は見送り。再訪は universe 拡大 + notional 引き上げが前提。
            </div>
          </div>
          <div class="muted" style="font-size:11px;margin-top:4px">cash_parking は BUY を生成しない / inverse_hedge は短期プリセット (time stop 5日)</div>
        </div>
        <!-- ホバー時に画面右へ出る大プレビュー (fixed)。 -->
        <div id="role-preview" style="display:none;position:fixed;right:16px;top:96px;width:300px;z-index:60;background:#fff;border:1px solid #d0d0d5;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,0.14);padding:10px 12px">
          <div id="role-preview-body"></div>
        </div>
        <script>
        (function () {
          // ROLE_RULE_PRESETS を global default に重ねた解決値 (%・日・倍)。
          var P = {
            leveraged_trend: { tr: 8, heat: 60, atr: 1.5, pbMax: -3, pbMin: -6, stop: -4, tp: 7, tstop: 10, katr: 2.0 },
            core_trend: { tr: 3, heat: 20, atr: 1.5, pbMax: -1.5, pbMin: -5, stop: -4, tp: 7, tstop: 10, katr: 2.0 },
            sector_trend: { tr: 4, heat: 30, atr: 1.5, pbMax: -2, pbMin: -5, stop: -4, tp: 7, tstop: 10, katr: 2.0 },
            low_volatility: { tr: 1.5, heat: 10, atr: 1.3, pbMax: -1, pbMin: -3, stop: -1.5, tp: 2.5, tstop: 15, katr: 2.0 },
            inverse_hedge: { tr: 15, heat: 40, atr: 1.5, pbMax: -3, pbMin: -6, stop: -4, tp: 7, tstop: 5, katr: 1.5 }
          };
          var COLOR = {
            core_trend: '#1a56db', leveraged_trend: '#d97706', sector_trend: '#0e9f9f',
            low_volatility: '#7e3af2', inverse_hedge: '#c22d2d', cash_parking: '#5b8c5a',
            momentum: '#b25000'
          };
          var LABEL = {
            leveraged_trend: 'レバETF・トレンド', core_trend: '非レバ・トレンド',
            sector_trend: 'セクター', low_volatility: '低ボラ',
            inverse_hedge: 'インバースヘッジ', cash_parking: '待機資金',
            momentum: 'モメンタム ⚠'
          };
          // 2軸の説明 (入場アーキ / horizon / 想定銘柄の性質)。現状は全ロール
          // 「押し目」アーキ。モメンタム/逆張りアーキは別軸で設計中 (未実装)。
          var DESC = {
            leveraged_trend: { arch: '押し目 (上昇中の押し目買い)', horizon: '中期 ~10日', character: '3x レバ ETF' },
            core_trend: { arch: '押し目 (上昇中の押し目買い)', horizon: '中期 ~10日', character: '1x トレンド' },
            sector_trend: { arch: '押し目 (上昇中の押し目買い)', horizon: '中期 ~10日', character: '1x セクター ETF' },
            low_volatility: { arch: '押し目 (上昇中の押し目買い)', horizon: '中期 ~15日', character: '低ボラ 1x' },
            inverse_hedge: { arch: '押し目 (下落レジームの inverse 押し目)', horizon: '超短 5日', character: '3x インバース' },
            cash_parking: { arch: 'entry なし', horizon: '—', character: '待機資金 (退避先・常時配分)' },
            momentum: { arch: 'モメンタム (新高値ブレイク継続)', horizon: '短期 3–7日', character: '1x モメンタム ⚠ backtest 未検証' }
          };
          var ORDER = ['leveraged_trend', 'core_trend', 'sector_trend', 'low_volatility', 'inverse_hedge', 'cash_parking'];
          function fmtPct(v) { return (v > 0 ? '+' : '') + v + '%'; }
          // 銘柄別 override 入力 (任意セクション) を読む。空 → null。
          var OV_NAMES = {
            tr: 'min_return_50d_override', heat: 'max_sma50_deviation_pct_override',
            atr: 'max_atr_ratio_override', pbMax: 'pullback_max_override',
            pbMin: 'pullback_min_override', stop: 'stop_pct_override',
            tp: 'take_profit_pct_override', tstop: 'time_stop_days_override', katr: 'k_atr_override'
          };
          function ovNum(name) {
            var el = document.getElementsByName(name)[0];
            if (!el) return null;
            var v = (el.value || '').trim();
            if (v === '') return null;
            var n = Number(v);
            return isFinite(n) ? n : null;
          }
          function ovSel(name) {
            var el = document.getElementsByName(name)[0];
            return el ? (el.value || '') : '';
          }
          // 実効値 = override ?? preset ?? (sma50 は global 既定 true)。
          function eff(role) {
            var b = P[role], r = {}, ov = {}, any = false;
            var keys = ['tr', 'heat', 'atr', 'pbMax', 'pbMin', 'stop', 'tp', 'tstop', 'katr'];
            for (var i = 0; i < keys.length; i++) {
              var k = keys[i], o = ovNum(OV_NAMES[k]);
              r[k] = (o == null) ? b[k] : o;
              ov[k] = o != null;
              if (o != null) any = true;
            }
            var sma = ovSel('require_above_sma50_override');
            r.sma50 = sma === '' ? true : (sma === 'true');
            ov.sma50 = sma !== '';
            if (sma !== '') any = true;
            ov.any = any;
            r.ov = ov;
            return r;
          }
          function omark(b) { return b ? ' <span style="color:#d97706;font-weight:700" title="この銘柄の override">*</span>' : ''; }
          // 価格ラダー SVG。p = 実効パラメータ。big=true で軸ラベル付き。
          function ladder(role, p, w, h, big) {
            if (role === 'cash_parking') {
              return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '"><text x="' + (w / 2) + '" y="' + (h / 2) + '" font-size="' + (big ? 12 : 10) + '" fill="#5b8c5a" text-anchor="middle">entry なし</text></svg>';
            }
            var color = COLOR[role], ov = p.ov || {};
            var em = (p.pbMax + p.pbMin) / 2, tp = em + p.tp, st = em + p.stop;
            // 縦軸は描画する全水準 (0% / TP / stop / 押し目バンド) に合わせて動的スケール。
            // 固定レンジ (+4%..-11%) だと override で押し目や stop を広げた時に SVG 枠外へ
            // はみ出し、下の入場ゲート文字に重なっていた (operator 指摘) ため。
            var hi = Math.max(0, tp, p.pbMax) + 2, lo = Math.min(st, p.pbMin) - 2;
            if (hi - lo < 6) { hi += 1; lo -= 1; }
            function y(pct) { return 12 + (hi - pct) * ((h - 24) / (hi - lo)); }
            var X0 = 14, X1 = big ? w - 70 : w - 12, a = [];
            a.push('<line x1="' + X0 + '" y1="' + y(0).toFixed(1) + '" x2="' + X1 + '" y2="' + y(0).toFixed(1) + '" stroke="#c4c8cd" stroke-width="1"/>');
            var zy = y(p.pbMax), zh = y(p.pbMin) - y(p.pbMax);
            a.push('<rect x="' + X0 + '" y="' + zy.toFixed(1) + '" width="' + (X1 - X0) + '" height="' + zh.toFixed(1) + '" fill="#f59e0b33" stroke="#f59e0b" stroke-width="0.8"/>');
            a.push('<circle cx="' + ((X0 + X1) / 2).toFixed(1) + '" cy="' + y(em).toFixed(1) + '" r="' + (big ? 3.2 : 2.6) + '" fill="' + color + '"/>');
            a.push('<line x1="' + X0 + '" y1="' + y(st).toFixed(1) + '" x2="' + X1 + '" y2="' + y(st).toFixed(1) + '" stroke="#c22d2d" stroke-width="1" stroke-dasharray="3,2"/>');
            a.push('<line x1="' + X0 + '" y1="' + y(tp).toFixed(1) + '" x2="' + X1 + '" y2="' + y(tp).toFixed(1) + '" stroke="#0e9f6e" stroke-width="1" stroke-dasharray="3,2"/>');
            if (big) {
              var lx = X1 + 4;
              var mz = (ov.pbMax || ov.pbMin) ? ' *' : '', ms = ov.stop ? ' *' : '', mt = ov.tp ? ' *' : '';
              a.push('<text x="' + lx + '" y="' + y(0).toFixed(1) + '" font-size="8" fill="#80868b" dominant-baseline="middle">高値 0%</text>');
              a.push('<text x="' + lx + '" y="' + (zy + zh / 2).toFixed(1) + '" font-size="8" fill="#b25000" dominant-baseline="middle">押し目 ' + p.pbMax + '〜' + p.pbMin + '%' + mz + '</text>');
              a.push('<text x="' + lx + '" y="' + y(st).toFixed(1) + '" font-size="8" fill="#c22d2d" dominant-baseline="middle">stop ' + fmtPct(p.stop) + ms + '</text>');
              a.push('<text x="' + lx + '" y="' + y(tp).toFixed(1) + '" font-size="8" fill="#0e9f6e" dominant-baseline="middle">TP ' + fmtPct(p.tp) + mt + '</text>');
            } else {
              a.push('<text x="' + X0 + '" y="' + (y(0) - 2).toFixed(1) + '" font-size="7" fill="#9aa0a6">高値0%</text>');
            }
            return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" style="overflow:visible">' + a.join('') + '</svg>';
          }
          function gateHtml(role, p) {
            if (role === 'cash_parking') return '<div style="color:#5b8c5a;font-size:11px">戦略 entry なし。条件未達時の<b>退避先</b>・<b>常時配分</b>枠 (pullback 判定なし)。</div>';
            var ov = p.ov || {}, g = [];
            g.push('<div style="font-weight:600;font-size:11px;margin-bottom:2px">入場ゲート(閾値)</div>');
            g.push('<div>トレンド &gt; ' + fmtPct(p.tr) + omark(ov.tr) + '</div>');
            g.push('<div>SMA50 ' + (p.sma50 ? '上抜け必須' : '上抜け不問') + omark(ov.sma50) + '</div>');
            g.push('<div>過熱(SMA50乖離) ≤ ' + fmtPct(p.heat) + omark(ov.heat) + '</div>');
            g.push('<div>ボラ(ATR比) ≤ ' + p.atr + '×' + omark(ov.atr) + '</div>');
            g.push('<div>押し目 ' + p.pbMax + '% 〜 ' + p.pbMin + '%' + omark(ov.pbMax || ov.pbMin) + '</div>');
            g.push('<div style="font-weight:600;margin:4px 0 2px">退場</div>');
            g.push('<div>損切 ' + fmtPct(p.stop) + ' / 利確 ' + fmtPct(p.tp) + omark(ov.stop || ov.tp) + '</div>');
            g.push('<div>保有上限 ' + p.tstop + '日 (損切ATR ' + p.katr + '×)' + omark(ov.tstop || ov.katr) + '</div>');
            return '<div style="font-size:11px;line-height:1.55">' + g.join('') + '</div>';
          }
          function cardHtml(role) {
            var color = COLOR[role] || '#5f6368';
            var d = DESC[role] || {};
            // カードはグラフ無し (ホバー右プレビューに虚チャートがある)。名前 +
            // 銘柄プロファイル + 保有 だけのコンパクト表示。
            var sub = role === 'cash_parking'
              ? (d.character || '')
              : (d.character || '') + ' ・ 保有' + P[role].tstop + '日';
            return '<div class="role-tpl-card" data-role="' + role + '" ' +
              'style="cursor:pointer;border:1px solid #e3e3e8;border-radius:8px;padding:8px 10px;background:#fff;min-width:150px">' +
              '<div style="font-size:12px;font-weight:600"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color + ';margin-right:5px"></span>' + LABEL[role] + '</div>' +
              '<div style="font-size:10px;color:#86868b;margin-top:2px">' + sub + '</div>' +
              '</div>';
          }
          var selected = ${JSON.stringify(roleValue)};
          var currentShown = selected;
          function labelOf(role) { return LABEL[role] || (role ? ('⚠ ' + role) : '未選択'); }
          // 4 つの説明 (ロール / 入場アーキ / horizon / 想定銘柄の性質)。
          function descHtml(role) {
            var d = DESC[role];
            if (!d) return '';
            function row(k, v) { return '<div style="display:flex;gap:6px"><span style="color:#86868b;min-width:62px">' + k + '</span><span>' + v + '</span></div>'; }
            return '<div style="font-size:11px;line-height:1.5;background:#f6f6f9;border-radius:6px;padding:5px 7px;margin-bottom:6px">' +
              row('入場アーキ', d.arch) + row('horizon', d.horizon) + row('想定銘柄', d.character) + '</div>';
          }
          function showPreview(role) {
            currentShown = role;
            var pv = document.getElementById('role-preview');
            var body = document.getElementById('role-preview-body');
            if (!pv || !body) return;
            if (role === 'momentum') {
              body.innerHTML = '<div style="font-size:13px;font-weight:700;margin-bottom:4px;color:' + COLOR.momentum + '">⚡ モメンタム ⚠</div>' +
                descHtml('momentum') +
                '<div style="font-size:11px;line-height:1.55">新高値ブレイクの継続を取る別戦略 (BreakoutMomentumStrategy)。' +
                'entry: トレンド+ 新高値ブレイク+ SMA50上+ 過熱でない。exit: stop -5% / TP +10% / 保有~7日。<br>' +
                '<span style="color:#c22;font-weight:600">⚠ backtest 未検証。発注可テーマETFでは成績不良の例あり (TAN -60%DD)。1x のみ・少額で。</span></div>';
              pv.style.display = '';
              return;
            }
            if (!role || (!P[role] && role !== 'cash_parking')) { pv.style.display = 'none'; return; }
            var color = COLOR[role] || '#5f6368';
            if (role === 'cash_parking') {
              body.innerHTML = '<div style="font-size:13px;font-weight:700;margin-bottom:4px;color:' + color + '">待機資金</div>' + descHtml(role) + ladder(role, {}, 280, 120, true) + '<div style="margin-top:6px">' + gateHtml(role, {}) + '</div>';
              pv.style.display = '';
              return;
            }
            var p = eff(role);
            var note = p.ov.any ? 'preset + この銘柄の override (* 印) を反映' : 'preset の姿 (override 未設定)';
            body.innerHTML =
              '<div style="font-size:13px;font-weight:700;margin-bottom:4px;color:' + color + '">' + LABEL[role] + '</div>' +
              descHtml(role) +
              ladder(role, p, 280, 150, true) +
              '<div style="margin-top:6px">' + gateHtml(role, p) + '</div>' +
              '<div style="font-size:10px;color:#aaa;margin-top:6px">直近高値=0% 基準・実効値の模式<br>' + note + '</div>';
            pv.style.display = '';
          }
          function highlight(role) {
            var cards = document.querySelectorAll('.role-tpl-card');
            for (var i = 0; i < cards.length; i++) {
              var r = cards[i].getAttribute('data-role'), on = r === role;
              cards[i].style.border = on ? ('2px solid ' + (COLOR[r] || '#06c')) : '1px solid #e3e3e8';
              cards[i].style.background = on ? '#fcfbf7' : '#fff';
              cards[i].style.boxShadow = on ? '0 1px 4px rgba(0,0,0,0.08)' : 'none';
            }
          }
          function pick(role) {
            selected = role;
            var inp = document.getElementById('symbol-form-role');
            if (inp) inp.value = role;
            var cur = document.getElementById('role-current');
            if (cur) cur.textContent = labelOf(role);
            highlight(role);
            showPreview(role);
          }
          function rerender() { showPreview(currentShown); }
          // momentum はグラフ無し (preset が押し目と別形)。名前 + 性質だけのカード。
          function momentumCardHtml() {
            var d = DESC.momentum || {};
            return '<div class="role-tpl-card" data-role="momentum" ' +
              'style="cursor:pointer;border:1px solid #f0c98a;border-radius:8px;padding:8px 10px;background:#fffaf2;min-width:150px">' +
              '<div style="font-size:12px;font-weight:600;color:' + COLOR.momentum + '">⚡ モメンタム</div>' +
              '<div style="font-size:10px;color:#9a5b00;margin-top:2px">' + (d.character || '') + ' ・ 保有~7日</div>' +
              '</div>';
          }
          function init() {
            var gallery = document.getElementById('role-gallery');
            if (!gallery) return;
            gallery.innerHTML = ORDER.map(cardHtml).join('');
            var mg = document.getElementById('momentum-gallery');
            if (mg) mg.innerHTML = momentumCardHtml();
            // gallery + momentum の全カードに listener を張る。
            var cards = document.querySelectorAll('.role-tpl-card');
            for (var i = 0; i < cards.length; i++) {
              (function (card) {
                var r = card.getAttribute('data-role');
                card.addEventListener('click', function () { pick(r); });
                card.addEventListener('mouseenter', function () { showPreview(r); });
              })(cards[i]);
            }
            // ホバーが外れたら選択中ロールのプレビューに戻す。
            gallery.addEventListener('mouseleave', function () { showPreview(selected); });
            // 銘柄別 override を編集したら実効プレビューを即更新。
            var names = ['min_return_50d_override', 'max_sma50_deviation_pct_override', 'max_atr_ratio_override', 'pullback_max_override', 'pullback_min_override', 'stop_pct_override', 'take_profit_pct_override', 'time_stop_days_override', 'k_atr_override', 'require_above_sma50_override'];
            for (var j = 0; j < names.length; j++) {
              var el = document.getElementsByName(names[j])[0];
              if (el) { el.addEventListener('input', rerender); el.addEventListener('change', rerender); }
            }
            // 入場アーキのタブ切替 (押し目=有効、モメンタム/逆張り=設計中パネル)。
            function setArchTab(arch) {
              var tabs = document.querySelectorAll('.role-arch-tab');
              for (var t = 0; t < tabs.length; t++) {
                var a = tabs[t].getAttribute('data-arch'), on = a === arch;
                tabs[t].style.borderBottom = on ? '2px solid #06c' : '2px solid transparent';
                tabs[t].style.color = on ? '#06c' : '#5f6368';
                tabs[t].style.fontWeight = on ? '600' : 'normal';
              }
              var panels = document.querySelectorAll('.role-arch-panel');
              for (var q = 0; q < panels.length; q++) {
                panels[q].style.display = panels[q].getAttribute('data-arch') === arch ? '' : 'none';
              }
            }
            var tabs = document.querySelectorAll('.role-arch-tab');
            for (var k = 0; k < tabs.length; k++) {
              (function (tab) {
                tab.addEventListener('click', function () { setArchTab(tab.getAttribute('data-arch')); });
              })(tabs[k]);
            }
            setArchTab(selected === 'momentum' ? 'momentum' : 'pullback');
            var cur = document.getElementById('role-current');
            if (cur) cur.textContent = labelOf(selected);
            highlight(selected);
            showPreview(selected);
          }
          if (document.readyState !== 'loading') init();
          else document.addEventListener('DOMContentLoaded', init);
        })();
        </script>
        <label>状態</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px">
          <input type="hidden" name="active" value="false">
          <input type="checkbox" name="active" value="true"${activeChecked}> 取引対象として有効
        </label>
      </div>
    </div>

    ${optSection(
      '発注サイズ',
      '1 注文の上限と配分',
      `<label>1注文上限</label>
        <div>
          <input type="number" name="max_notional" value="${esc(maxNotionalValue)}" step="0.01" min="0.01" placeholder="空欄 = global 上限" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px"><span id="symbol-form-max-notional-unit">${esc(currencyValue)}</span> / 1 発注 (global: <code>max_order_notional_<span id="symbol-form-max-notional-global-key">${currencyValue.toLowerCase()}</span></code>)</span>
        </div>
        <label>予算配分</label>
        <div>
          <input type="number" name="budget_alloc_pct" value="${esc(budgetAllocPctValue)}" step="0.1" min="0.1" max="100" placeholder="空欄 = risk-% sizing" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">% — 口座総額(円) × この % で発注</span>
        </div>`,
      hasSizingValues,
    )}

    ${optSection(
      '戦略ロール・entry 条件',
      'role プリセットと entry gate の銘柄別調整',
      `<label>押し目バンド</label>
        <div>
          <input type="number" name="pullback_max_override" value="${esc(pullbackMaxOverrideValue)}" step="0.1" min="-100" max="0" placeholder="浅い側 (例 -3)" style="padding:6px;width:130px">
          〜
          <input type="number" name="pullback_min_override" value="${esc(pullbackMinOverrideValue)}" step="0.1" min="-100" max="0" placeholder="深い側 (例 -6)" style="padding:6px;width:130px">
          <span class="muted" style="font-size:12px;margin-left:6px">% (浅い側 ≥ 深い側)</span>
        </div>
        <label>トレンド条件</label>
        <div>
          <input type="number" name="min_return_50d_override" value="${esc(minReturn50dOverrideValue)}" step="0.1" min="-100" max="1000" placeholder="空欄 = preset / global" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">% (20日騰落率の下限)</span>
        </div>
        <label>ボラ過熱上限</label>
        <div>
          <input type="number" name="max_atr_ratio_override" value="${esc(maxAtrRatioOverrideValue)}" step="0.1" min="0.1" max="10" placeholder="空欄 = preset / global" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">× baseline ATR</span>
        </div>
        <label>過伸長上限</label>
        <div>
          <input type="number" name="max_sma50_deviation_pct_override" value="${esc(maxSma50DeviationPctOverrideValue)}" step="0.1" min="0.1" max="1000" placeholder="空欄 = preset / global" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">% (SMA50 上方乖離)</span>
        </div>
        <label>SMA50 上抜け</label>
        <select name="require_above_sma50_override" style="padding:6px;max-width:240px">
          <option value=""${requireAboveSma50OverrideValue === '' ? ' selected' : ''}>global default に従う</option>
          <option value="true"${requireAboveSma50OverrideValue === 'true' ? ' selected' : ''}>必須 (price &gt; SMA50)</option>
          <option value="false"${requireAboveSma50OverrideValue === 'false' ? ' selected' : ''}>不要</option>
        </select>
        `,
      hasStrategyValues,
    )}

    ${optSection(
      '損切・利食・保有',
      'exit 系の銘柄別調整',
      `<label>保有上限</label>
        <div>
          <input type="number" name="time_stop_days_override" value="${esc(timeStopDaysOverrideValue)}" step="1" min="1" max="365" placeholder="${esc(timeStopPlaceholder)}" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">営業日</span>
        </div>
        <label>ATR stop 倍率</label>
        <div>
          <input type="number" name="k_atr_override" value="${esc(kAtrOverrideValue)}" step="0.1" min="0.5" max="5.0" placeholder="${esc(kAtrPlaceholder)}" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">× ATR20</span>
        </div>
        <label>損切ライン</label>
        <div>
          <input type="number" name="stop_pct_override" value="${esc(stopPctOverrideValue)}" step="0.1" min="-99" max="-0.1" placeholder="空欄 = global" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">% (負値)。exit は max(この%, kAtr×ATR) の広い方</span>
        </div>
        <label>利食ライン</label>
        <div>
          <input type="number" name="take_profit_pct_override" value="${esc(takeProfitPctOverrideValue)}" step="0.1" min="0.1" max="100" placeholder="空欄 = global" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">% (正値)</span>
        </div>
        <label>持ち越し</label>
        <div style="display:flex;flex-direction:column;gap:4px;font-size:13px">
          <label style="display:flex;align-items:center;gap:6px">
            <input type="radio" name="intraday_only" value="false"${intradayOnlyChecked === '' ? ' checked' : ''}> 持ち越す <span class="muted" style="font-size:12px">(スイング — 既定)</span>
          </label>
          <label style="display:flex;align-items:center;gap:6px">
            <input type="radio" name="intraday_only" value="true"${intradayOnlyChecked}> 持ち越さない <span class="muted" style="font-size:12px">(デイトレ — US 引け前に強制クローズ)</span>
          </label>
        </div>`,
      hasExitValues,
    )}

    ${optSection(
      '配分の条件連動',
      'entry 判定と予算配分の連動 (#452)',
      `<label>条件連動</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px">
          <input type="hidden" name="entry_required" value="false">
          <input type="checkbox" name="entry_required" value="true"${entryRequiredChecked}> entry 判定 (ENTRY/HALF) 通過時のみ実配分を有効化
        </label>
        <label>常時配分</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px">
          <input type="hidden" name="always_active" value="false">
          <input type="checkbox" name="always_active" value="true"${alwaysActiveChecked}> 判定に関わらず常時 target = active (待機資金 ETF 用)
        </label>
        <label>退避先</label>
        <div>
          <input type="text" name="cash_fallback_symbol" value="${esc(cashFallbackValue)}" maxlength="60" placeholder="例: SGOV, USMV (複数は等分割)" style="padding:6px;width:240px;text-transform:uppercase">
          <span class="muted" style="font-size:12px;margin-left:6px"><strong>条件連動 ON のときのみ有効</strong>。同一通貨のみ。自動発注は flag (default off) を on にするまで無し</span>
        </div>`,
      hasAllocValues,
    )}

    <div style="border:1px solid #e3e3e8;border-radius:10px;background:#fff;padding:12px 14px;${fieldGrid}">
      <label>メモ</label>
      <textarea name="notes" maxlength="256" rows="2" placeholder="自由記述 (例: 一時停止理由)" style="padding:6px;font-family:inherit">${esc(notesValue)}</textarea>
    </div>

    <div style="display:flex;gap:8px">
      <button type="submit" id="symbol-form-save" style="padding:8px 24px;background:#06c;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">保存</button>
      <a href="/dashboard/symbols" style="padding:8px 24px;text-decoration:none;border:1px solid #d0d0d5;border-radius:6px;font-size:13px">キャンセル</a>
    </div>
  </form>
  <script>
    window.syncSymbolFormCurrencyUnits = function (cur) {
      var unit = document.getElementById('symbol-form-max-notional-unit');
      var key = document.getElementById('symbol-form-max-notional-global-key');
      if (unit) unit.textContent = cur;
      if (key) key.textContent = cur.toLowerCase();
    };
    window.syncSymbolFormCurrencyFromMarket = function (market) {
      var cur = market === 'JP' ? 'JPY' : 'USD';
      var sel = document.getElementById('symbol-form-currency');
      if (sel) sel.value = cur;
      window.syncSymbolFormCurrencyUnits(cur);
    };
    // 汎用 Yahoo lookup suggest コア。listId の <ul> に候補を描画し、click で pick(m)。
    window._symbolSuggestTimer = {};
    window._symbolSuggestSeq = {};
    window._renderSymbolSuggest = function (q, listId, pick) {
      var list = document.getElementById(listId);
      if (!list) return;
      var query = (q || '').trim();
      if (query.length < 2) { list.style.display = 'none'; return; }
      if (window._symbolSuggestTimer[listId]) clearTimeout(window._symbolSuggestTimer[listId]);
      window._symbolSuggestTimer[listId] = setTimeout(function () {
        var mySeq = (window._symbolSuggestSeq[listId] = (window._symbolSuggestSeq[listId] || 0) + 1);
        fetch('/admin/symbol-config/lookup?q=' + encodeURIComponent(query), { credentials: 'same-origin' })
          .then(function (res) { return res.ok ? res.json() : { matches: [] }; })
          .then(function (data) {
            if (mySeq !== window._symbolSuggestSeq[listId]) return; // 古い response は捨てる
            var matches = (data && data.matches) || [];
            list.innerHTML = '';
            if (matches.length === 0) {
              var hint = document.createElement('li');
              hint.style.cssText = 'padding:6px 10px;color:#86868b;font-size:11px;font-style:italic;cursor:default';
              hint.textContent = '"' + query + '" に一致する銘柄無し (Yahoo Finance)。手動入力で続行可。';
              list.appendChild(hint);
              list.style.display = 'block';
              return;
            }
            matches.forEach(function (m) {
              var li = document.createElement('li');
              li.style.cssText = 'padding:6px 10px;cursor:pointer;border-bottom:1px solid #eee';
              var sym = document.createElement('strong');
              sym.textContent = m.symbol;
              var nameSpan = document.createElement('span');
              nameSpan.style.cssText = 'color:#86868b;margin-left:8px;font-size:12px';
              nameSpan.textContent = (m.name || '?') + ' (' + m.market + '/' + m.currency + ')';
              li.appendChild(sym);
              li.appendChild(nameSpan);
              li.addEventListener('mousedown', function () { pick(m); });
              li.addEventListener('mouseover', function () { li.style.background = '#eef'; });
              li.addEventListener('mouseout', function () { li.style.background = '#fff'; });
              list.appendChild(li);
            });
            list.style.display = 'block';
          })
          .catch(function () { list.style.display = 'none'; });
      }, 250);
    };
    // 主銘柄欄: pick で銘柄 / 名前 / 市場 / 通貨を自動入力。
    window.hideSymbolSuggest = function () {
      var list = document.getElementById('symbol-form-symbol-suggest');
      if (list) list.style.display = 'none';
    };
    window.searchSymbolSuggest = function (q) {
      window._renderSymbolSuggest(q, 'symbol-form-symbol-suggest', window.pickSymbolSuggest);
    };
    window.pickSymbolSuggest = function (m) {
      var symInput = document.getElementById('symbol-form-symbol');
      var nameInput = document.getElementById('symbol-form-name');
      var marketSel = document.getElementById('symbol-form-market');
      var currencySel = document.getElementById('symbol-form-currency');
      if (symInput) symInput.value = m.symbol;
      if (m.name && nameInput) nameInput.value = m.name;
      if (m.market && marketSel) marketSel.value = m.market;
      if (m.currency && currencySel) currencySel.value = m.currency;
      if (m.currency) window.syncSymbolFormCurrencyUnits(m.currency);
      window.suggestLotSizeFromMatch(m);
      window.hideSymbolSuggest();
      if (symInput) symInput.focus();
      window.checkSymbolTradability();
    };
    // 取扱チェック (#461): 銘柄確定時に Preview Order (発注なし) で Webull JP の
    // 取引可否を照会。'denied' (TICKER_IS_DENY 確定) のみ保存をブロックする。
    // 'error' / 'unavailable' はブロックしない — check 不能で登録が全部止まるのは
    // 過剰 fail-closed (発注側には #460 の事後ガードがある)。
    window._tradabilityDenied = false;
    window._tradabilitySeq = 0;
    window.checkSymbolTradability = function () {
      var statusEl = document.getElementById('symbol-tradability');
      var saveBtn = document.getElementById('symbol-form-save');
      var symInput = document.getElementById('symbol-form-symbol');
      var marketSel = document.getElementById('symbol-form-market');
      if (!statusEl || !symInput) return;
      var sym = (symInput.value || '').trim().toUpperCase();
      window._tradabilityDenied = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = ''; }
      var allowElEarly = document.getElementById('symbol-allowlist');
      if (!/^[A-Z0-9]{1,10}$/.test(sym)) { statusEl.textContent = ''; if (allowElEarly) allowElEarly.textContent = ''; return; }
      var mySeq = ++window._tradabilitySeq;
      statusEl.textContent = '⏳ 取扱確認中...';
      statusEl.style.color = '#86868b';
      var market = marketSel && marketSel.value === 'JP' ? 'JP' : 'US';
      fetch('/admin/symbol-config/tradability-check?symbol=' + encodeURIComponent(sym) + '&market=' + market, { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (mySeq !== window._tradabilitySeq) return; // 古い応答は捨てる
          // instrument 照会 (#475) のフラグ要約。verdict 行の後ろに添える。
          var instSuffix = '';
          if (res.instrument) {
            var chips = [];
            if (res.instrument.overnightTradingSupported === true) chips.push('24h取引対応');
            if (res.instrument.shortable === true) chips.push('空売り可');
            var lev = Number(res.instrument.etfLeveragedFactor);
            if (Number.isFinite(lev) && lev !== 0) chips.push('レバレッジ ' + (lev > 0 ? '+' : '') + lev + 'x' + (res.instrument.inverseEtf === true ? ' / インバース' : ''));
            if (chips.length > 0) instSuffix = ' ｜ ' + chips.join(' ・ ');
          }
          // #460: OpenAPI allowlist (tradable/list)。instrument status (OC) では
          // 区別できない deny を区別できる唯一の事前シグナルなので別行で強調する。
          var allowEl = document.getElementById('symbol-allowlist');
          if (allowEl) {
            if (res.allowlist === 'tradable') {
              allowEl.textContent = '✓ OpenAPI 取扱リスト在籍 (発注可能)';
              allowEl.style.color = '#0e9f6e';
            } else if (res.allowlist === 'disappeared') {
              allowEl.textContent = '⚠ OpenAPI 取扱リストから消失 (取扱停止の可能性)';
              allowEl.style.color = '#9a5b00';
            } else {
              allowEl.textContent = '⚠ OpenAPI 取扱リスト未登録 — アプリで売買できても OpenAPI 経由では発注で弾かれる可能性';
              allowEl.style.color = '#6e6e73';
            }
          }
          if (res.verdict === 'denied') {
            var why = res.reason === 'known_deny' ? '過去に Webull が発注拒否'
              : res.reason === 'invalid_symbol' ? 'Webull に存在しない銘柄'
              : res.reason === 'not_listed' ? 'Webull の銘柄マスタに不存在'
              : res.reason === 'instrument_status' ? '取引停止中の銘柄 (status CO/NT)'
              : 'Webull JP 取扱なし';
            statusEl.textContent = '❌ ' + why + ' — 登録できません';
            statusEl.style.color = '#c22';
            window._tradabilityDenied = true;
            if (saveBtn) { saveBtn.disabled = true; saveBtn.style.opacity = '0.4'; }
          } else if (res.reason === 'quote_ok') {
            // instrument status=OC でも発注 deny は事前検証不可 (USMV 前例) ので
            // ✅ は出さない
            var head = res.instrument && res.instrument.status === 'OC'
              ? '△ status OC (取引可) + 見積もり可 — 発注 deny のみ未保証'
              : '△ 見積もり可 — 発注可否は未保証 (Webull アプリで確認)';
            statusEl.textContent = head + instSuffix;
            statusEl.style.color = '#b25000';
          } else {
            statusEl.textContent = '❓ 確認不可 (登録は可能)';
            statusEl.style.color = '#86868b';
          }
        })
        .catch(function () {
          if (mySeq !== window._tradabilitySeq) return;
          statusEl.textContent = '❓ 取扱を確認できませんでした (登録は可能)';
          statusEl.style.color = '#86868b';
        });
    };
    // 手入力で symbol を変えた場合も blur で再チェック。submit は denied 時に阻止。
    (function () {
      var symInput = document.getElementById('symbol-form-symbol');
      if (symInput && !symInput.readOnly) {
        symInput.addEventListener('change', function () { window.checkSymbolTradability(); });
        var form = symInput.closest('form');
        if (form) {
          form.addEventListener('submit', function (ev) {
            if (window._tradabilityDenied) {
              ev.preventDefault();
              var statusEl = document.getElementById('symbol-tradability');
              if (statusEl) statusEl.textContent = '❌ Webull JP 取扱なし — 登録できません';
            }
          });
        }
      }
    })();
    // Yahoo quoteType + market から売買単位の推奨値を自動入力する。
    // ETF → 1 口、JP 個別株 (EQUITY) → 100 株、US 個別株 → 1 株。あくまで推奨で、
    // operator が手入力で上書き可能 (確定は手入力必須・fail-closed なので #symbol-lot-size)。
    window.suggestLotSizeFromMatch = function (m) {
      var lotInput = document.getElementById('symbol-form-lot-size');
      var hint = document.getElementById('symbol-form-lot-suggest');
      if (!lotInput) return;
      var qt = (m.quoteType || '').toUpperCase();
      var mkt = (m.market || 'US').toUpperCase();
      var suggested = qt === 'ETF' ? 1 : (mkt === 'JP' ? 100 : 1);
      lotInput.value = String(suggested);
      if (hint) {
        var kind = qt === 'ETF' ? 'ETF' : (mkt === 'JP' ? 'JP 個別株' : 'US 株');
        hint.textContent = '推奨: ' + suggested + ' (' + kind + ')。要確認';
      }
    };
    // インバース銘柄欄: 同じ Yahoo suggest だが pick は inverse 入力だけを埋める
    // (主銘柄の name/market/currency は上書きしない)。
    window.hideInverseSuggest = function () {
      var list = document.getElementById('symbol-form-inverse-suggest');
      if (list) list.style.display = 'none';
    };
    window.searchInverseSuggest = function (q) {
      window._renderSymbolSuggest(q, 'symbol-form-inverse-suggest', window.pickInverseSuggest);
    };
    window.pickInverseSuggest = function (m) {
      var inv = document.getElementById('symbol-form-inverse');
      if (inv) { inv.value = m.symbol; inv.focus(); }
      // counterpart の銘柄名 / 市場 / 通貨を hidden field に焼く (#315: 一覧で
      // インバース側の銘柄名を出すため。空 pick / 手動入力時は空のまま)。
      var nm = document.getElementById('symbol-form-inverse-name');
      var mk = document.getElementById('symbol-form-inverse-market');
      var cur = document.getElementById('symbol-form-inverse-currency');
      if (nm) nm.value = m.name || '';
      if (mk) mk.value = m.market || '';
      if (cur) cur.value = m.currency || '';
      window.hideInverseSuggest();
    };
    // 登録モード切替: 単体 / インバース対。inverse 欄の表示と required を制御。
    window.setSymbolRegMode = function (modeVal) {
      var label = document.getElementById('symbol-form-inverse-label');
      var rowEl = document.getElementById('symbol-form-inverse-row');
      var inv = document.getElementById('symbol-form-inverse');
      var show = modeVal === 'inverse';
      if (label) label.style.display = show ? '' : 'none';
      if (rowEl) rowEl.style.display = show ? '' : 'none';
      if (inv) {
        if (show) { inv.setAttribute('required', 'required'); }
        else { inv.removeAttribute('required'); inv.value = ''; window.hideInverseSuggest(); }
      }
    };
  </script>`
}
