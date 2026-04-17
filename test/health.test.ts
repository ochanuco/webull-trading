import { describe, it, expect } from 'vitest'
import { createApp } from '../src/app'

describe('GET /health', () => {
  it('returns 200 with status=ok and an ISO timestamp', async () => {
    const app = createApp()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; timestamp: string }
    expect(body.status).toBe('ok')
    expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date')
  })
})
