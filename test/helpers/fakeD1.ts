/**
 * 空返しの D1 fake。dashboard の SSR は複数の loader を並列に叩くので、
 * 「クエリは通るが行は無い」状態を作れれば描画自体は検証できる。
 * 行の内容を検証したいテストは loader を vi.mock する側で組む。
 */
export function fakeD1(): D1Database {
  const stmt = {
    bind() {
      return stmt
    },
    async all() {
      return { results: [] }
    },
    async first() {
      return null
    },
    async run() {
      return { success: true }
    },
    async raw() {
      return []
    },
  }
  return {
    prepare: () => stmt,
    batch: async () => [],
  } as unknown as D1Database
}
