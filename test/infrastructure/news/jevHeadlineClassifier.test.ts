import { describe, expect, it, vi } from 'vitest'
import { classifyHeadlines, type JevAi } from '../../../src/infrastructure/news/jevHeadlineClassifier'

function fakeAi(run: (model: string, input: unknown) => Promise<unknown>): JevAi {
  return { run: vi.fn(run) }
}

const COMPLETED_SAMPLE = {
  state: 'Completed',
  result: {
    model: 'jev-1.13.0',
    answers: {
      shock: { type: 'noul', noul: 0.94 },
      direction: { type: 'choice', choice: 'risk_off', confidence: 1 },
      severity: { type: 'score', score: 3.08, confidence: 0.23 },
      scope: { type: 'choice', choice: 'broad_us_market', confidence: 1 },
    },
    usage: { input_tokens: 810, output_tokens: 139 },
  },
}

describe('classifyHeadlines', () => {
  it('extracts shock/direction/severity/scope plus usage from a Completed response', async () => {
    const ai = fakeAi(async () => COMPLETED_SAMPLE)
    const result = await classifyHeadlines(ai, ['Stocks tumble on rate fears'])
    expect(result).toEqual({
      ok: true,
      data: {
        model: 'jev-1.13.0',
        answers: {
          shock: 0.94,
          direction: 'risk_off',
          directionConfidence: 1,
          severity: 3.08,
          severityConfidence: 0.23,
          scope: 'broad_us_market',
          scopeConfidence: 1,
        },
        rawAnswers: COMPLETED_SAMPLE.result.answers,
        inputTokens: 810,
        outputTokens: 139,
      },
    })
  })

  it('passes the titles as `state` and the QUESTIONS spec to ai.run', async () => {
    const run = vi.fn(async (_model: string, _input: unknown) => COMPLETED_SAMPLE)
    const ai: JevAi = { run }
    await classifyHeadlines(ai, ['A', 'B'])
    expect(run).toHaveBeenCalledTimes(1)
    const [model, input] = run.mock.calls[0]!
    expect(model).toBe('typesafe/jev')
    expect((input as { state: unknown }).state).toEqual(['A', 'B'])
    expect((input as { questions: unknown }).questions).toBeDefined()
  })

  it('returns ok=false when ai.run rejects', async () => {
    const ai = fakeAi(async () => {
      throw new Error('AI Gateway unavailable')
    })
    const result = await classifyHeadlines(ai, ['x'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('AI Gateway unavailable')
  })

  it('returns ok=false when state !== Completed', async () => {
    const ai = fakeAi(async () => ({ state: 'Failed', error: 'model overloaded' }))
    const result = await classifyHeadlines(ai, ['x'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("state !== 'Completed'")
  })

  it('returns ok=false when the response is not an object', async () => {
    const ai = fakeAi(async () => null)
    const result = await classifyHeadlines(ai, ['x'])
    expect(result.ok).toBe(false)
  })

  it('returns ok=false when answers is missing', async () => {
    const ai = fakeAi(async () => ({ state: 'Completed', result: { model: 'jev-1.13.0' } }))
    const result = await classifyHeadlines(ai, ['x'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('missing answers')
  })

  it('tolerates a partial answers object, nulling only the missing fields', async () => {
    const ai = fakeAi(async () => ({
      state: 'Completed',
      result: {
        model: 'jev-1.13.0',
        answers: { shock: { type: 'noul', noul: 0.1 } },
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    }))
    const result = await classifyHeadlines(ai, ['x'])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.answers.shock).toBe(0.1)
      expect(result.data.answers.direction).toBeNull()
      expect(result.data.answers.severity).toBeNull()
      expect(result.data.answers.scope).toBeNull()
    }
  })
})
