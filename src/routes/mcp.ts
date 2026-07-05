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
 * Read-only MCP server (#553) — dashboard の JSON export packet を
 * Model Context Protocol の tools として公開する。
 *
 * 設計方針:
 * - **書き込み tool は作らない (fail-closed)**。全 tool が既存 packet builder
 *   (`dashboard_<page>_export.v<N>`) の read-only 出力をそのまま返すだけ。
 * - **SDK 非依存**: POC 方針 (依存を増やさない) に従い、JSON-RPC 2.0 を素の
 *   Hono handler で処理する streamable HTTP (POST /mcp)。SSE (GET) は spec 上
 *   optional なので非対応 = 405。session 管理も持たない (stateless)。
 * - **認証は Cloudflare Access に一任**: app.ts で `/dashboard` と同じ
 *   `accessJwtMiddleware()` を適用する。MCP クライアントは Access service
 *   token (CF-Access-Client-Id/Secret ヘッダ) で同じ検証を通る — 新しい
 *   認証機構は作らない。
 * - packet builder は HTTP 経由でなく同一 Worker 内で直接呼ぶ。schema
 *   フィールドがそのまま tool の出力契約になる。
 */

/** initialize が client の protocolVersion を echo できない時の fallback。 */
const MCP_PROTOCOL_VERSION = '2025-03-26'

const SERVER_INFO = { name: 'webull-trading-dashboard', version: '0.1.0' }

type JsonRpcId = string | number

interface ToolText {
  type: 'text'
  text: string
}

/** MCP tools/call の結果形。エラーは throw せず isError: true で返す。 */
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

/**
 * tool 実行エラー (binding 未設定 / 引数不正 / loader 失敗) は JSON-RPC error
 * でも HTTP 500 でもなく isError: true の text で返す — MCP spec 上、LLM が
 * 読んで自己修正できるのは tool result 側のエラーだけのため。
 */
function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/**
 * tools/list に返す定義。inputSchema は JSON Schema。description は
 * 「何が返るか + AI がどう使うか」を書く (LLM の tool 選択がこれに依存する)。
 */
const TOOLS = [
  {
    name: 'get_positions',
    description:
      '保有ポジション一覧 (dashboard_positions_export.v1)。銘柄ごとの数量・平均取得単価・現在値・評価損益 (%)・未約定注文・クールダウンを返す。現在の建玉状況の確認や損益の相談の起点に使う。',
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

/** tool argument を string | undefined に正規化 (number も許容して文字列化)。 */
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

/**
 * tool 本体。binding 未設定・引数不正・loader 失敗はすべて isError で返し、
 * HTTP 500 にしない (呼び出し側 LLM に理由を読ませて再試行させる)。
 */
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
      // クエリ解釈は /dashboard/trades(/json) と同じ parseTradesQuery を通す —
      // 「画面の絞り込みと tool の絞り込みが微妙に違う」drift を作らない。
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
      // /dashboard/charts/symbol/json ルート (index.ts) と同じ手順:
      // effective rule (global default → role preset → per-symbol override) を
      // buildSymbolRules で解決し、SSR / JSON export とチャート内容を揃える。
      // 変更時は index.ts 側と同期すること (#dashboard-json-api)。
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
      // 判定履歴の load 失敗 (migration 未適用等) はチャート本体を巻き込まず
      // 空配列に落とす (/charts/symbol/json と同挙動)。
      const decisionRows = await loadDecisionRows(createDb(env.DB), { symbol, limit: 30 }).catch(
        () => [],
      )
      return toolOk(buildSymbolChartPacket(chart, decisionRows))
    }
  }
}

export const mcp = new Hono<AppBindings>()
  // read-only + Access 保護済みだが、dashboard と同じ read 系 soft cap
  // (60 req / 60s) を適用しておく — LLM の tool 連打で D1/DO を焼かない保険。
  .use('*', rateLimit('DASHBOARD'))
  // SSE stream (GET) は MCP spec 上 optional — 本サーバーは server→client の
  // push を持たないので非対応を 405 で明示する。
  .get('/', (c) =>
    c.json({ error: 'method_not_allowed', message: 'SSE is not supported; POST JSON-RPC to /mcp' }, 405),
  )
  // session 管理を持たない stateless サーバーなので DELETE (session 終了) も 405。
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
    // batch (array) は非対応 — 単発 object のみ受ける (POC 最小実装)。
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
    // id なし = notification (notifications/initialized 等)。応答 body 不要、
    // spec 通り 202 Accepted の空応答を返す。
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
        // client の protocolVersion をそのまま echo する (バージョン交渉を
        // 実装しない最単純形 — 本サーバーの応答形はどの版でも互換)。
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
      // ping は MCP spec の必須 keep-alive (クライアントが定期送信してくる)。
      case 'ping':
        return c.json(rpcResult(id, {}))
      case 'tools/list':
        return c.json(rpcResult(id, { tools: TOOLS }))
      case 'tools/call': {
        const params = isRecord(body.params) ? body.params : {}
        const name = typeof params.name === 'string' ? params.name : ''
        const tool = TOOLS.find((t) => t.name === name)
        // 未知 tool は spec 通り JSON-RPC error (-32602 Invalid params)。
        if (!tool) {
          return c.json(rpcError(id, -32602, `Unknown tool: ${name || '(missing name)'}`))
        }
        const args = isRecord(params.arguments) ? params.arguments : {}
        let result: ToolResult
        try {
          result = await callTool(c.env, c.get('requestId'), tool.name, args)
        } catch (err) {
          // loader の想定外 throw も 500 にせず isError で返す (fail-graceful)。
          result = toolError(messageOf(err))
        }
        return c.json(rpcResult(id, result))
      }
      default:
        return c.json(rpcError(id, -32601, `Method not found: ${body.method}`))
    }
  })
