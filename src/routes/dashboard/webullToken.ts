import { and, lt, or } from 'drizzle-orm'
import type { WebullTokenState } from '../../trading/state/WebullTokenStateDO'
import { esc } from './shared'

/**
 * `pnpm run issue-token` の出力から実 token (NORMAL の stdout 行) を抽出する。
 *
 * operator が terminal の出力丸ごと貼ったケースに耐性をつけるため:
 *   - `[issue-token] ...` 始まりの diagnostic は捨てる
 *   - wrangler instruction (`pnpm wrangler ...`, `(paste the value...)`) は捨てる
 *   - 空行 / whitespace-only は捨てる
 *   - 残った 1 行 = NORMAL token
 *
 * 複数行残った場合は何が token か判別不能として error。operator は不要行を
 * 削って再 submit する。
 *
 * exported for testing。
 */
export function extractTokenFromPaste(raw: string):
  | { ok: true; token: string }
  | { ok: false; error: string } {
  const candidates = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('[issue-token]'))
    .filter((line) => !line.startsWith('pnpm '))
    .filter((line) => !line.startsWith('(paste'))
  if (candidates.length === 0) {
    return {
      ok: false,
      error:
        'token line not found — did the issue-token flow finish with status=NORMAL? (the PENDING summary like "0197...7689" is NOT the actual token)',
    }
  }
  if (candidates.length > 1) {
    // 候補プレビューを URL に含めると token 断片が browser 履歴 / access log に
    // 漏れる (CodeRabbit #328)。件数のみ返して、operator は form 側で
    // 不要行を削って再 submit する。
    return {
      ok: false,
      error: `expected 1 token line, found ${candidates.length}. remove non-token lines and retry`,
    }
  }
  return { ok: true, token: candidates[0]! }
}

/**
 * #21 Phase B follow-up: Webull token 管理 UI の HTML body。token plaintext は
 * 一切埋め込まない (tokenHint だけ)。notice / error は redirect 後の query string
 * 経由で受け取る (PRG パターン)。
 */
export function renderWebullTokenBody(args: {
  state: WebullTokenState | null
  notice: string | null
  error: string | null
}): string {
  const { state, notice, error } = args
  const banner = error
    ? `<p class="warn">⚠ ${esc(error)}</p>`
    : notice
      ? `<p class="ok">✓ ${esc(notice)}</p>`
      : ''

  const stateSection = state
    ? renderWebullTokenStateTable(state)
    : '<p>DO is empty — まだ seed されていません。下の form から投入してください。</p>'

  return `
<section style="max-width:760px">
  <p style="color:#666">
    Webull <code>x-access-token</code> の状態確認 / 投入 / 強制 refresh を行います。
    token 文字列は <code>pnpm run issue-token</code> で取得 (Webull モバイルアプリで 2FA verify 必要)。
    取得した NORMAL token を下の form に貼り付けて「seed」してください。
  </p>
  ${banner}
  <h2>現在の状態</h2>
  ${stateSection}

  <h2>新規 seed (or 上書き)</h2>
  <details style="margin-bottom:8px">
    <summary style="cursor:pointer;color:#555">📋 何を貼ればいい？</summary>
    <div style="padding:8px 0 0 16px;color:#555;font-size:13px;line-height:1.6">
      <p><code>pnpm run issue-token</code> を最後まで完了させる (status=NORMAL になる) と、
      stdout の <strong>最後の 1 行</strong> に長い英数字の token が出力されます。<br>
      diagnostic ログ (<code>[issue-token] ...</code> で始まる行) を含めて全文貼り付けても OK
      — server-side で token 行だけ自動抽出します。</p>
      <p>⚠ ログ内の <code>received: 0197e6...7689</code> のような <strong>"..." 入りの短い文字列は
      実 token ではなく表示用の省略形</strong> です。2FA verify を完了するまで実 token は
      出力されません。</p>
      <p>例 (NORMAL 化したときの末尾出力):</p>
      <pre style="background:#f6f8fa;padding:8px;border-radius:4px;overflow:auto;font-size:12px">[issue-token] poll (60s elapsed): xxxxxx...yyyy (status=NORMAL)
[issue-token] NORMAL token acquired. Inject via:
  pnpm wrangler secret put WEBULL_ACCESS_TOKEN --env=&lt;dev|staging|production&gt;
  (paste the value printed below)

&lt;long alphanumeric NORMAL token string&gt;   ← この行が実 token</pre>
    </div>
  </details>
  <form method="post" action="/dashboard/webull-token/seed" style="display:flex;flex-direction:column;gap:8px;max-width:720px">
    <label for="token" style="font-weight:bold">issue-token の出力を貼り付け (丸ごとで OK):</label>
    <textarea id="token" name="token" rows="6" required
      placeholder="例:&#10;[issue-token] NORMAL token acquired. Inject via:&#10;  pnpm wrangler secret put WEBULL_ACCESS_TOKEN --env=production&#10;&#10;<long alphanumeric NORMAL token string>"
      style="font-family:ui-monospace,monospace;padding:6px;border:1px solid #ccc;border-radius:4px"
    ></textarea>
    <button type="submit" style="padding:8px 16px;background:#28a;color:#fff;border:none;border-radius:4px;cursor:pointer;align-self:flex-start">
      seed (token 行を自動抽出 → broker で再 verify → DO 書込)
    </button>
  </form>

  <h2 style="margin-top:24px">手動 refresh</h2>
  <p style="color:#666">
    既存 token を Webull に渡して <code>createToken(existingToken)</code> を強制実行します。
    通常は daily cron (22:00 UTC) で自動的に走るため、ボタンは「期限間近を待たずに更新したい」「失敗事象を再現したい」など特殊用途のみ。
  </p>
  <form method="post" action="/dashboard/webull-token/refresh" onsubmit="return confirm('手動 refresh を実行します。よろしいですか?');">
    <button type="submit" style="padding:8px 16px;background:#888;color:#fff;border:none;border-radius:4px;cursor:pointer">
      refresh now
    </button>
  </form>
</section>`
}

export function renderWebullTokenStateTable(state: WebullTokenState): string {
  const statusClass = state.status === 'NORMAL' ? 'ok' : 'warn'
  // expires は ms / sec 両対応 (Webull docs 未明示)。10^12 以上を ms 扱い。
  const expiresMs = state.expires >= 1e12 ? state.expires : state.expires * 1000
  const expiresIso = Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : '(invalid)'
  const tokenHint = state.token.length > 10
    ? `${state.token.slice(0, 6)}...${state.token.slice(-4)}`
    : '<redacted>'
  return `
<table style="border-collapse:collapse;margin-bottom:16px">
  <tr><th style="text-align:left;padding:4px 12px 4px 0">status</th>
      <td><span class="${statusClass}">${esc(state.status)}</span></td></tr>
  <tr><th style="text-align:left;padding:4px 12px 4px 0">tokenHint</th>
      <td><code>${esc(tokenHint)}</code></td></tr>
  <tr><th style="text-align:left;padding:4px 12px 4px 0">expires</th>
      <td>${esc(String(state.expires))} <span class="muted">(${esc(expiresIso)})</span></td></tr>
  <tr><th style="text-align:left;padding:4px 12px 4px 0">fetchedAt</th>
      <td>${esc(state.fetchedAt)}</td></tr>
  <tr><th style="text-align:left;padding:4px 12px 4px 0">lastAttemptAt</th>
      <td>${esc(state.lastAttemptAt ?? '(never)')}</td></tr>
  <tr><th style="text-align:left;padding:4px 12px 4px 0">lastSuccessAt</th>
      <td>${esc(state.lastSuccessAt ?? '(never)')}</td></tr>
</table>`
}
