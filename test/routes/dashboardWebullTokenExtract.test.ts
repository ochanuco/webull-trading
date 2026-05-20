import { describe, expect, it } from 'vitest'
import { extractTokenFromPaste } from '../../src/routes/dashboard'

describe('extractTokenFromPaste (#21 Phase B follow-up)', () => {
  // happy path: operator が token 文字列だけ貼った
  // ダミー値 (`test_token_*`) を使う事で secret scanner ノイズを避ける (CodeRabbit #328)
  it('returns the token when only the token line is pasted', () => {
    const result = extractTokenFromPaste('test_token_normal_single_line')
    expect(result).toEqual({ ok: true, token: 'test_token_normal_single_line' })
  })

  // 出力丸ごと貼り付け: issue-token script の典型的な NORMAL 化時の出力
  it('strips [issue-token] diagnostic lines and wrangler instruction bullets', () => {
    const paste = `[issue-token] base URL: https://api.webull.co.jp
[issue-token] step 1/3: POST /openapi/auth/token/create
[issue-token] received: xxxxxx...yyyy (expires=1779286627791, status=PENDING)
[issue-token] step 2/3: open Webull mobile app and complete 2FA SMS verify (5 min).
[issue-token] step 3/3: polling /openapi/auth/token/check every 30s (timeout 300s)...
[issue-token] poll (30s elapsed): xxxxxx...yyyy (expires=..., status=PENDING)
[issue-token] poll (60s elapsed): xxxxxx...yyyy (expires=..., status=NORMAL)
[issue-token] NORMAL token acquired. Inject via:
  pnpm wrangler secret put WEBULL_ACCESS_TOKEN --env=<dev|staging|production>
  (paste the value printed below)

test_token_normal_full_output_paste`
    const result = extractTokenFromPaste(paste)
    expect(result).toEqual({
      ok: true,
      token: 'test_token_normal_full_output_paste',
    })
  })

  it('trims whitespace and CRLF line endings', () => {
    const paste = '  \r\n[issue-token] foo\r\n  test_token_with_crlf  \r\n  \r\n'
    const result = extractTokenFromPaste(paste)
    expect(result).toEqual({ ok: true, token: 'test_token_with_crlf' })
  })

  // negative: empty / whitespace-only
  it('errors when nothing meaningful is pasted', () => {
    const result = extractTokenFromPaste('  \n\n\n  ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not found/)
  })

  // negative: only diagnostic lines (operator copied output before NORMAL)
  it('errors when only diagnostic lines are present (operator Ctrl+C\'d before NORMAL)', () => {
    const paste = `[issue-token] base URL: ...
[issue-token] step 1/3: ...
[issue-token] received: xxx...yyy (status=PENDING)`
    const result = extractTokenFromPaste(paste)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/not found/)
      // operator が "..." 入りの summary を貼ってる事故への hint も入る
      expect(result.error).toMatch(/PENDING summary/)
    }
  })

  // negative: 2 つ以上の non-diagnostic 行 — 何が token か曖昧
  // 候補プレビューは URL に乗らない (CodeRabbit #328): 件数だけ返す。
  it('errors when multiple candidate lines remain (ambiguous)', () => {
    const paste = `[issue-token] foo
test_candidate_first
test_candidate_second`
    const result = extractTokenFromPaste(paste)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/expected 1 token line/)
      // raw candidate 文字列は error に含めない (URL 履歴に漏らさない)
      expect(result.error).not.toMatch(/test_candidate/)
      expect(result.error).toMatch(/remove non-token lines/)
    }
  })
})
