import { describe, expect, it, vi } from 'vitest'
import {
  createNewsHeadlineEvalRepo,
  type NewsHeadlineEvalDb,
  type NewsHeadlineEvalRecord,
} from '../../../src/infrastructure/db/newsHeadlineEvalRepo'

function makeFakeDb(returningRows: Array<{ id: number }>) {
  const values: unknown[] = []
  const onConflictArgs: unknown[] = []
  const insertBuilder = {
    values(v: unknown) {
      values.push(v)
      return {
        onConflictDoNothing(args: unknown) {
          onConflictArgs.push(args)
          return {
            returning(_cols: unknown) {
              return Promise.resolve(returningRows)
            },
          }
        },
      }
    },
  }
  const db = { insert: vi.fn(() => insertBuilder) } as unknown as NewsHeadlineEvalDb
  return { db, values, onConflictArgs }
}

function record(overrides: Partial<NewsHeadlineEvalRecord> = {}): NewsHeadlineEvalRecord {
  return {
    evaluatedAt: '2026-09-26T12:15:00.000Z',
    source: 'google_news_rss',
    query: '("stock market" OR "wall street") when:1h',
    headlineCount: 2,
    headlinesJson: '[]',
    status: 'ok',
    ...overrides,
  }
}

describe('createNewsHeadlineEvalRepo.insertIgnore', () => {
  it('inserts a new slot and reports inserted=true', async () => {
    const { db, onConflictArgs } = makeFakeDb([{ id: 1 }])
    const repo = createNewsHeadlineEvalRepo(db)
    const result = await repo.insertIgnore(record())
    expect(result).toEqual({ inserted: true })
    expect(onConflictArgs).toHaveLength(1)
    const target = (onConflictArgs[0] as { target: unknown[] }).target
    expect(target).toHaveLength(2)
  })

  it('ignores a duplicate (source, evaluatedAt) slot and reports inserted=false', async () => {
    const { db } = makeFakeDb([])
    const repo = createNewsHeadlineEvalRepo(db)
    const result = await repo.insertIgnore(record())
    expect(result).toEqual({ inserted: false })
  })

  it('defaults optional columns to null', async () => {
    const { db, values } = makeFakeDb([{ id: 1 }])
    const repo = createNewsHeadlineEvalRepo(db)
    await repo.insertIgnore(record())
    const inserted = values[0] as Record<string, unknown>
    expect(inserted.error).toBeNull()
    expect(inserted.model).toBeNull()
    expect(inserted.shock).toBeNull()
    expect(inserted.requestId).toBeNull()
  })
})
