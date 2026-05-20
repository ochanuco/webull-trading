import { describe, expect, it } from 'vitest'
import { extractTokenFromPaste } from '../../src/routes/dashboard'

describe('extractTokenFromPaste (#21 Phase B follow-up)', () => {
  // happy path: operator が token 文字列だけ貼った
  it('returns the token when only the token line is pasted', () => {
    const result = extractTokenFromPaste('0197e6abcd1234567890fedcba9876543210')
    expect(result).toEqual({ ok: true, token: '0197e6abcd1234567890fedcba9876543210' })
  })

  // 出力丸ごと貼り付け: issue-token script の典型的な NORMAL 化時の出力
  it('strips [issue-token] diagnostic lines and wrangler instruction bullets', () => {
    const paste = `[issue-token] base URL: https://api.webull.co.jp
[issue-token] step 1/3: POST /openapi/auth/token/create
[issue-token] received: 0197e6...7689 (expires=1779286627791, status=PENDING)
[issue-token] step 2/3: open Webull mobile app and complete 2FA SMS verify (5 min).
[issue-token] step 3/3: polling /openapi/auth/token/check every 30s (timeout 300s)...
[issue-token] poll (30s elapsed): 0197e6...7689 (expires=..., status=PENDING)
[issue-token] poll (60s elapsed): 0197e6...7689 (expires=..., status=NORMAL)
[issue-token] NORMAL token acquired. Inject via:
  pnpm wrangler secret put WEBULL_ACCESS_TOKEN --env=<dev|staging|production>
  (paste the value printed below)

0197e6abcd1234567890fedcba9876543210ffaabbccddeeff7689`
    const result = extractTokenFromPaste(paste)
    expect(result).toEqual({
      ok: true,
      token: '0197e6abcd1234567890fedcba9876543210ffaabbccddeeff7689',
    })
  })

  it('trims whitespace and CRLF line endings', () => {
    const paste = '  \r\n[issue-token] foo\r\n  0197e6abcd1234567890fedcba9876543210  \r\n  \r\n'
    const result = extractTokenFromPaste(paste)
    expect(result).toEqual({ ok: true, token: '0197e6abcd1234567890fedcba9876543210' })
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
  it('errors when multiple candidate lines remain (ambiguous)', () => {
    const paste = `[issue-token] foo
abc123def456ghi
xyz789jkl012mno`
    const result = extractTokenFromPaste(paste)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/expected 1 token line/)
      expect(result.error).toMatch(/abc123def456ghi/)
    }
  })
})
