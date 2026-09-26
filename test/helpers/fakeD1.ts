// Empty-row D1 fake; tests that need row content mock the loader instead.
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
