/**
 * Operator-driven `x-access-token` 取得 script (#21 Phase A)。
 *
 * Webull JP の本番 OpenAPI endpoint は signature + 2FA-backed token の hybrid
 * auth を要求する。token は dev portal の UI から取れず、API 経由でのみ発行
 * できるため、本 script で取得して `wrangler secret put` で投入する運用。
 *
 * Usage:
 *   pnpm run issue-token
 *
 * 必要な env:
 *   WEBULL_APP_KEY=<app key>
 *   WEBULL_APP_SECRET=<app secret>
 *   (optional) WEBULL_TRADE_API_BASE=<UAT ALB URL>  ※ 未設定なら本番 host
 *   (optional) WEBULL_EXISTING_TOKEN=<previous token to refresh>
 *
 * 流れ:
 *   1. POST /openapi/auth/token/create — PENDING token を取得
 *   2. operator が Webull モバイルアプリで 5 分以内に 2FA SMS verify
 *   3. POST /openapi/auth/token/check を 30s 毎に poll、status が NORMAL に
 *      なったら確定
 *   4. 取得 token を console に表示 + `wrangler secret put` コマンドを suggest
 */

import { WebullAuth } from '../src/infrastructure/webull/WebullAuth'
import {
  WebullTokenClient,
  type WebullAccessTokenDto,
} from '../src/infrastructure/webull/WebullTokenClient'

const DEFAULT_BASE_URL = 'https://api.webull.co.jp'
const POLL_INTERVAL_MS = 30_000
const POLL_TIMEOUT_MS = 5 * 60_000

const appKey = process.env.WEBULL_APP_KEY
const appSecret = process.env.WEBULL_APP_SECRET
const baseUrl = process.env.WEBULL_TRADE_API_BASE?.trim() || DEFAULT_BASE_URL
const existingToken = process.env.WEBULL_EXISTING_TOKEN?.trim() || undefined

if (!appKey || !appSecret) {
  console.error('Set WEBULL_APP_KEY and WEBULL_APP_SECRET in the environment first.')
  process.exit(1)
}

function summarize(token: WebullAccessTokenDto): string {
  // Show only the head + tail of the token so operator can correlate without
  // accidentally pasting the secret into chat / screenshots.
  const head = token.token.slice(0, 6)
  const tail = token.token.slice(-4)
  return `${head}...${tail} (expires=${token.expires}, status=${token.status})`
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  console.error(`[issue-token] base URL: ${baseUrl}`)
  if (existingToken) {
    console.error('[issue-token] refreshing existing token via WEBULL_EXISTING_TOKEN.')
  }

  const auth = new WebullAuth({ appKey, appSecret })
  const client = new WebullTokenClient({ auth, baseUrl })

  console.error('[issue-token] step 1/3: POST /openapi/auth/token/create')
  const initial = await client.createToken(existingToken)
  console.error(`[issue-token] received: ${summarize(initial)}`)

  if (initial.status === 'NORMAL') {
    // Test env (UAT) は 2FA 不要で auto-NORMAL なケースがある。即時利用可。
    printResult(initial)
    return
  }

  if (initial.status === 'INVALID' || initial.status === 'EXPIRED') {
    console.error(`[issue-token] token returned with terminal status ${initial.status}. Aborting.`)
    process.exit(2)
  }

  console.error('[issue-token] step 2/3: open Webull mobile app and complete 2FA SMS verify (5 min).')
  console.error(
    `[issue-token] step 3/3: polling /openapi/auth/token/check every ${POLL_INTERVAL_MS / 1000}s ` +
      `(timeout ${POLL_TIMEOUT_MS / 1000}s)...`,
  )

  const startedAt = Date.now()
  let latest = initial
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS)
    latest = await client.checkToken(initial.token)
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000)
    console.error(`[issue-token] poll (${elapsedSec}s elapsed): ${summarize(latest)}`)

    if (latest.status === 'NORMAL') {
      printResult(latest)
      return
    }
    if (latest.status === 'INVALID' || latest.status === 'EXPIRED') {
      console.error(`[issue-token] poll terminated with status ${latest.status}. Aborting.`)
      process.exit(3)
    }
  }

  console.error(
    `[issue-token] poll exceeded ${POLL_TIMEOUT_MS / 1000}s without NORMAL status. ` +
      'Re-run after completing 2FA in the Webull mobile app.',
  )
  process.exit(4)
}

function printResult(token: WebullAccessTokenDto): void {
  // Token 文字列自体は stdout に出して redirect / pipe しやすくする。
  // 周辺メタデータは stderr。これで `pnpm run issue-token > .token` のように
  // file に流せる。
  console.error('[issue-token] NORMAL token acquired. Inject via:')
  console.error('  pnpm wrangler secret put WEBULL_ACCESS_TOKEN --env=<dev|staging|production>')
  console.error('  (paste the value printed below)')
  console.error('')
  console.log(token.token)
}

main().catch((error) => {
  console.error(`[issue-token] failed: ${error instanceof Error ? error.message : String(error)}`)
  if (error instanceof Error && error.stack) {
    console.error(error.stack)
  }
  process.exit(1)
})
