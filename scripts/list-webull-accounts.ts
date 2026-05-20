/**
 * One-off helper: fetch Webull subscriptions (account_id list) for your app.
 *
 * Usage (defaults to JP prod host `api.webull.co.jp`):
 *   WEBULL_APP_KEY=... WEBULL_APP_SECRET=... pnpm run accounts
 *
 * UAT で叩く場合は ALB URL を override:
 *   WEBULL_APP_KEY=... WEBULL_APP_SECRET=... \
 *     WEBULL_TRADE_API_BASE=https://jp-openapi-alb.uat.webullbroker.com \
 *     pnpm run accounts
 *
 * Copy the account_id into `.dev.vars` as WEBULL_ACCOUNT_ID.
 */

import { createWebullReadClient } from '../src/infrastructure/webull/WebullReadClient'

const appKey = process.env.WEBULL_APP_KEY
const appSecret = process.env.WEBULL_APP_SECRET

if (!appKey || !appSecret) {
  console.error('Set WEBULL_APP_KEY and WEBULL_APP_SECRET in the environment first.')
  process.exit(1)
}

const client = createWebullReadClient({
  WEBULL_APP_KEY: appKey,
  WEBULL_APP_SECRET: appSecret,
  WEBULL_TRADE_API_BASE: process.env.WEBULL_TRADE_API_BASE,
})

const subscriptions = await client.listSubscriptions()

if (subscriptions.length === 0) {
  console.error('No subscriptions returned. Confirm the app has any subscribed accounts in the Webull developer dashboard.')
  process.exit(2)
}

// Extract and deduplicate account_id values only (avoid logging sensitive fields)
const accountIds = Array.from(new Set(subscriptions.map((sub) => sub.account_id)))
console.log(JSON.stringify(accountIds, null, 2))