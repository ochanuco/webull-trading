import type { SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { displaySymbol, esc } from './shared'

/**
 * Broker probe UI body: form + 結果表示器。submit で `/admin/broker/probe` を
 * 同一 origin の fetch (credentials: 'same-origin') で呼び、JSON を pre 整形
 * 表示。auth は browser の既存 Cloudflare Access cookie が流用される (#29 で
 * basic auth から Access に移行済)。
 *
 * Server-side proxy を介さず client-side fetch にしてる理由:
 *   - dashboard handler が admin endpoint を sub-fetch するには Access JWT を
 *     request から request へ転送する必要があり、責務が混ざる
 *   - client-side fetch なら browser の Access cookie が自然に流れる、ロジック単純
 *   - probe payload に Cache-Control: no-store が付いてるので browser cache
 *     にも残らない
 */
/**
 * symbol → probe category 推定 (server-side)。client 側の inferCategory と同じ
 * ロジックを TS でも持つことで、universe を server-side render するときの
 * data-category 属性を正しく埋められる。
 *
 * - 4 桁数字 = JP_STOCK (`1570` だけ既知 ETF)
 * - US は `SOXL/SOXS/SPY/QQQ` を ETF 扱い、それ以外 STOCK
 */
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

/**
 * universe.allowedSymbols + inactiveSymbols を category 別にグルーピングして
 * クリック可能ボタン群を返す。inactive は薄色 + INACTIVE バッジで識別。
 * universe=null (DB 未設定 / load 失敗) は空文字 (UI から登録銘柄セクションは
 * 隠れず空のまま表示)。
 */
function renderUniverseLinks(universe: SymbolUniverse | null): string {
  if (!universe) {
    return '<span class="muted" style="font-size:12px">universe ロード失敗 (DB 未設定 / 接続失敗)</span>'
  }
  const inactiveSet = new Set(universe.inactiveSymbols.map((s) => s.toUpperCase()))
  const allSymbols = [...universe.allowedSymbols, ...universe.inactiveSymbols]
  if (allSymbols.length === 0) {
    return '<span class="muted" style="font-size:12px">登録銘柄なし</span>'
  }
  // category 別に分類して描画 (US_STOCK / US_ETF / JP_STOCK / JP_ETF の順)
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
  // #461 で刷新: raw JSON の縦積み → カード型のサマリ UI。
  //   - 上段: 銘柄選択 (登録銘柄 / 保有 / control) + status + 再 probe
  //   - 判定カード: Webull 取扱 (instrument 照会) / Webull quote / Yahoo quote / 買付余力
  //   - 下段 <details>: drift 比較・raw レスポンス・meta (情報は落とさず格納)
  // データ取得は従来どおり同一 origin の `/admin/broker/probe` を client fetch
  // (Cloudflare Access cookie 流用、payload は no-store)。
  // 自動 probe は URL に symbol+category がある時だけ (PR #250 の方針を維持)。
  const universeLinks = renderUniverseLinks(args.universe)
  // AAPL control chip は universe に AAPL が居る環境では重複するので出さない。
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

  // XSS 防御 (CodeRabbit #462): innerHTML へ流す動的値 (URL 由来 symbol /
  // broker 応答のフィールド / error 文字列) は必ずこれを通す。
  function escHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // probe 開始時 / fetch 失敗時に全表示領域をニュートラルへ戻す (stale 防止、
  // CodeRabbit #462: pill だけ戻すと失敗時に前回銘柄の結果が残る)。
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

  // probe 結果の AI 用コピー (#alerts-trades-ui と同運用): UI で省略・整形した
  // 情報ではなく admin endpoint のレスポンス全体 (全 raw セクション + meta) を
  // 文脈ヘッダ付きで積む。スクリーンショット往復だとセクションが切れて
  // どの probe の結果か特定できない問題への対策。
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

  // fetch abort (10s timeout) は raw の英語のまま出すと分かりにくいので日本語化。
  // data-api.webull.co.jp (JP market-data host) の無応答は既知 (#21、Yahoo 移行済み)。
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

  // #461: instrument 照会の判定カード。quotes / trade 両 host 候補のうち最初に
  // 200 + JSON parse 可能なものを採用する (#415 の balance 候補方式と同じ)。
  function renderInstrumentCard(body, symbol) {
    var bodyEl = document.getElementById('bp-instrument-body');
    var rawTarget = document.getElementById('bp-instrument-raw');
    // JP の正しい path は /openapi/instrument/stock/list (JP docs Trading API >
    // Get Stock Instrument、#461)。host 未確定のため trade / quotes 両方、かつ
    // category 推定の取り違え対策 (CodeRabbit #462) で ETF/STOCK 両 category を
    // 並べる。末尾 2 つは汎用 SDK path の drift 検証用 (#251 方式)。
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

    // instrument 照会 (#475): 候補の先頭 (trade host, v2 = 実測で稼働) を優先して
    // symbol 一致行を探し、status (OC/CO/NT) とフラグを全分岐で添える。
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

    // instrument status が CO/NT なら preview の結果に関わらず NG (#475 server 側
    // checkTradability と同じ判定)。
    if (instMatch && (instMatch.status === 'CO' || instMatch.status === 'NT')) {
      setPill('bp-instrument-pill', 'ng', STATUS_JA[instMatch.status]);
      bodyEl.innerHTML = '<strong>' + escHtml(symbol.toUpperCase()) + '</strong> の instrument status は <code>' + escHtml(instMatch.status) + '</code> (' + STATUS_JA[instMatch.status] + ') — 新規エントリー不可。' + instSummaryHtml(instMatch);
      return;
    }

    // 発注前検証 (Preview Order) の結果が最優先 — 発注パイプラインそのものの
    // 検証なので instrument 照会より確度が高い (#461)。body shape を複数試して
    // どれか 1 つでも通れば取引可能、どれかが TICKER_IS_DENY なら取扱なし確定。
    if (Array.isArray(body.previewVariants) && body.previewVariants.length > 0) {
      var okVariant = null;
      var denyVariant = null;
      for (var pvi = 0; pvi < body.previewVariants.length; pvi++) {
        var v = body.previewVariants[pvi];
        if (v.result && v.result.phase === 'response' && v.result.status === 200) { okVariant = v; break; }
        if (v.result && v.result.phase === 'response' && typeof v.result.bodyTruncated === 'string' &&
            v.result.bodyTruncated.indexOf('TICKER_IS_DENY') !== -1) { denyVariant = v; }
      }
      // 全 variant が「銘柄不正」PARAM_ERR → マスタに不存在 (ZZZZ 実測パターン)。
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
        // preview 200 = 見積もり成功。発注 allowlist は検証されない (USMV は
        // status=OC のまま本番 place が deny された前例) ため「取引可能」とは
        // 表示しない。
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
    // どれか 1 候補にでも symbol が出てくれば「銘柄情報あり」(category 非依存)。
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

  // 価格抽出: parse → (Yahoo chart は meta へ) → 失敗時は truncate 済み body から
  // regex fallback。quote カードと preview の limit cap の両方で使う。
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

  // 直近 probe の Yahoo 価格 (preview の limit cap 用)。銘柄が変わったら使わない
  // — 前銘柄の価格で preview すると価格系エラーが deny 判定を潰す (CodeRabbit #466)。
  var lastYahoo = { symbol: null, price: null };

  // quote カード: status pill + 価格らしきフィールドの要約。shape が読めなくても
  // pill と raw は必ず更新する (stale 表示を残さない、CodeRabbit #262 の方針)。
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
      // broker 応答由来の値は attribute / innerHTML どちらも必ず escape (#462)。
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
        // trade host + v2 の snapshot (JP docs の production host) が 200 なら優先表示。
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
        // 失敗時も前回 probe の結果を残さない (stale 防止 #462)。
        resetProbeView('失敗');
      })
  }

  // 選択 → 実行の 2 段階フロー (操作要望): chip クリックは**選択のみ** (通信
  // しない)。「診断を実行」で初めて probe + (checkbox ON なら) 発注前検証を走らせる。
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

  // URL params は**プリ選択のみ** (自動実行しない — 選択 → 実行の流れを徹底)。
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
