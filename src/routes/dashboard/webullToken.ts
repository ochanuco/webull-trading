import type { WebullTokenState } from '../../trading/state/WebullTokenStateDO'
import { esc } from './shared'

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
    // Reports only the count, never the candidate lines: echoing a token fragment back would
    // leak it into browser history / access logs via the redirect URL.
    return {
      ok: false,
      error: `expected 1 token line, found ${candidates.length}. remove non-token lines and retry`,
    }
  }
  return { ok: true, token: candidates[0]! }
}

// Never embeds the token plaintext, only tokenHint — see renderWebullTokenStateTable.
export function renderWebullTokenBody(args: {
  state: WebullTokenState | null
  notice: string | null
  error: string | null
}): string {
  const { state, notice, error } = args
  const banner = error
    ? `<p class="err">⚠ ${esc(error)}</p>`
    : notice
      ? `<p class="ok">✓ ${esc(notice)}</p>`
      : ''

  const stateSection = state
    ? renderWebullTokenStateTable(state)
    : '<p class="empty">token 未登録。下のフォームから登録する。</p>'

  // Multi-paragraph + a <pre> sample can't fit `.info-tip`'s plain-text
  // data-tip attribute, so this uses the `.info-tip-details` fallback.
  const pasteGuide = `<details class="info-tip-details">
    <summary aria-label="貼り付け内容の見本">?</summary>
    <div>
      <p><code>pnpm run issue-token</code> を実行し、status が NORMAL になるまで待つ。
      出力の<strong>最後の 1 行</strong>に長い英数字の token が表示される。<br>
      診断ログ (<code>[issue-token] ...</code> で始まる行) を含めて全文貼り付けてよい。
      token の行だけサーバー側で自動的に抜き出す。</p>
      <p>⚠ ログ内の <code>received: 0197e6...7689</code> のような <strong>"..." 入りの短い文字列は
      実 token ではなく表示用の省略形</strong>。2FA 認証を完了するまで実 token は
      表示されない。</p>
      <p>例 (NORMAL 化したときの末尾出力):</p>
      <pre style="background:var(--surface-2);padding:8px;border-radius:var(--radius-sm);overflow:auto;font-size:12px">[issue-token] poll (60s elapsed): xxxxxx...yyyy (status=NORMAL)
[issue-token] NORMAL token acquired. Inject via:
  pnpm wrangler secret put WEBULL_ACCESS_TOKEN --env=&lt;dev|staging|production&gt;
  (paste the value printed below)

&lt;long alphanumeric NORMAL token string&gt;   ← この行が実 token</pre>
    </div>
  </details>`

  return `<style>${FIELD_STYLE}</style>
  <div class="card">
    <div class="card-head"><h2 class="card-title">Webull token 管理</h2></div>
    <div class="card-body">
      <p class="muted" style="margin:0 0 10px">
        Webull の <code>x-access-token</code> を確認・登録・強制更新する。
        token は <code>pnpm run issue-token</code> で取得する (Webull アプリで 2FA 認証が必要)。
        取得した NORMAL token を下のフォームに貼り付けて登録する。
      </p>
      ${banner}
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2 class="card-title">現在の状態</h2></div>
    <div class="card-body">${stateSection}</div>
  </div>

  <div class="card">
    <div class="card-head">
      <h2 class="card-title">新規登録 (上書き可)</h2>
      ${pasteGuide}
    </div>
    <div class="card-body">
      <form method="post" action="/dashboard/webull-token/seed" style="display:flex;flex-direction:column;gap:10px;max-width:720px">
        <div class="field">
          <label for="token">issue-token の出力を貼り付け (丸ごとで OK)</label>
          <textarea id="token" name="token" rows="6" required
            placeholder="例:&#10;[issue-token] NORMAL token acquired. Inject via:&#10;  pnpm wrangler secret put WEBULL_ACCESS_TOKEN --env=production&#10;&#10;<long alphanumeric NORMAL token string>"
            style="font-family:var(--mono)"
          ></textarea>
        </div>
        <div><button type="submit" class="btn primary">登録する (token を抽出し再検証して保存)</button></div>
      </form>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2 class="card-title">手動更新</h2></div>
    <div class="card-body">
      <p class="muted" style="margin:0 0 10px">
        既存の token を使って Webull から強制的に再取得する。
        通常は日次の自動更新処理 (UTC 22:00) で実行されるため、このボタンは「期限間近を待たずに更新したい」「失敗を再現して確認したい」など特殊な場合のみ使う。
      </p>
      <form method="post" action="/dashboard/webull-token/refresh" onsubmit="return confirm('手動更新を実行します。よろしいですか?');">
        <button type="submit" class="btn">今すぐ更新</button>
      </form>
    </div>
  </div>`
}

// Shared with config.ts / events.ts / symbols.ts forms: `label` above
// `input`/`select`/`textarea` at the 13px body baseline, not `layout.ts`'s
// shared STYLE — these are the only 4 pages with data-entry forms, so a
// page-scoped block avoids growing the shared block for lane-local need.
export const FIELD_STYLE = `
  .field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
  .field label{font-size:12px;font-weight:600;color:var(--text-2)}
  .field input,.field select,.field textarea{padding:6px 8px;font-size:13px;min-height:32px;border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--text);font-family:inherit}
  .field textarea{min-height:auto}
  .field .hint{font-size:11px;color:var(--text-3)}
  .field-row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
  /* A single checkbox/radio row IS its own \`<label>\` (no nested label), so
     the row variant styles the label element directly rather than a child. */
  label.field-check{flex-direction:row;align-items:center;gap:6px;font-size:13px;font-weight:400;color:var(--text);margin-bottom:6px}
`

function renderWebullTokenStateTable(state: WebullTokenState): string {
  const statusClass = state.status === 'NORMAL' ? 'ok' : 'warn'
  // Webull's docs don't specify the unit; treat >= 10^12 as milliseconds, else seconds.
  const expiresMs = state.expires >= 1e12 ? state.expires : state.expires * 1000
  const expiresIso = Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : '(invalid)'
  const tokenHint = state.token.length > 10
    ? `${state.token.slice(0, 6)}...${state.token.slice(-4)}`
    : '<redacted>'
  return `
<table style="max-width:520px">
  <tr><th>状態</th>
      <td><span class="${statusClass}">${esc(state.status)}</span></td></tr>
  <tr><th>token (一部)</th>
      <td><code>${esc(tokenHint)}</code></td></tr>
  <tr><th>有効期限</th>
      <td>${esc(String(state.expires))} <span class="muted">(${esc(expiresIso)})</span></td></tr>
  <tr><th>取得日時</th>
      <td>${esc(state.fetchedAt)}</td></tr>
  <tr><th>最終試行日時</th>
      <td>${esc(state.lastAttemptAt ?? '(未実行)')}</td></tr>
  <tr><th>最終成功日時</th>
      <td>${esc(state.lastSuccessAt ?? '(未実行)')}</td></tr>
</table>`
}
