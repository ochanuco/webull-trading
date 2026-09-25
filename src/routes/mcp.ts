import { Hono } from 'hono'
import type { AppBindings } from '../app'
import type { Env } from '../config/env'
import { rateLimit } from '../middleware/rateLimit'
import { loadGlobalConfigFrom } from '../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../infrastructure/db/symbolUniverse'
import { createDb } from '../infrastructure/db/tradeJournalRepo'
import { buildSymbolRules } from '../trading/strategy/symbolRuleResolution'
import type { SymbolRule } from '../trading/strategy/strategies/PullbackUptrendStrategy'
import { buildPositionsPacket, loadPositionsPageData } from './dashboard/positions'
import { buildTradesPacket, loadTradeJournalRows, parseTradesQuery } from './dashboard/trades'
import { loadDecisionRows, runCronJsonExport } from './dashboard/cron'
import { buildEquityPacket, loadEquityCurve } from './dashboard/charts/equity'
import { strategyParamsFromGlobal } from './dashboard/charts/shared'
import { type SymbolChartRules, buildSymbolChartPacket, loadSymbolChart } from './dashboard/charts/loaders'
import { messageOf } from './dashboard/shared'

/**
 * Read-only MCP server exposing the dashboard JSON export packets as tools.
 * No write tool is added, by design: every tool returns an existing
 * `dashboard_<page>_export.v<N>` packet builder's output unchanged, so the
 * server can't drift from what the dashboard itself shows or gain a
 * broker-mutating side effect.
 */

const MCP_PROTOCOL_VERSION = '2025-03-26'

const SERVER_INFO = { name: 'webull-trading-dashboard', version: '0.1.0' }

type JsonRpcId = string | number

interface ToolText {
  type: 'text'
  text: string
}

interface ToolResult {
  content: ToolText[]
  isError?: boolean
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result }
}

function rpcError(id: JsonRpcId | null, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } }
}

function toolOk(packet: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(packet) }] }
}

// isError result, not a thrown JSON-RPC/HTTP error: MCP spec only lets the calling LLM read and self-correct from a tool result's error.
function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

// inputSchema is JSON Schema; each description states what it returns + when an AI should call it, since tool selection depends on that text.
const TOOLS = [
  {
    name: 'get_positions',
    description:
      '保有銘柄一覧 (dashboard_positions_export.v1)。銘柄ごとの数量・平均取得単価・現在値・評価損益 (%)・未約定注文・クールダウンを返す。現在の保有状況の確認や損益の相談の起点に使う。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_trades',
    description:
      '約定履歴 trade_journal (dashboard_trades_export.v1)。view で全イベント / 約定・手仕舞いのみ / エラーのみを切り替え、symbol / clientOrderId / limit で絞り込める。個別注文の lifecycle 追跡や発注エラーの調査に使う。',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['all', 'fills', 'errors'],
          description: '絞り込みビュー (省略時 all)',
        },
        symbol: { type: 'string', description: '銘柄 (例 SOXL / 1357)' },
        clientOrderId: { type: 'string', description: '注文単位の lifecycle 絞り込み' },
        limit: { type: 'number', description: '最大件数 (既定 50、上限 200)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_cron_decisions',
    description:
      '戦略判定ログ (dashboard_cron_export.v1)。引数なしなら最新 cron 実行 1 回分の全銘柄判定、requestId / decisionId / symbol で絞り込める。「なぜ買った / 買わなかったか」の reason・indicators を読むのに使う。',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'cron 実行 1 回分の requestId' },
        decisionId: { type: 'number', description: '判定 1 行の id (単一判定の詳細)' },
        symbol: { type: 'string', description: 'この銘柄の直近判定だけを新しい順に返す' },
        limit: { type: 'number', description: 'symbol 指定時の最大件数 (既定 50、上限 200)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_equity',
    description:
      'エクイティカーブ (dashboard_equity_export.v1)。日次 realized PnL の累積・ドローダウン率・期間別 (1W/1M/3M/YTD/ALL) と月次のリターンを返す。戦略の長期パフォーマンス評価に使う。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_symbol_chart',
    description:
      '銘柄チャートデータ (dashboard_chart_symbol_export.v1)。日足 + SMA50 + 判定マーカー + その銘柄の有効ルール (stop / TP / 押し目閾値) + 判定履歴 30 件を返す。個別銘柄のエントリー / エグジット状況の分析に使う。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '銘柄 (必須、例 SOXL / 1357)' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
] as const

type ToolName = (typeof TOOLS)[number]['name']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

async function callTool(
  env: Env,
  requestId: string | undefined,
  name: ToolName,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'get_positions': {
      if (!env.DB || !env.SYMBOL_STATE) {
        return toolError('DB or SYMBOL_STATE binding is not configured')
      }
      return toolOk(buildPositionsPacket(await loadPositionsPageData(env)))
    }
    case 'get_trades': {
      if (!env.DB) return toolError('DB binding is not configured')
      // Reuses the dashboard's own parseTradesQuery so tool filtering can't drift from screen filtering.
      const q = parseTradesQuery((key) => stringArg(args, key))
      const rows = await loadTradeJournalRows(createDb(env.DB), q)
      return toolOk(buildTradesPacket(rows, q))
    }
    case 'get_cron_decisions': {
      if (!env.DB) return toolError('DB binding is not configured')
      const { payload, status } = await runCronJsonExport(createDb(env.DB), {
        requestId: stringArg(args, 'requestId'),
        decisionId: stringArg(args, 'decisionId'),
        symbol: stringArg(args, 'symbol'),
        limit: numberArg(args, 'limit'),
      })
      if (status !== 200) {
        const p = payload as { error?: string; message?: string }
        return toolError(`${p.error ?? 'error'}: ${p.message ?? 'cron export failed'}`)
      }
      return toolOk(payload)
    }
    case 'get_equity': {
      if (!env.DB) return toolError('DB binding is not configured')
      return toolOk(buildEquityPacket(await loadEquityCurve(env.DB), new Date()))
    }
    case 'get_symbol_chart': {
      const symbol = stringArg(args, 'symbol')?.toUpperCase().trim()
      if (!symbol) return toolError('symbol is required (e.g. { "symbol": "SOXL" })')
      if (!env.DB) return toolError('DB binding is not configured')
      // Mirrors /dashboard/charts/symbol/json's rule resolution so the two stay in sync.
      const [universe, global] = await Promise.all([
        loadSymbolUniverse(env),
        loadGlobalConfigFrom(env, requestId),
      ])
      const defaultEntryRule: SymbolRule = strategyParamsFromGlobal(global)
      const entryRule = buildSymbolRules(defaultEntryRule, universe)[symbol] ?? defaultEntryRule
      const rules: SymbolChartRules = {
        pullbackMax: entryRule.pullbackMax,
        pullbackMin: entryRule.pullbackMin,
        stopPct: entryRule.stopPct,
        takeProfitPct: entryRule.takeProfitPct,
        timeStopDays: entryRule.timeStopDays,
      }
      const chart = await loadSymbolChart(env, symbol, rules)
      // A decision-history load failure falls back to [] rather than failing the whole chart.
      const decisionRows = await loadDecisionRows(createDb(env.DB), { symbol, limit: 30 }).catch(
        () => [],
      )
      return toolOk(buildSymbolChartPacket(chart, decisionRows))
    }
  }
}

export const mcp = new Hono<AppBindings>()
  // Same soft cap as the dashboard, so a tool-calling LLM can't hammer D1/DO.
  .use('*', rateLimit('DASHBOARD'))
  .get('/', (c) =>
    c.json({ error: 'method_not_allowed', message: 'SSE is not supported; POST JSON-RPC to /mcp' }, 405),
  )
  .delete('/', (c) =>
    c.json({ error: 'method_not_allowed', message: 'sessions are not supported' }, 405),
  )
  .post('/', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(rpcError(null, -32700, 'Parse error'))
    }
    if (Array.isArray(body)) {
      return c.json(rpcError(null, -32600, 'Batch requests are not supported'))
    }
    if (!isRecord(body)) {
      return c.json(rpcError(null, -32600, 'Invalid Request'))
    }
    const idRaw = body.id
    if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return c.json(
        rpcError(typeof idRaw === 'string' || typeof idRaw === 'number' ? idRaw : null, -32600, 'Invalid Request'),
      )
    }
    // A missing id is a JSON-RPC notification, which per spec gets an empty 202, not a result body.
    if (idRaw === undefined || idRaw === null) {
      return c.body(null, 202)
    }
    if (typeof idRaw !== 'string' && typeof idRaw !== 'number') {
      return c.json(rpcError(null, -32600, 'Invalid Request: id must be a string or number'))
    }
    const id: JsonRpcId = idRaw

    switch (body.method) {
      case 'initialize': {
        const params = isRecord(body.params) ? body.params : {}
        // Echoes the client's protocolVersion instead of negotiating: the response shape is compatible with any version.
        const protocolVersion =
          typeof params.protocolVersion === 'string'
            ? params.protocolVersion
            : MCP_PROTOCOL_VERSION
        return c.json(
          rpcResult(id, {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          }),
        )
      }
      // ping is a required MCP keep-alive the client sends periodically.
      case 'ping':
        return c.json(rpcResult(id, {}))
      case 'tools/list':
        return c.json(rpcResult(id, { tools: TOOLS }))
      case 'tools/call': {
        const params = isRecord(body.params) ? body.params : {}
        const name = typeof params.name === 'string' ? params.name : ''
        const tool = TOOLS.find((t) => t.name === name)
        if (!tool) {
          return c.json(rpcError(id, -32602, `Unknown tool: ${name || '(missing name)'}`))
        }
        const args = isRecord(params.arguments) ? params.arguments : {}
        let result: ToolResult
        try {
          result = await callTool(c.env, c.get('requestId'), tool.name, args)
        } catch (err) {
          result = toolError(messageOf(err))
        }
        return c.json(rpcResult(id, result))
      }
      default:
        return c.json(rpcError(id, -32601, `Method not found: ${body.method}`))
    }
  })
