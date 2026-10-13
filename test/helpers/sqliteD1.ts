import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

// Relative to the vitest root (repo root); import.meta.url isn't typed under workers-types.
const MIGRATIONS_DIR = 'drizzle'

/**
 * In-memory D1 backed by node:sqlite with every drizzle migration applied,
 * for repo tests that need real SQL semantics (unique / partial indexes,
 * CHECK constraints, batch atomicity) that `fakeD1` can't model.
 * Covers only the D1 surface drizzle's d1 driver calls.
 */
export function sqliteD1(): { d1: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim().length > 0) sqlite.exec(stmt)
    }
  }

  function prepare(sql: string) {
    let params: SQLInputValue[] = []
    const bound = {
      bind(...values: unknown[]) {
        params = values.map(toSqlValue)
        return bound
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...params), success: true, meta: {} }
      },
      async raw() {
        return sqlite
          .prepare(sql)
          .all(...params)
          .map((row) => Object.values(row))
      },
      async first() {
        return sqlite.prepare(sql).get(...params) ?? null
      },
      async run() {
        const r = sqlite.prepare(sql).run(...params)
        return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid }, results: [] }
      },
    }
    return bound
  }

  const d1 = {
    prepare,
    async batch(stmts: Array<ReturnType<typeof prepare>>) {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const s of stmts) results.push(await s.all())
        sqlite.exec('COMMIT')
        return results
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql)
      return { count: 0, duration: 0 }
    },
  }
  return { d1: d1 as unknown as D1Database, sqlite }
}

function toSqlValue(v: unknown): SQLInputValue {
  if (v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  return v as SQLInputValue
}
