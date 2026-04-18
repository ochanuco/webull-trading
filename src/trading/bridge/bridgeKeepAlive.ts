import { getContainer } from '@cloudflare/containers'
import type { BridgeContainer } from './BridgeContainer'

export interface BridgeKeepAliveEnv {
  BRIDGE?: DurableObjectNamespace<BridgeContainer>
  WEBULL_APP_KEY?: string
  WEBULL_APP_SECRET?: string
  WEBULL_ACCOUNT_ID?: string
  WEBULL_GRPC_ENDPOINT?: string
  EVENT_INGEST_URL?: string
  EVENT_INGEST_SECRET?: string
}

/**
 * Called from the Worker cron handler. Ensures the single bridge container
 * instance is running and has the current set of secrets. Idempotent: if the
 * container is already up, `start()` is a no-op.
 *
 * Fails open — any error is logged and swallowed so the rest of the scheduled
 * handler (e.g. quote feed) is unaffected.
 */
export async function keepBridgeAlive(env: BridgeKeepAliveEnv): Promise<void> {
  if (!env.BRIDGE) {
    console.log(JSON.stringify({ event: 'bridge_keep_alive_skipped', reason: 'BRIDGE binding missing' }))
    return
  }

  const missing = requiredSecrets
    .filter((key) => !env[key] || String(env[key]).length === 0)
    .map((key) => key as string)
  if (missing.length > 0) {
    console.log(
      JSON.stringify({
        event: 'bridge_keep_alive_skipped',
        reason: 'required secret missing',
        missing,
      }),
    )
    return
  }

  try {
    // Single bridge instance — not a per-symbol DO. Pin the name so every
    // Worker invocation lands on the same container stub.
    const container = getContainer(env.BRIDGE, 'default')
    await container.start({
      envVars: {
        WEBULL_APP_KEY: env.WEBULL_APP_KEY!,
        WEBULL_APP_SECRET: env.WEBULL_APP_SECRET!,
        WEBULL_ACCOUNT_ID: env.WEBULL_ACCOUNT_ID!,
        WEBULL_GRPC_ENDPOINT: env.WEBULL_GRPC_ENDPOINT!,
        EVENT_INGEST_URL: env.EVENT_INGEST_URL!,
        EVENT_INGEST_SECRET: env.EVENT_INGEST_SECRET!,
      },
    })
    console.log(JSON.stringify({ event: 'bridge_keep_alive_ok', at: new Date().toISOString() }))
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'bridge_keep_alive_error',
        at: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

const requiredSecrets = [
  'WEBULL_APP_KEY',
  'WEBULL_APP_SECRET',
  'WEBULL_ACCOUNT_ID',
  'WEBULL_GRPC_ENDPOINT',
  'EVENT_INGEST_URL',
  'EVENT_INGEST_SECRET',
] as const satisfies ReadonlyArray<keyof BridgeKeepAliveEnv>
