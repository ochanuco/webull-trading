import type { SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { displaySymbol, esc } from './shared'

// Mirrors the client-side `inferCategory` in TS so server-rendered universe buttons get the
// right `data-category` attribute without duplicating the category assignment differently.
function inferProbeCategory(symbol: string): 'JP_STOCK' | 'JP_ETF' | 'US_STOCK' | 'US_ETF' {
  const upper = symbol.toUpperCase()
  if (/^\d{4}$/.test(upper)) {
    if (upper === '1570') return 'JP_ETF'
    return 'JP_STOCK'
  }
  if (upper === 'SOXL' || upper === 'SOXS' || upper === 'SPY' || upper === 'QQQ') {
    return 'US_ETF'
  }
  return 'US_STOCK'
}

function renderUniverseLinks(universe: SymbolUniverse | null): string {
  if (!universe) {
    return '<span class="muted" style="font-size:12px">universe ロード失敗 (DB 未設定 / 接続失敗)</span>'
  }
  const inactiveSet = new Set(universe.inactiveSymbols.map((s) => s.toUpperCase()))
  const allSymbols = [...universe.allowedSymbols, ...universe.inactiveSymbols]
  if (allSymbols.length === 0) {
    return '<span class="muted" style="font-size:12px">登録銘柄なし</span>'
  }
  const groups: Record<string, string[]> = {
    US_STOCK: [],
    US_ETF: [],
    JP_STOCK: [],
    JP_ETF: [],
  }
  for (const sym of allSymbols) {
    const cat = inferProbeCategory(sym)
    groups[cat]!.push(sym)
  }
  const renderBtn = (sym: string, cat: string): string => {
    const inactive = inactiveSet.has(sym.toUpperCase())
    const display = displaySymbol(sym, universe)
    const style = inactive ? 'color:#999;background:#f3f3f3' : ''
    const inactiveBadge = inactive
      ? ' <span style="font-size:10px;color:#999">(INACTIVE)</span>'
      : ''
    return `<button type="button" class="bp-chip probe-pickbtn" data-symbol="${esc(sym)}" data-category="${cat}"${style ? ` style="${style}"` : ''} title="${esc(cat)}">${esc(display)}${inactiveBadge}</button>`
  }
  const sections: string[] = []
  for (const cat of ['US_STOCK', 'US_ETF', 'JP_STOCK', 'JP_ETF']) {
    const syms = groups[cat]!
    if (syms.length === 0) continue
    const buttons = syms.map((s) => renderBtn(s, cat)).join(' ')
    sections.push(
      `<div style="margin-bottom:8px"><span class="muted" style="font-size:11px;margin-right:8px">${cat}</span>${buttons}</div>`,
    )
  }
  return sections.join('')
}

export function brokerProbeBody(args: {
  symbol: string
  category: string
  universe: SymbolUniverse | null
}): string {
  // Fetched client-side against /admin/broker/probe (not proxied through this handler): a
  // server-side sub-fetch would need to forward the Access JWT request-to-request, mixing
  // concerns, whereas the browser's own Access cookie flows naturally client-side.
  const universeLinks = renderUniverseLinks(args.universe)
  // Omitted when the universe already contains AAPL, to avoid offering it as a control chip twice.
  const hasAapl = [
    ...(args.universe?.allowedSymbols ?? []),
    ...(args.universe?.inactiveSymbols ?? []),
  ].some((sym) => sym.toUpperCase() === 'AAPL')
  const controlChip = hasAapl
    ? ''
    : `<div style="margin-bottom:10px"><button type="button" class="bp-chip probe-pickbtn" data-symbol="AAPL" data-category="US_STOCK">AAPL <span class="muted" style="font-size:10px">control</span></button></div>`
  return `<style>
  .bp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin:12px 0}
  .bp-card{background:#fff;border:1px solid #e3e3e8;border-radius:10px;padding:14px 16px}
  .bp-card h3{font-size:13px;margin:0 0 8px;display:flex;align-items:center;gap:8px;justify-content:space-between}
  .bp-card .bp-body{font-size:13px;line-height:1.6}
  .bp-pill{display:inline-block;padding:1px 10px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap}
  .bp-pill-ok{background:#e6f6ec;color:#057a55}
  .bp-pill-ng{background:#fdecec;color:#c22}
  .bp-pill-unknown{background:#eef2f8;color:#46608a}
  .bp-pill-wait{background:#f3f3f5;color:#86868b}
  .bp-chip{padding:4px 12px;font-size:12px;border:1px solid #d8d8de;border-radius:14px;cursor:pointer;background:#fff;margin:0 4px 6px 0}
  .bp-chip:hover{background:#eef4ff;border-color:#06c}
  .bp-chip-selected{background:#06c !important;border-color:#06c !important;color:#fff !important}
  .bp-chip-selected .muted{color:#cfe0ff !important}
  .bp-raw{background:#f6f6f8;border:1px solid #e3e3e8;border-radius:6px;padding:8px;font-size:11px;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;margin-top:8px}
  .bp-num{font-variant-numeric:tabular-nums}
  </style>

  <div class="bp-card" style="margin-top:8px">
    <h3>銘柄を選んで診断 <span class="muted" id="probe-status" style="font-weight:normal;font-size:12px">待機中</span>
      <button type="button" id="probe-copy-ai" hidden style="float:right;padding:4px 12px;background:#fff;color:#333;border:1px solid #ccc;border-radius:6px;cursor:pointer;font-size:12px;font-weight:normal" title="probe 結果全文 (全 raw セクション + meta) をコピー">📋 AI 用コピー</button></h3>
    <div class="bp-body">
      <div style="margin-bottom:6px">${universeLinks}</div>
      ${controlChip}
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px;background:#f6f8fc;border-radius:8px">
        <span style="font-size:13px">選択中: <strong id="probe-current">未選択</strong></span>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer">
          <input type="checkbox" id="probe-preview-check" checked> 発注前検証も実行 <span class="muted" style="font-size:11px">(発注なし)</span>
        </label>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer" title="SDK の per-symbol 取引照会 (/trade/instrument・/trade/security) が tradePolicy を返すか検証。発注なし read-only (#460)">
          <input type="checkbox" id="probe-tradecheck"> 取扱判定 (trade/instrument) <span class="muted" style="font-size:11px">#460</span>
        </label>
        <button type="button" id="probe-submit" style="padding:7px 22px;background:#06c;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">診断を実行</button>
      </div>
    </div>
  </div>

  <div class="bp-grid">
    <div class="bp-card">
      <h3>Webull 取扱 <span id="bp-instrument-pill" class="bp-pill bp-pill-wait">未実行</span></h3>
      <div class="bp-body" id="bp-instrument-body" class="muted">—</div>
    </div>
    <div class="bp-card">
      <h3>Yahoo quote <span id="bp-yahoo-pill" class="bp-pill bp-pill-wait">未実行</span></h3>
      <div class="bp-body" id="bp-yahoo-body" class="muted">—</div>
      <details><summary class="muted" style="font-size:11px;cursor:pointer">raw</summary><pre id="probe-quote-yahoo" class="bp-raw">(未実行)</pre></details>
    </div>
    <div class="bp-card">
      <h3>買付余力 <span id="bp-bp-pill" class="bp-pill bp-pill-wait">未実行</span></h3>
      <div class="bp-body" id="probe-buying-power" class="muted">—</div>
    </div>
  </div>

  <div class="bp-card">
    <h3>保有銘柄 <span class="muted" style="font-size:11px;font-weight:normal">(click で probe)</span></h3>
    <div class="bp-body" id="probe-positions-list" class="muted">未実行</div>
  </div>

  <details style="margin-top:12px">
    <summary class="muted" style="font-size:12px;cursor:pointer">詳細 (drift 比較 / raw レスポンス / meta)</summary>
    <div class="bp-card" style="margin-top:8px">
      <h3>drift 比較 (旧 path vs 新 path) <span class="muted" style="font-size:11px;font-weight:normal">#251</span></h3>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="border-bottom:1px solid #e3e3e8">
          <th style="text-align:left;padding:4px 8px">endpoint</th>
          <th style="text-align:left;padding:4px 8px">old</th>
          <th style="text-align:left;padding:4px 8px">new</th>
        </tr></thead>
        <tbody id="probe-drift-table">
          <tr><td colspan="3" class="muted" style="padding:8px;text-align:center">(未実行)</td></tr>
        </tbody>
      </table>
      <h3 style="margin-top:14px">Webull quote <span class="muted" style="font-size:11px;font-weight:normal">(data-api — 無応答が既知のため詳細に格下げ #461。稼働開始は疎通監視 #21 が通知)</span> <span id="bp-quote-pill" class="bp-pill bp-pill-wait">未実行</span></h3>
      <div id="bp-quote-body" style="font-size:12px;margin:4px 0">—</div>
      <pre id="probe-quote" class="bp-raw">(未実行)</pre>
      <h3 style="margin-top:14px">instrument 照会 raw (quotes host / trade host)</h3>
      <pre id="bp-instrument-raw" class="bp-raw">(未実行)</pre>
      <h3 style="margin-top:14px">positions / orderHistory raw (旧/新)</h3>
      <pre id="probe-positions-raw" class="bp-raw">(未実行)</pre>
      <pre id="probe-positions-new-raw" class="bp-raw">(未実行)</pre>
      <pre id="probe-order-old-raw" class="bp-raw">(未実行)</pre>
      <pre id="probe-order-new-raw" class="bp-raw">(未実行)</pre>
      <h3 style="margin-top:14px">取扱判定 probe <span class="muted" style="font-size:11px;font-weight:normal">(trade/instrument・trade/security tradePolicy — #460、チェック時のみ)</span></h3>
      <pre id="probe-tradecheck-raw" class="bp-raw">(未実行)</pre>
      <h3 style="margin-top:14px">meta</h3>
      <pre id="probe-meta" class="bp-raw">(未実行)</pre>
    </div>
  </details>

<script>
(function () {
  var statusEl = document.getElementById('probe-status');
  var positionsListEl = document.getElementById('probe-positions-list');
  var quoteEl = document.getElementById('probe-quote');
  var metaEl = document.getElementById('probe-meta');
  var rawEl = document.getElementById('probe-positions-raw');
  var currentEl = document.getElementById('probe-current');

  var US_ETF_KNOWN = { SOXL: 1, SOXS: 1, SPY: 1, QQQ: 1 };
  var JP_ETF_KNOWN = { '1570': 1 };
  function inferCategory(symbol) {
    if (/^\\d{4}$/.test(symbol)) {
      return JP_ETF_KNOWN[symbol] ? 'JP_ETF' : 'JP_STOCK';
    }
    return US_ETF_KNOWN[symbol.toUpperCase()] ? 'US_ETF' : 'US_STOCK';
  }

  function setPill(id, kind, text) {
    var el = document.getElementById(id);
    if (!el) return;
    el.className = 'bp-pill bp-pill-' + kind;
    el.textContent = text;
  }

  // Every dynamic value headed for innerHTML (URL-derived symbol, broker response fields,
  // error strings) must go through this first — an XSS guard, not just formatting.
  function escHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // Resets every display region, not just the pills: resetting pills alone would leave the
  // previous symbol's stale body/raw text visible after a probe start or a failed fetch.
  function resetProbeView(label) {
    setPill('bp-instrument-pill', 'wait', label);
    setPill('bp-quote-pill', 'wait', label);
    setPill('bp-yahoo-pill', 'wait', label);
    setPill('bp-bp-pill', 'wait', label);
    var ids = ['bp-instrument-body', 'bp-quote-body', 'bp-yahoo-body', 'probe-buying-power', 'probe-positions-list'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) el.innerHTML = '<span class="muted">...</span>';
    }
    var pres = ['probe-quote', 'probe-quote-yahoo', 'bp-instrument-raw', 'probe-positions-raw', 'probe-positions-new-raw', 'probe-order-old-raw', 'probe-order-new-raw', 'probe-tradecheck-raw', 'probe-meta'];
    for (var j = 0; j < pres.length; j++) {
      var pre = document.getElementById(pres[j]);
      if (pre) pre.textContent = '...';
    }
    var drift = document.getElementById('probe-drift-table');
    if (drift) drift.innerHTML = '<tr><td colspan="3" class="muted" style="padding:8px;text-align:center">...</td></tr>';
    lastProbeResult = null;
    if (copyAiBtn) copyAiBtn.hidden = true;
  }

  // Copies the full admin endpoint response (all raw sections + meta), not the UI's trimmed
  // summary — a screenshot round-trip crops sections and loses which probe it came from.
  var lastProbeResult = null;
  var copyAiBtn = document.getElementById('probe-copy-ai');
  if (copyAiBtn) copyAiBtn.addEventListener('click', function () {
    if (!lastProbeResult) return;
    var text = '# webull-trading broker-probe / ' + lastProbeResult.symbol +
      ' (' + lastProbeResult.category + ') / generated ' +
      (lastProbeResult.body && lastProbeResult.body.timestamp ? lastProbeResult.body.timestamp : 'n/a') +
      ' / admin status ' + lastProbeResult.status + '\\n' +
      JSON.stringify(lastProbeResult.body, null, 1);
    function done(ok) {
      copyAiBtn.textContent = ok ? '✅' : '✗';
      setTimeout(function () { copyAiBtn.textContent = '📋 AI 用コピー'; }, 1500);
    }
    function fallbackExecCommand() {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallbackExecCommand);
    } else {
      fallbackExecCommand();
    }
  });

  function humanizeError(section) {
    if (!section) return 'no data';
    if (section.error && /aborted/i.test(section.error)) return '応答なし (10秒 timeout)';
    if (section.error) return section.error;
    if (section.status != null) return 'status=' + section.status;
    return section.phase;
  }

  function parseBody(section) {
    if (!section || typeof section.bodyTruncated !== 'string' || section.bodyTruncated.length === 0) return null;
    try { return JSON.parse(section.bodyTruncated); } catch (_) { return null; }
  }

  function prettify(section) {
    if (!section) return '(no data)';
    var raw = section.bodyTruncated;
    var parsed = parseBody(section);
    var header = '[' + section.phase + '] status=' + section.status + ' ok=' + section.ok +
      ' msTaken=' + section.msTaken + 'ms bodyLength=' + section.bodyLength;
    if (section.error) header += ' error=' + section.error;
    var bodyText = parsed != null ? JSON.stringify(parsed, null, 2) : (raw || '(empty)');
    return header + '\\n\\n' + bodyText;
  }

  function formatNumber(s) {
    var n = Number(s);
    if (!Number.isFinite(n)) return String(s);
    return n.toLocaleString('ja-JP', { maximumFractionDigits: 2 });
  }

  function renderInstrumentCard(body, symbol) {
    var bodyEl = document.getElementById('bp-instrument-body');
    var rawTarget = document.getElementById('bp-instrument-raw');
    // Which host actually serves this endpoint is unconfirmed, so both trade and quotes hosts
    // are tried; both ETF/STOCK categories are tried too as a guard against a category
    // mis-inference. The last two candidates are the generic SDK path, kept for drift checking.
    var candidates = [
      { label: 'stock/list (trade host, v2)', section: body.instrumentStockTradeV2 },
      { label: 'stock/list (trade host)', section: body.instrumentStockTrade },
      { label: 'stock/list (trade host, alt category)', section: body.instrumentStockTradeAlt },
      { label: 'stock/list (quotes host)', section: body.instrumentStockQuotes },
      { label: 'stock/list (quotes host, alt category)', section: body.instrumentStockQuotesAlt },
      { label: 'instrument/list (quotes host, 汎用 path)', section: body.instrumentQuotesHost },
      { label: 'instrument/list (trade host, 汎用 path)', section: body.instrumentTradeHost },
    ];
    var rawList = candidates;
    if (Array.isArray(body.previewVariants)) {
      rawList = body.previewVariants.map(function (v) {
        return { label: 'preview (' + v.label + ')', section: v.result };
      }).concat(candidates);
    }
    if (rawTarget) {
      rawTarget.textContent = rawList.map(function (cnd) {
        return '--- ' + cnd.label + ' ---\\n' + prettify(cnd.section);
      }).join('\\n\\n');
    }
    if (!bodyEl) return;

    // Candidates are tried in order (trade host v2 first — confirmed working); the first
    // candidate with a matching symbol row wins.
    var instMatch = null;
    for (var ci = 0; ci < candidates.length && !instMatch; ci++) {
      var csec = candidates[ci].section;
      if (!csec || csec.phase !== 'response' || csec.status !== 200) continue;
      var cparsed = parseBody(csec);
      var citems = Array.isArray(cparsed) ? cparsed : (cparsed && Array.isArray(cparsed.data) ? cparsed.data : []);
      for (var cj = 0; cj < citems.length; cj++) {
        if (citems[cj] && typeof citems[cj].symbol === 'string' && citems[cj].symbol.toUpperCase() === symbol.toUpperCase()) {
          instMatch = citems[cj];
          break;
        }
      }
    }
    // 公式 MCP の enum: OC=Tradable / CO=Liquidate only / NT=Non-Tradable
    var STATUS_JA = { OC: '取引可', CO: '清算のみ', NT: '取引不可' };
    function instSummaryHtml(it) {
      if (!it) return '';
      var chips = [];
      if (it.status) chips.push('status: ' + escHtml(it.status) + (STATUS_JA[it.status] ? ' (' + STATUS_JA[it.status] + ')' : ''));
      if (it.overnight_trading_supported === true) chips.push('24h取引対応');
      if (it.shortable === true) chips.push('空売り可');
      var lev = Number(it.etf_leveraged_factor);
      if (Number.isFinite(lev) && lev !== 0) chips.push('レバレッジ ' + (lev > 0 ? '+' : '') + lev + 'x' + (it.inverse_etf === true ? ' / インバース' : ''));
      if (it.exchange_code) chips.push('exchange: ' + escHtml(it.exchange_code));
      return '<div class="muted" style="font-size:12px;margin-top:3px">' + chips.join(' ・ ') + '</div>';
    }

    // CO/NT status is NG regardless of the preview outcome — mirrors the server-side
    // checkTradability judgment so this UI never contradicts what actual order placement decides.
    if (instMatch && (instMatch.status === 'CO' || instMatch.status === 'NT')) {
      setPill('bp-instrument-pill', 'ng', STATUS_JA[instMatch.status]);
      bodyEl.innerHTML = '<strong>' + escHtml(symbol.toUpperCase()) + '</strong> の instrument status は <code>' + escHtml(instMatch.status) + '</code> (' + STATUS_JA[instMatch.status] + ') — 新規エントリー不可。' + instSummaryHtml(instMatch);
      return;
    }

    // Preview Order takes priority over the instrument query: it exercises the actual order
    // pipeline, so it's more authoritative. Several body shapes are tried since any one
    // succeeding means tradable, and any one returning TICKER_IS_DENY is a confirmed deny.
    if (Array.isArray(body.previewVariants) && body.previewVariants.length > 0) {
      var okVariant = null;
      var denyVariant = null;
      for (var pvi = 0; pvi < body.previewVariants.length; pvi++) {
        var v = body.previewVariants[pvi];
        if (v.result && v.result.phase === 'response' && v.result.status === 200) { okVariant = v; break; }
        if (v.result && v.result.phase === 'response' && typeof v.result.bodyTruncated === 'string' &&
            v.result.bodyTruncated.indexOf('TICKER_IS_DENY') !== -1) { denyVariant = v; }
      }
      // Every responding variant returning "invalid symbol" PARAM_ERR means the symbol isn't
      // in Webull's master list at all, not merely undeliverable.
      var respondingAll = body.previewVariants.filter(function (v) { return v.result && v.result.status !== null; });
      var allInvalidSymbol = respondingAll.length > 0 && respondingAll.every(function (v) {
        var b = parseBody(v.result);
        return b && typeof b.error_code === 'string' && b.error_code.indexOf('PARAM_ERR') !== -1 &&
          typeof b.message === 'string' && /invalid[^"]*symbol/i.test(b.message);
      });
      if (allInvalidSymbol) {
        setPill('bp-instrument-pill', 'ng', '銘柄不正');
        bodyEl.innerHTML = '<strong>' + escHtml(symbol.toUpperCase()) + '</strong> は Webull の銘柄マスタに存在しません (symbol / market の組合せ不正)。';
        return;
      }
      if (okVariant) {
        // A 200 preview only means the quote succeeded, not that a real order will go
        // through — a symbol has stayed status=OC yet still been denied at actual order
        // placement, so this never claims "取引可能" from a preview success alone.
        setPill('bp-instrument-pill', 'unknown', instMatch && instMatch.status === 'OC' ? 'OC + 見積もり可' : '見積もり可');
        var okParsed = parseBody(okVariant.result);
        var cost = okParsed && (okParsed.estimated_cost || (okParsed.data && okParsed.data.estimated_cost));
        bodyEl.innerHTML = '<strong>' + escHtml(symbol.toUpperCase()) + '</strong> は銘柄として存在し見積もり可' + (cost ? ' (estimated_cost: ' + escHtml(cost) + ')' : '') + '。' +
          '<span class="muted">JP の取扱 deny は発注時のみ検出 — 最終確認は Webull アプリで。</span>' +
          instSummaryHtml(instMatch);
        return;
      }
      if (denyVariant) {
        setPill('bp-instrument-pill', 'ng', '取扱なし (確定)');
        bodyEl.innerHTML = '<strong>' + escHtml(symbol.toUpperCase()) + '</strong> — 発注前検証が <code>TICKER_IS_DENY</code> を返しました。' +
          '<span style="color:#c22">Webull JP の OpenAPI では発注できない銘柄です (確定)。</span>' +
          instSummaryHtml(instMatch);
        return;
      }
      setPill('bp-instrument-pill', 'unknown', '検証エラー');
      var lines = body.previewVariants.map(function (v) {
        var b = parseBody(v.result);
        var detail = b && b.error_code ? b.error_code + (b.message ? ' — ' + b.message : '') : humanizeError(v.result);
        return '<li><code>' + escHtml(v.label) + '</code>: ' + escHtml(detail) + '</li>';
      }).join('');
      bodyEl.innerHTML = '発注前検証がどの body shape でも通りませんでした:' +
        '<ul style="margin:4px 0 0 16px;padding:0;font-size:12px">' + lines + '</ul>' +
        '<span class="muted" style="font-size:11px">エラー内容から shape を調整します — raw を共有してください。</span>';
      return;
    }
    var responded = [];
    for (var i = 0; i < candidates.length; i++) {
      var sct = candidates[i].section;
      if (sct && sct.phase === 'response' && sct.status === 200) {
        var parsed = parseBody(sct);
        if (parsed != null) responded.push({ label: candidates[i].label, data: parsed });
      }
    }
    if (responded.length === 0) {
      var statuses = [candidates[0], candidates[2]].map(function (cnd) {
        return escHtml(cnd.label) + ': ' + escHtml(humanizeError(cnd.section));
      }).join(' ／ ');
      setPill('bp-instrument-pill', 'unknown', '判定不可');
      bodyEl.innerHTML = 'instrument/stock/list が 200 を返しませんでした (' + statuses + ')。' +
        '<span class="muted">判定不可のときの発注可否は実発注の結果 (#460 の自動停止ガード) で確定します。</span>';
      return;
    }
    // A match in any responding candidate counts, regardless of which category it queried.
    var match = null;
    var matchLabel = '';
    for (var k = 0; k < responded.length; k++) {
      var items = Array.isArray(responded[k].data)
        ? responded[k].data
        : (Array.isArray(responded[k].data.data) ? responded[k].data.data : []);
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        if (it && typeof it.symbol === 'string' && it.symbol.toUpperCase() === symbol.toUpperCase()) {
          match = it;
          matchLabel = responded[k].label;
          break;
        }
      }
      if (match) break;
    }
    if (match) {
      setPill('bp-instrument-pill', 'ok', '銘柄情報あり');
      var fields = [];
      if (match.instrument_id) fields.push('instrument_id: <code>' + escHtml(match.instrument_id) + '</code>');
      if (match.instrument_type) fields.push('type: <code>' + escHtml(match.instrument_type) + '</code>');
      if (match.exchange_code) fields.push('exchange: <code>' + escHtml(match.exchange_code) + '</code>');
      if (match.currency) fields.push('currency: <code>' + escHtml(match.currency) + '</code>');
      bodyEl.innerHTML = '<strong>' + escHtml(symbol.toUpperCase()) + '</strong> は Webull に銘柄として登録されています (via ' + escHtml(matchLabel) + ')。<br>' +
        '<span class="muted" style="font-size:12px">' + (fields.join(' ・ ') || '(詳細フィールドなし)') + '</span>' +
        instSummaryHtml(match);
    } else {
      setPill('bp-instrument-pill', 'ng', '銘柄情報なし');
      bodyEl.innerHTML = '<strong>' + escHtml(symbol.toUpperCase()) + '</strong> は instrument 照会 (ETF/STOCK 両 category) に出てきません。' +
        '<span style="color:#c22">Webull JP の取扱対象外の可能性が高く、発注しても TICKER_IS_DENY で拒否される見込みです。</span>';
    }
  }

  function extractPrice(section, priceKeys) {
    if (!section) return null;
    var parsed = parseBody(section);
    var item = Array.isArray(parsed) ? parsed[0] : parsed;
    if (item && item.chart && Array.isArray(item.chart.result) && item.chart.result[0] && item.chart.result[0].meta) {
      item = item.chart.result[0].meta;
    }
    for (var i = 0; item && i < priceKeys.length; i++) {
      var v = item[priceKeys[i]];
      if (v != null && Number.isFinite(Number(v))) return Number(v);
    }
    if (typeof section.bodyTruncated === 'string') {
      for (var r = 0; r < priceKeys.length; r++) {
        var m = section.bodyTruncated.match(new RegExp('"' + priceKeys[r] + '"\\s*:\\s*(-?[0-9.]+)'));
        if (m && Number.isFinite(Number(m[1]))) return Number(m[1]);
      }
    }
    return null;
  }

  // Discarded once the symbol changes: previewing with a stale symbol's price would surface a
  // price-related error that masks the actual deny/allow result.
  var lastYahoo = { symbol: null, price: null };

  function renderQuoteCard(pillId, bodyId, section, priceKeys) {
    var ok = section && section.phase === 'response' && section.status === 200;
    setPill(pillId, ok ? 'ok' : (section ? 'ng' : 'unknown'), ok ? '200 OK' : (section ? (section.status != null ? 'status ' + section.status : 'timeout') : 'no data'));
    var bodyEl = document.getElementById(bodyId);
    if (!bodyEl) return;
    if (!ok) {
      bodyEl.innerHTML = '<span class="muted">' + escHtml(humanizeError(section)) + '</span>';
      return;
    }
    var price = extractPrice(section, priceKeys);
    var ms = Number(section.msTaken) || 0;
    bodyEl.innerHTML = price != null
      ? '<span style="font-size:18px;font-weight:700" class="bp-num">' + escHtml(formatNumber(price)) + '</span> <span class="muted" style="font-size:11px">(' + ms + 'ms)</span>'
      : '<span class="muted">200 OK (' + ms + 'ms) — 価格フィールドは raw を確認</span>';
  }

  function renderPositionsList(section) {
    if (!section || section.phase !== 'response' || !section.ok) {
      positionsListEl.innerHTML = '<span class="muted" style="font-size:12px">positions: ' +
        escHtml(humanizeError(section)) + '</span>';
      rawEl.textContent = section ? prettify(section) : '(no data)';
      return;
    }
    rawEl.textContent = prettify(section);
    var items = parseBody(section);
    if (!Array.isArray(items) || items.length === 0) {
      positionsListEl.innerHTML = '<span class="muted" style="font-size:12px">保有銘柄なし</span>';
      return;
    }
    var html = items.map(function (item) {
      // Broker-response values are escaped for both the data-* attribute and the innerHTML text.
      var sym = escHtml(item.symbol || '');
      var name = escHtml(item.symbol_name || '');
      var qty = escHtml(formatNumber(item.quantity));
      var cur = escHtml(item.currency || '');
      var mv = escHtml(formatNumber(item.market_value));
      var cost = escHtml(formatNumber(item.cost_price));
      var cat = escHtml(inferCategory(item.symbol || ''));
      return '<button type="button" class="bp-chip probe-pickbtn" data-symbol="' + sym + '" data-category="' + cat +
        '" style="display:block;width:100%;text-align:left;margin:0 0 4px">' +
        '<strong>' + sym + '</strong> ' + (name ? '— ' + name + ' ' : '') +
        '<span class="muted">qty=' + qty + ' cost=' + cost + ' mv=' + cur + ' ' + mv + ' (' + cat + ')</span>' +
        '</button>';
    }).join('');
    positionsListEl.innerHTML = html;
    positionsListEl.querySelectorAll('.probe-pickbtn').forEach(function (btn) {
      btn.addEventListener('click', onPickClick);
    });
  }

  function renderBuyingPower(body) {
    var el = document.getElementById('probe-buying-power');
    if (!el) return;
    var candidates = [
      { label: '/openapi/account/balance (v1)', section: body.balanceAccountV1 },
      { label: '/openapi/assets/balance (v2)', section: body.balanceAssetsV2 },
    ];
    var hit = null;
    for (var i = 0; i < candidates.length; i++) {
      var sct = candidates[i].section;
      if (sct && sct.phase === 'response' && sct.status === 200) {
        var parsed = parseBody(sct);
        if (parsed) { hit = { label: candidates[i].label, body: parsed }; break; }
      }
    }
    if (!hit) {
      setPill('bp-bp-pill', 'ng', 'unavailable');
      el.innerHTML = '<span class="muted">balance endpoint がどれも 200 を返しませんでした。</span>';
      return;
    }
    setPill('bp-bp-pill', 'ok', '取得 OK');
    var b = hit.body;
    var assets = Array.isArray(b.account_currency_assets) ? b.account_currency_assets : [];
    var rows = assets.map(function (a) {
      return '<tr><td style="padding:2px 10px 2px 0"><code>' + escHtml(a.currency || '?') + '</code></td>' +
        '<td style="padding:2px 10px;text-align:right" class="bp-num">' + escHtml(formatNumber(a.buying_power)) + '</td>' +
        '<td style="padding:2px 10px;text-align:right" class="muted bp-num">cash ' + escHtml(formatNumber(a.cash_balance)) + '</td></tr>';
    }).join('');
    el.innerHTML =
      '<table style="font-size:12px;border-collapse:collapse"><tbody>' +
      (rows || '<tr><td class="muted">(通貨別資産なし)</td></tr>') + '</tbody></table>' +
      '<div class="muted" style="font-size:11px;margin-top:4px">via ' + escHtml(hit.label) + ' / 基準通貨 ' + escHtml(b.total_asset_currency || '?') + '</div>';
  }

  function renderDriftTable(body) {
    var tableBody = document.getElementById('probe-drift-table');
    if (!tableBody) return;
    function cell(section) {
      if (!section) return '<td class="muted" style="padding:4px 8px">(no data)</td>';
      var status = section.status == null ? section.phase : 'status=' + section.status;
      var ok = section.ok ? '✅' : (section.ok === false ? '❌' : '');
      var ms = section.msTaken == null ? '' : ' (' + (Number(section.msTaken) || 0) + 'ms)';
      var color = section.ok ? '#0a8a0a' : (section.ok === false ? '#c22' : '#666');
      return '<td style="padding:4px 8px;color:' + color + '">' + ok + ' ' + escHtml(status) + ms + '</td>';
    }
    function row(label, oldSection, newSection) {
      return '<tr><td style="padding:4px 8px"><code>' + label + '</code></td>' +
        cell(oldSection) + cell(newSection) + '</tr>';
    }
    tableBody.innerHTML =
      row('positions', body.positions, body.positionsNew) +
      row('order history', body.orderHistoryOld, body.orderHistoryNew) +
      row('account balance', body.balanceAccountV1, body.balanceAssetsV2) +
      row('instrument (quotes/trade host)', body.instrumentQuotesHost, body.instrumentTradeHost);
  }

  function probe(symbol, category, opts) {
    opts = opts || {};
    statusEl.textContent = (opts.preview ? '診断 + 発注前検証 実行中: ' : '診断 実行中: ') + symbol + ' (' + category + ')';
    currentEl.textContent = '— ' + symbol + ' / ' + category;
    resetProbeView('実行中');
    var url = '/admin/broker/probe?symbol=' + encodeURIComponent(symbol) +
      '&category=' + encodeURIComponent(category);
    if (opts.preview) {
      url += '&preview=1';
      if (Number.isFinite(opts.price) && opts.price > 0) url += '&price=' + encodeURIComponent(opts.price);
    }
    if (opts.tradecheck) url += '&tradecheck=1';
    try {
      var u = new URL(window.location.href);
      u.searchParams.set('symbol', symbol);
      u.searchParams.set('category', category);
      window.history.replaceState({}, '', u.toString());
    } catch (_) {}
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        var body = res.body;
        statusEl.textContent = res.status === 200 ? '完了' : ('admin endpoint status=' + res.status);
        quoteEl.textContent = '--- snapshot (trade host, v2) ---\\n' + prettify(body.snapshotTradeV2) + '\\n\\n--- snapshot (quotes host) ---\\n' + (body.quote ? prettify(body.quote) : '(no data)');
        var webullQuote = (body.snapshotTradeV2 && body.snapshotTradeV2.status === 200) ? body.snapshotTradeV2 : (body.quote || null);
        renderQuoteCard('bp-quote-pill', 'bp-quote-body', webullQuote, ['last_price', 'price', 'close', 'last']);
        var quoteYahooEl = document.getElementById('probe-quote-yahoo');
        if (quoteYahooEl) quoteYahooEl.textContent = body.quoteYahoo ? prettify(body.quoteYahoo) : '(no data)';
        renderQuoteCard('bp-yahoo-pill', 'bp-yahoo-body', body.quoteYahoo || null, ['regularMarketPrice', 'price', 'close']);
        lastYahoo = { symbol: symbol, price: extractPrice(body.quoteYahoo || null, ['regularMarketPrice', 'price', 'close']) };
        renderInstrumentCard(body, symbol);
        renderPositionsList(body.positions || null);
        var positionsNewRaw = document.getElementById('probe-positions-new-raw');
        var orderOldRaw = document.getElementById('probe-order-old-raw');
        var orderNewRaw = document.getElementById('probe-order-new-raw');
        if (positionsNewRaw) positionsNewRaw.textContent = prettify(body.positionsNew);
        if (orderOldRaw) orderOldRaw.textContent = prettify(body.orderHistoryOld);
        if (orderNewRaw) orderNewRaw.textContent = prettify(body.orderHistoryNew);
        renderBuyingPower(body);
        renderDriftTable(body);
        var tcEl = document.getElementById('probe-tradecheck-raw');
        if (tcEl) {
          if (body.tradeInstrumentProbe) {
            var tc = body.tradeInstrumentProbe;
            var tcLines = ['instrument_id=' + (tc.instrumentId || '(取得失敗)'), ''];
            (tc.variants || []).forEach(function (vv) {
              var r = vv.result || {};
              tcLines.push('● ' + vv.label + ' -> status=' + r.status + ' ok=' + r.ok);
              if (r.bodyTruncated) tcLines.push('  ' + String(r.bodyTruncated).slice(0, 600));
              if (r.error) tcLines.push('  error=' + r.error);
            });
            tcEl.textContent = tcLines.join('\\n');
          } else {
            tcEl.textContent = '(未実行 — 「取扱判定」チェックで実行)';
          }
        }
        metaEl.textContent = JSON.stringify({
          timestamp: body.timestamp,
          sandbox: body.sandbox,
          input: body.input,
          accessToken: body.accessToken,
          appKey: body.appKey,
          readiness: body.readiness,
          adminStatus: res.status,
        }, null, 2);
        lastProbeResult = { symbol: symbol, category: category, status: res.status, body: body };
        if (copyAiBtn) copyAiBtn.hidden = false;
      })
      .catch(function (e) {
        statusEl.textContent = 'fetch error: ' + (e && e.message ? e.message : String(e));
        resetProbeView('失敗');
      })
  }

  // Chip click only selects — it doesn't fetch. A probe (and, if checked, the preview-order
  // check) only starts when 診断を実行 is clicked, so browsing symbols never triggers network calls.
  var selected = { symbol: null, category: null };

  function setSelection(sym, cat) {
    selected.symbol = sym;
    selected.category = cat;
    if (currentEl) currentEl.textContent = sym + ' (' + cat + ')';
    document.querySelectorAll('.probe-pickbtn').forEach(function (b) {
      b.classList.toggle('bp-chip-selected', b.getAttribute('data-symbol') === sym);
    });
    try {
      var u = new URL(window.location.href);
      u.searchParams.set('symbol', sym);
      u.searchParams.set('category', cat);
      window.history.replaceState({}, '', u.toString());
    } catch (_) {}
  }

  function onPickClick(ev) {
    var btn = ev.currentTarget;
    var sym = btn.getAttribute('data-symbol');
    var cat = btn.getAttribute('data-category');
    if (sym && cat) setSelection(sym, cat);
  }

  document.querySelectorAll('.probe-pickbtn').forEach(function (btn) {
    btn.addEventListener('click', onPickClick);
  });

  var submitBtn = document.getElementById('probe-submit');
  var previewCheck = document.getElementById('probe-preview-check');
  var tradecheckCheck = document.getElementById('probe-tradecheck');
  if (submitBtn) {
    submitBtn.addEventListener('click', function () {
      if (!selected.symbol) {
        statusEl.textContent = '銘柄を選択してください';
        return;
      }
      submitBtn.disabled = true;
      var withPreview = !!(previewCheck && previewCheck.checked);
      var withTradecheck = !!(tradecheckCheck && tradecheckCheck.checked);
      var previewPrice = lastYahoo.symbol === selected.symbol ? lastYahoo.price : null;
      var opts = {};
      if (withPreview) { opts.preview = true; opts.price = previewPrice; }
      if (withTradecheck) opts.tradecheck = true;
      probe(selected.symbol, selected.category, opts).finally(function () {
        submitBtn.disabled = false;
      });
    });
  }

  // URL params only pre-select, same select-then-run rule as chip clicks — they never auto-run a probe.
  var qs = new URLSearchParams(window.location.search);
  if (qs.has('symbol') && qs.has('category')) {
    setSelection(qs.get('symbol'), qs.get('category'));
    statusEl.textContent = '「診断を実行」で開始';
  } else {
    statusEl.textContent = '銘柄を選択してください';
  }
})();
</script>`
}
