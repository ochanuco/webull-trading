import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'

/**
 * Inline <script> の構文回帰テスト。dashboard の JS は TS テンプレートリテラル
 * 内に手書きされており、`\n` (TS で実改行に展開) と `\\n` (rendered JS の
 * escape) の取り違えで **ページ全体の click handler が無音で死ぬ** 事故が
 * 実際に起きた (#462 後の staging で broker-probe が全ボタン無反応)。
 * 抽出した script を `new Function` で parse して構文エラーを CI で検出する。
 */
const baseEnv = { ACCESS_DEV_BYPASS_USER: 'admin' }

async function inlineScriptsOf(path: string): Promise<string[]> {
  const app = createApp()
  const res = await app.request(path, {}, baseEnv as never)
  expect(res.status).toBe(200)
  const body = await res.text()
  const blocks = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
  expect(blocks.length).toBeGreaterThan(0)
  return blocks
}

describe('dashboard inline scripts parse (#462 regression)', () => {
  it('/dashboard/broker-probe の全 inline script が構文エラーなく parse できる', async () => {
    for (const code of await inlineScriptsOf('/dashboard/broker-probe')) {
      // 構文エラーなら new Function が SyntaxError を throw する (実行はしない)。
      expect(() => new Function(code)).not.toThrow()
    }
  })
})
