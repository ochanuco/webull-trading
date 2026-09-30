import type { SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { escapeHtml, formatSymbolDisplay } from '../../shared/format'

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function displaySymbol(symbol: string, universe?: SymbolUniverse | null): string {
  if (!universe) return symbol
  const upper = symbol.toUpperCase()
  return formatSymbolDisplay({
    symbol,
    name: universe.symbolName[upper] ?? null,
  })
}

// Named "inactive" not "disabled": active=0 covers both permanent disable
// and temporary pause, and "disabled" would misdescribe the latter.
export function isSymbolInactive(symbol: string, universe?: SymbolUniverse | null): boolean {
  if (!universe) return false
  const upper = symbol.toUpperCase()
  return universe.inactiveSymbols.includes(upper)
}

// Caller must HTML-escape the result.
export function inactiveTooltip(symbol: string, universe?: SymbolUniverse | null): string {
  if (!universe) return ''
  const upper = symbol.toUpperCase()
  const note = universe.symbolNotes[upper]
  return note ? `INACTIVE: ${note}` : 'INACTIVE'
}

export function clampLimit(raw: string | undefined): number {
  const n = raw === undefined ? 50 : Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(n, 200)
}

export function parseCursor(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function renderPaginationNav(opts: {
  baseHref: string
  before: number | undefined
  lastId: number | undefined
  hasMore: boolean
}): string {
  const parts: string[] = []
  if (opts.before !== undefined) {
    const sep = opts.baseHref.includes('?') ? '&' : '?'
    parts.push(`<a href="${opts.baseHref}" class="btn">← 最新へ</a>`)
    void sep
  }
  if (opts.hasMore && opts.lastId !== undefined) {
    const sep = opts.baseHref.includes('?') ? '&' : '?'
    parts.push(`<a href="${opts.baseHref}${sep}before=${opts.lastId}" class="btn">古い方 →</a>`)
  }
  if (parts.length === 0) return ''
  return `<nav style="margin-top:12px;display:flex;gap:8px;justify-content:center">${parts.join('')}</nav>`
}

// Every D1/DO-derived string (notes, reason, before_json, ...) must pass
// through this before interpolation, or a stored value can inject a
// <script> that submits the kill-switch / seed-cash form as the operator.
export const esc = escapeHtml

export function fmtNumber(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-'
  return n.toLocaleString('ja-JP', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export const JST_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/**
 * Render an ISO/Date value in JST (YYYY-MM-DD HH:mm:ss JST). Returns the
 * raw string unchanged on parse failure so operators can still grep for the
 * original even if upstream emits a weird format.
 */
export function fmtJst(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return '-'
  const d = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(d.getTime())) return typeof value === 'string' ? value : '-'
  const parts = JST_FORMATTER.formatToParts(d)
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')} JST`
}

export const JST_COMPACT_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** `MM/DD HH:mm` in JST — for dense log tables where a full timestamp column doesn't fit. */
export function fmtJstCompact(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return '-'
  const d = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(d.getTime())) return typeof value === 'string' ? value : '-'
  const parts = JST_COMPACT_FORMATTER.formatToParts(d)
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${pick('month')}/${pick('day')} ${pick('hour')}:${pick('minute')}`
}

/**
 * `fmtJstCompact` wrapped in a `title`-carrying span with the full `fmtJst`
 * timestamp, ready to drop straight into a table cell.
 */
export function fmtJstCompactCell(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return '<span class="muted">—</span>'
  return `<span title="${esc(fmtJst(value))}">${esc(fmtJstCompact(value))}</span>`
}

export function unavailable(reason: string): string {
  return `<p class="warn">利用不可: ${esc(reason)}</p>`
}

export function jsonPretty(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Envelope for dashboard JSON exports: `schema` is `dashboard_<page>_export.vN`
 * (bump N only on a breaking field change, not an addition). Never put a
 * secret (token/key/account_id) in an exported packet.
 */
export function exportMeta(schema: string): { schema: string; exportedAt: string } {
  return { schema, exportedAt: new Date().toISOString() }
}

// `copyVarName` non-null assumes `renderLogCopyScript(copyVarName)` is
// already on the page — wiring to the copy-all button happens by DOM id,
// not by any value this function returns.
export function renderJsonToolbar(jsonHref: string, copyVarName: string | null): string {
  const copyBtn = copyVarName ? ` ${LOG_COPY_ALL_BTN}` : ''
  return `<div style="margin:0 0 10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap"><a href="${esc(jsonHref)}" target="_blank" rel="noreferrer" class="chip">JSON を開く</a>${copyBtn}</div>`
}

export function parseJsonObject(value: string | null | undefined): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

// `varName` must be a `safeJsonScript(varName, { meta, rows, full? })`
// payload already on the page — copies raw fields, including ones the
// display table omits, so the row can be pasted to an AI as-is.
export function renderLogCopyScript(varName: string): string {
  return `<script>
(function () {
  var payload = window.${varName};
  if (!payload) return;
  function copyText(text, btn) {
    function done(ok) {
      var prev = btn.textContent;
      btn.textContent = ok ? '✅' : '✗';
      setTimeout(function () { btn.textContent = prev; }, 1500);
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
      // Permission can be denied at call time, not just be absent.
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallbackExecCommand);
    } else {
      fallbackExecCommand();
    }
  }
  function header(count) {
    return '# webull-trading ' + payload.meta.page + ' / ' + payload.meta.filter +
      ' / generated ' + payload.meta.generatedAt + ' / ' + count + ' rows\\n';
  }
  document.querySelectorAll('.log-copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.getAttribute('data-id');
      // payload.full carries fields (e.g. trace) trimmed from the display rows.
      var src = payload.full || payload.rows;
      var row = null;
      for (var i = 0; i < src.length; i++) {
        if (String(src[i].id) === id) { row = src[i]; break; }
      }
      if (row) copyText(header(1) + JSON.stringify(row, null, 1), btn);
    });
  });
  var all = document.getElementById('log-copy-all');
  if (all) {
    all.addEventListener('click', function () {
      copyText(header(payload.rows.length) + JSON.stringify(payload.rows, null, 1), all);
    });
  }
})();
</script>`
}

export const LOG_COPY_ALL_BTN =
  '<button type="button" id="log-copy-all" class="chip">📋 表示中を AI 用にコピー</button>'

// Dimmed until the row is hovered — full-opacity on every row made every log
// table look like a wall of buttons before a reader had picked a row to act on.
export const LOG_COPY_BTN_STYLE = `.log-copy-btn{opacity:.5;transition:opacity .12s ease}
tr:hover .log-copy-btn{opacity:1}`

export const logCopyRowBtn = (id: number): string =>
  `<button type="button" class="log-copy-btn" data-id="${id}" title="この行の全データを AI 用にコピー" style="border:none;background:none;cursor:pointer;font-size:14px;padding:0 2px">📋</button>`

// Shared by the trades/cron tables' symbol cell: a plain-weight link (not
// full <strong> bold, not accent-colored at rest) that only shifts to accent
// on hover — a whole column of bold blue tickers otherwise reads as more
// "important" than the row data next to it. `.sym-name` truncates inside the
// fixed max-width via the parent's ellipsis instead of wrapping to a 2nd line.
export const SYMBOL_LINK_STYLE = `.sym-link{display:inline-block;max-width:220px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;vertical-align:bottom;color:var(--text);font-weight:600;text-decoration:none}
.sym-link:hover{color:var(--accent-text)}
.sym-link .sym-name{color:var(--text-3);font-weight:400}`

// A past (or epoch-0) cooldownUntil renders as cleared, matching the
// strategy's own `cooldownUntil > now` check rather than the raw timestamp.
export function formatCooldown(cooldownUntil: string | null): string {
  if (!cooldownUntil) return '<span class="muted">—</span>'
  const ms = new Date(cooldownUntil).getTime()
  if (!Number.isFinite(ms) || ms <= Date.now()) {
    return '<span class="muted">—</span>'
  }
  return `<span class="warn">${esc(fmtJst(cooldownUntil))}</span>`
}

/**
 * Numeric string ratio → 符号付き % 表記 (0.0108 → "+1.08%"、-0.04 → "-4.00%")。
 * fallback は原文字列 (数値 parse 失敗時は canonical な reason を見せる方が安全)。
 */
export function fmtPct(s: string): string {
  const n = Number(s)
  if (!Number.isFinite(n)) return s
  const pct = n * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(2)}%`
}

/**
 * `<script>...</script>` 内に埋め込む JSON を XSS 安全にする。
 * ブラウザは `</script>` を「文字列の中でも」script 終端と解釈するので、
 * `<` を unicode escape して中和する。
 */
export function safeJsonScript(varName: string, data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<script>window.${varName} = ${json};</script>`
}

/** % 表示 (符号付き)。0.123 → "+12.3%"。 */
export function fmtPctSigned(v: number): string {
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`
}

/** 通貨に応じた価格表示 (JPY は整数 + カンマ、他は小数 2 桁)。 */
export function fmtPriceCcy(v: number, currency: string | null): string {
  const mark = currency === 'JPY' ? '¥' : '$'
  const digits = currency === 'JPY' ? 0 : 2
  return `${mark}${v.toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

// Heuristic fallback for call sites without a symbolCurrency map: JP-listed
// ETFs use 4-digit numeric codes, so a leading digit means JPY.
export function currencyOfSymbol(symbol: string): 'JPY' | 'USD' {
  return /^\d/.test(symbol.trim()) ? 'JPY' : 'USD'
}
