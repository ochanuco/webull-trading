import type { SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { escapeHtml, formatSymbolDisplay } from '../../shared/format'

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `SymbolUniverse` から 番号/ticker - 会社名 表示文字列を返す薄い helper。
 * universe が無い (load 失敗等) ケースは symbol そのまま (= 既存挙動)。
 *
 * `URL ?symbol=7974` の routing は変更しない。表示テキストだけが
 * `7974-任天堂` / `AAPL-Apple Inc.` 形式に切り替わる。
 */
export function displaySymbol(symbol: string, universe?: SymbolUniverse | null): string {
  if (!universe) return symbol
  const upper = symbol.toUpperCase()
  return formatSymbolDisplay({
    symbol,
    name: universe.symbolName[upper] ?? null,
  })
}

/**
 * symbol が universe.inactiveSymbols (= active=0) に含まれていれば true。
 * `inactiveSymbols` は active=0 全般 (disable / pause 含む) なので "inactive"
 * と中立的に呼ぶ。universe が null / 未配線の時は false (= 既存挙動を変えない)。
 */
export function isSymbolInactive(symbol: string, universe?: SymbolUniverse | null): boolean {
  if (!universe) return false
  const upper = symbol.toUpperCase()
  return universe.inactiveSymbols.includes(upper)
}

/**
 * inactive 銘柄の tooltip 用テキスト ("INACTIVE: <notes>" 形式)。notes が
 * 無ければ単に "INACTIVE"。HTML escape は呼び出し側の責任。
 *
 * `inactiveSymbols` は disable (恒久) と pause (一時停止) を区別しないため、
 * 中立的な "INACTIVE" を採用 (元の "DISABLED" は pause 銘柄を誤認させる)。
 */
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
    parts.push(`<a href="${opts.baseHref}" style="padding:6px 14px;border:1px solid #d8d8de;border-radius:6px;text-decoration:none;font-size:13px">← 最新へ</a>`)
    void sep
  }
  if (opts.hasMore && opts.lastId !== undefined) {
    const sep = opts.baseHref.includes('?') ? '&' : '?'
    parts.push(`<a href="${opts.baseHref}${sep}before=${opts.lastId}" style="padding:6px 14px;border:1px solid #d8d8de;border-radius:6px;text-decoration:none;font-size:13px">古い方 →</a>`)
  }
  if (parts.length === 0) return ''
  return `<nav style="margin-top:12px;display:flex;gap:8px;justify-content:center">${parts.join('')}</nav>`
}

/**
 * HTML entity escaper. Thin alias over shared `escapeHtml` (#284) — every
 * D1 / DO-derived string (symbol names, error messages, audit JSON, alerts
 * cause / message, …) passes through this before interpolation. Without it
 * an attacker who can write `notes` / `reason` / `before_json` could inject
 * a <script> that submits the kill-switch / seed-cash form on the
 * operator's session.
 */
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
 * dashboard JSON export の schema バージョニング規約 (#dashboard-json-api)。
 *
 * - schema 名は `dashboard_<page>_export.v<N>` 形式 (例: `dashboard_cron_export.v1`)。
 * - additive change (フィールド追加のみ) は同じ version のまま。
 * - 既存フィールドの型変更・意味変更・削除は破壊的変更なので v<N+1> に上げる。
 * - envelope は共通で `{ schema, exportedAt, filter?, rowCount?, ... }`:
 *   - `schema`     : 上記の versioned 識別子。AI / スクリプトが期待形を判別する鍵。
 *   - `exportedAt` : 生成時刻 (ISO UTC)。鮮度判断・キャッシュ判定用。
 *   - `filter`     : クエリ絞り込みを持つページのみ。「この JSON は何の部分集合か」を明示。
 *   - `rowCount`   : 主行配列を持つページのみ。truncation 検知用。
 * - secret になり得る値 (token / key / account_id) は絶対に載せない。
 *
 * packet builder (`buildXxxPacket`) はこの helper で envelope 共通部を作り、
 * ページ固有 field を続ける。「画面で見る内容 = AI に渡す JSON」を保つため、
 * packet は SSR と同じ loader の結果から pure に組み立てること。
 */
export function exportMeta(schema: string): { schema: string; exportedAt: string } {
  return { schema, exportedAt: new Date().toISOString() }
}

/**
 * 「JSON を開く」リンク + (任意で) AI 用全件コピーボタンを並べた小さな帯
 * (#dashboard-json-api)。SSR ページのヘッダ帯に置き、同じ内容の機械可読版へ
 * 1 クリックで到達できるようにする。
 *
 * `copyVarName` は `safeJsonScript` で埋めた copy payload のグローバル変数名。
 * non-null ならページ内に `renderLogCopyScript(copyVarName)` が既にいる前提で
 * `LOG_COPY_ALL_BTN` (id=log-copy-all) を並べる — 配線は script 側が id で拾う。
 * copy payload を持たないページは null (リンクのみ)。
 */
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

/**
 * ログ行の「AI 用コピー」ボタン (#alerts-trades-ui)。raw 全 field の JSON +
 * 文脈ヘッダ (ページ / フィルタ / 生成時刻) をクリップボードに積む — ログを
 * そのまま AI に貼って相談する運用のため、表示で省略した情報も全部含める。
 * `varName` は safeJsonScript で埋めた `{ meta, rows }` payload のグローバル名。
 */
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
      // permission 拒否などの reject 時も execCommand に落とす (CodeRabbit #469)。
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
      // 行コピーは payload.full (trace 等の重い field 含む完全版) を優先。
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

export const logCopyRowBtn = (id: number): string =>
  `<button type="button" class="log-copy-btn" data-id="${id}" title="この行の全データを AI 用にコピー" style="border:none;background:none;cursor:pointer;font-size:12px;padding:0 2px">📋</button>`

/**
 * cooldownUntil をポートフォリオテーブル向けに整形。null または past timestamp
 * (admin /clear-cooldown で epoch 0 が書き込まれた状態等) は「解除済」
 * 扱いで em-dash を返す。strategy 側の `cooldownUntil > now` 判定と表示を
 * 整合させ、"1970-01-01 09:00:00 JST" がクールダウン列に残るように見える
 * 不具合を解消する (#145 admin clear-cooldown の副作用)。
 */
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

/**
 * 銘柄コードから通貨を推定する。JP 上場 ETF は 4 桁数字コード (1357 等) なので
 * 数字始まりは JPY、それ以外 (アルファベット ticker) は USD とみなす。symbolCurrency
 * マップが手元に無い表示経路 (判定トレース等) 用の軽量フォールバック。
 */
export function currencyOfSymbol(symbol: string): 'JPY' | 'USD' {
  return /^\d/.test(symbol.trim()) ? 'JPY' : 'USD'
}
