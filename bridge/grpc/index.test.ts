import { describe, expect, it, vi } from 'vitest'
import { postTradeEvent } from './index'

const env = {
  workerBaseUrl: 'https://worker.example.com',
  ingestSecret: 'test-secret',
}

const payload = {
  event: {
    orderId: 'order-1',
  },
} as Parameters<typeof postTradeEvent>[1]

describe('postTradeEvent', () => {
  it('posts once on an immediate 200 response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }))

    await postTradeEvent(env, payload, fetchImpl, {
      backoffMs: 0,
      jitter: 0,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries once after a transient 500 before succeeding', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))

    await postTradeEvent(env, payload, fetchImpl, {
      backoffMs: 0,
      jitter: 0,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('throws with the last status after exhausting retries', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 500 }))

    await expect(
      postTradeEvent(env, payload, fetchImpl, {
        backoffMs: 0,
        jitter: 0,
      }),
    ).rejects.toThrow(/status 500/)

    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})
