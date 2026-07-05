import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadSymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'
import { createDb } from '../../src/infrastructure/db/tradeJournalRepo'
import { makeSymbolUniverse } from '../helpers/configFixtures'

vi.mock('../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/tradeJournalRepo', async () => {
  const actual = await vi.importActual<typeof import('../../src/infrastructure/db/tradeJournalRepo')>(
    '../../src/infrastructure/db/tradeJournalRepo',
  )
  return { ...actual, createDb: vi.fn() }
})

const baseEnv = { ACCESS_DEV_BYPASS_USER: 'admin' }

/** POST /mcp に JSON-RPC message を送る helper。 */
async function rpc(env: Record<string, unknown>, body: unknown): Promise<Response> {
  const app = createApp()
  return app.request(
    '/mcp',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  )
}

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }
}

/** dashboardJsonApi.test.ts と同じ SymbolStateDO の fake namespace。 */
function fakeSymbolStateNamespace() {
  const stub = {
    async getState(symbol: string) {
      return {
        symbol,
        position: { qty: 10, avgPrice: 100, openedAt: '2026-06-20T00:00:00.000Z' },
        pendingOrder: null,
        lastSignalAt: null,
        cooldownUntil: null,
        settledCash: 0,
        pendingSettlement: [],
        lastExecutedPrice: null,
        lastQuote: { price: 105, asOf: '2026-07-01T00:00:00Z', fetchedAt: '2026-07-01T00:00:00Z', source: 'yahoo' },
        updatedAt: '2026-07-01T00:00:00.000Z',
      }
    },
  }
  return {
    idFromName: (_name: string) => 'id',
    get: (_id: string) => stub,
  } as unknown
}

/** loadDecisionRows (select→from→leftJoin→where→orderBy→limit) 用の fake chain。 */
function fakeCronDb(rows: unknown[]) {
  const query = {
    from: vi.fn(() => query),
    leftJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(async () => rows),
  }
  return {
    select: vi.fn(() => query),
  }
}

describe('read-only MCP server (#553)', () => {
  beforeEach(() => {
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({
        allowedSymbols: ['SOXL'],
        inactiveSymbols: [],
        symbolCurrency: { SOXL: 'USD' },
        symbolName: { SOXL: 'Direxion Semiconductor Bull 3X' },
      }),
    )
  })
  afterEach(() => vi.resetAllMocks())

  describe('auth (Cloudflare Access)', () => {
    it('rejects requests without Access JWT / dev bypass', async () => {
      // bypass なし env → accessJwtMiddleware の既存挙動 (fail-closed 401)
      const res = await rpc({}, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
      expect(res.status).toBe(401)
    })
  })

  describe('JSON-RPC framing', () => {
    it('responds to initialize echoing the client protocolVersion', async () => {
      const res = await rpc(baseEnv, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.0.0' },
        },
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as Record<string, any>
      expect(json.jsonrpc).toBe('2.0')
      expect(json.id).toBe(1)
      expect(json.result.protocolVersion).toBe('2025-06-18')
      expect(json.result.capabilities).toEqual({ tools: {} })
      expect(json.result.serverInfo).toEqual({ name: 'webull-trading-dashboard', version: '0.1.0' })
    })

    it('accepts notifications/initialized with an empty 202', async () => {
      const res = await rpc(baseEnv, { jsonrpc: '2.0', method: 'notifications/initialized' })
      expect(res.status).toBe(202)
      expect(await res.text()).toBe('')
    })

    it('returns -32601 for unknown methods', async () => {
      const res = await rpc(baseEnv, { jsonrpc: '2.0', id: 7, method: 'resources/list' })
      const json = (await res.json()) as Record<string, any>
      expect(json.id).toBe(7)
      expect(json.error.code).toBe(-32601)
    })

    it('returns -32600 for batch (array) requests', async () => {
      const res = await rpc(baseEnv, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
      const json = (await res.json()) as Record<string, any>
      expect(json.error.code).toBe(-32600)
    })

    it('returns -32700 for unparseable bodies', async () => {
      const app = createApp()
      const res = await app.request(
        '/mcp',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' },
        baseEnv,
      )
      const json = (await res.json()) as Record<string, any>
      expect(json.error.code).toBe(-32700)
    })

    it('rejects GET /mcp with 405 (SSE not supported)', async () => {
      const app = createApp()
      const res = await app.request('/mcp', {}, baseEnv)
      expect(res.status).toBe(405)
    })
  })

  describe('tools/list', () => {
    it('lists the 5 read-only dashboard tools', async () => {
      const res = await rpc(baseEnv, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
      const json = (await res.json()) as Record<string, any>
      const names = json.result.tools.map((t: { name: string }) => t.name)
      expect(names).toEqual([
        'get_positions',
        'get_trades',
        'get_cron_decisions',
        'get_equity',
        'get_symbol_chart',
      ])
      // 全 tool が inputSchema (JSON Schema) を持つ
      for (const tool of json.result.tools) {
        expect(tool.inputSchema.type).toBe('object')
        expect(typeof tool.description).toBe('string')
      }
    })
  })

  describe('tools/call', () => {
    it('get_positions returns the dashboard_positions_export.v1 packet as text', async () => {
      const env = {
        ...baseEnv,
        DB: {} as D1Database,
        SYMBOL_STATE: fakeSymbolStateNamespace(),
      }
      const res = await rpc(env, toolCall('get_positions'))
      expect(res.status).toBe(200)
      const json = (await res.json()) as Record<string, any>
      expect(json.result.isError).toBeUndefined()
      expect(json.result.content).toHaveLength(1)
      expect(json.result.content[0].type).toBe('text')
      const packet = JSON.parse(json.result.content[0].text) as Record<string, any>
      // /dashboard/positions/json と同じ packet builder → 同じ schema 契約
      expect(packet.schema).toBe('dashboard_positions_export.v1')
      expect(packet.rowCount).toBe(1)
      expect(packet.positions[0].symbol).toBe('SOXL')
      expect(packet.positions[0].qty).toBe(10)
      expect(packet.positions[0].avgPrice).toBe(100)
      expect(packet.positions[0].unrealizedPnlPct).toBe(5)
    })

    it('get_cron_decisions with symbol filter reuses the shared cron export', async () => {
      vi.mocked(createDb).mockReturnValue(
        fakeCronDb([
          {
            id: 42,
            timestamp: '2026-07-01T00:00:00.000Z',
            requestId: 'req-9',
            symbol: 'SOXL',
            decision: 'SKIP',
            reason: 'pullback -0.01 > -0.03 (not deep enough)',
            price: 30,
            indicatorsJson: '{"price":30}',
            clientOrderId: null,
            traceJson: null,
            filledPrice: null,
            filledQty: null,
            realizedPnl: null,
            brokerStatus: null,
          },
        ]) as never,
      )
      const res = await rpc(
        { ...baseEnv, DB: {} as D1Database },
        toolCall('get_cron_decisions', { symbol: 'soxl', limit: 10 }),
      )
      const json = (await res.json()) as Record<string, any>
      expect(json.result.isError).toBeUndefined()
      const packet = JSON.parse(json.result.content[0].text) as Record<string, any>
      expect(packet.schema).toBe('dashboard_cron_export.v1')
      expect(packet.symbol).toBe('SOXL')
      expect(packet.limit).toBe(10)
      expect(packet.rowCount).toBe(1)
      expect(packet.decisions[0].id).toBe(42)
      expect(packet.decisions[0].requestId).toBe('req-9')
      // route と同じ cronDecisionJson 経由 → indicators は parse 済み object
      expect(packet.decisions[0].indicators).toEqual({ price: 30 })
    })

    it('get_symbol_chart without symbol returns isError (not a 500)', async () => {
      const res = await rpc({ ...baseEnv, DB: {} as D1Database }, toolCall('get_symbol_chart'))
      expect(res.status).toBe(200)
      const json = (await res.json()) as Record<string, any>
      expect(json.result.isError).toBe(true)
      expect(json.result.content[0].text).toContain('symbol')
    })

    it('returns isError when DB is not bound (fail-graceful, not a 500)', async () => {
      for (const name of ['get_positions', 'get_trades', 'get_cron_decisions', 'get_equity']) {
        const res = await rpc(baseEnv, toolCall(name))
        expect(res.status).toBe(200)
        const json = (await res.json()) as Record<string, any>
        expect(json.result.isError).toBe(true)
        expect(json.result.content[0].text).toContain('not configured')
      }
    })

    it('returns -32602 for unknown tool names', async () => {
      const res = await rpc(baseEnv, toolCall('place_order', { symbol: 'SOXL' }))
      const json = (await res.json()) as Record<string, any>
      expect(json.error.code).toBe(-32602)
    })
  })
})
