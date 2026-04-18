/**
 * One-off helper: fetch Webull subscriptions (account_id list) for your app.
 *
 * Usage:
 *   WEBULL_APP_KEY=... WEBULL_APP_SECRET=... WEBULL_API_BASE=https://api.sandbox.webull.hk \
 *     pnpm run accounts
 *
 * Copy the account_id into `.dev.vars` as WEBULL_ACCOUNT_ID.
 */

import { createWebullHttpClient } from '../src/infrastructure/webull/WebullHttpClient'

const appKey = process.env.WEBULL_APP_KEY
const appSecret = process.env.WEBULL_APP_SECRET
const apiBase = process.env.WEBULL_API_BASE

if (!appKey || !appSecret) {
  console.error('Set WEBULL_APP_KEY and WEBULL_APP_SECRET in the environment first.')
  process.exit(1)
}

if (!apiBase) {
  console.error('Set WEBULL_API_BASE (e.g. https://api.sandbox.webull.hk).')
  process.exit(1)
}

const client = createWebullHttpClient({
  WEBULL_APP_KEY: appKey,
  WEBULL_APP_SECRET: appSecret,
  WEBULL_API_BASE: apiBase,
})

const subscriptions = await client.listSubscriptions()

if (subscriptions.length === 0) {
  console.error('No subscriptions returned. Confirm the app has any subscribed accounts in the Webull developer dashboard.')
  process.exit(2)
}

console.log(JSON.stringify(subscriptions, null, 2))
