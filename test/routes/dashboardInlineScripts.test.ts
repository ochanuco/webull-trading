import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'

// dashboard の JS は TS テンプレートリテラル内に手書きされており、`\n` と `\\n` の
// 取り違えで click handler が無音で死ぬ。抽出した script を `new Function` で parse
// して構文エラーを CI で検出する。
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
