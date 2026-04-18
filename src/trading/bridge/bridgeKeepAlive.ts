import { getContainer } from '@cloudflare/containers'
import type { BridgeContainer } from './BridgeContainer'
import { isBridgeActive, parseBridgeRunMode } from './schedule'

export interface BridgeKeepAliveEnv {
  BRIDGE?: DurableObjectNamespace<BridgeContainer>
  WEBULL_APP_KEY?: string
  WEBULL_APP_SECRET?: string
  WEBULL_ACCOUNT_ID?: string
  WEBULL_GRPC_ENDPOINT?: string
  EVENT_INGEST_URL?: string
  EVENT_INGEST_SECRET?: string
  /** See {@link BridgeRunMode}: `always-on` / `disabled` / `auto` (default). */
  BRIDGE_RUN_MODE?: string
}

export interface KeepBridgeAliveOptions {
  /** Correlates every log line emitted by a single cron tick. */
  requestId?: string
}

/**
 * Called from the Worker cron handler. On active hours ensures the single
 * bridge container instance is running; on inactive hours issues a stop() so
 * idle time is not billed. Idempotent in both directions.
 *
 * Fails open — any error is logged and swallowed so the rest of the scheduled
 * handler (e.g. quote feed) is unaffected.
 */
export async function keepBridgeAlive(
  env: BridgeKeepAliveEnv,
  options: KeepBridgeAliveOptions = {},
): Promise<void> {
  const requestId = options.requestId ?? crypto.randomUUID()

  if (!env.BRIDGE) {
    console.log(
      JSON.stringify({
        event: 'bridge_keep_alive_skipped',
        requestId,
        reason: 'BRIDGE binding missing',
      }),
    )
    return
  }

  const mode = parseBridgeRunMode(env.BRIDGE_RUN_MODE)

  if (!isBridgeActive(new Date(), mode)) {
    await stopContainer(env, {
      requestId,
      reason: mode === 'disabled' ? 'kill-switch' : 'outside market hours',
    })
    return
  }

  const missing = requiredSecrets
    .filter((key) => !env[key] || String(env[key]).length === 0)
    .map((key) => key as string)
  if (missing.length > 0) {
    console.log(
      JSON.stringify({
        event: 'bridge_keep_alive_skipped',
        requestId,
        reason: 'required secret missing',
        missing,
      }),
    )
    return
  }

  try {
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
    console.log(
      JSON.stringify({
        event: 'bridge_keep_alive_ok',
        requestId,
        at: new Date().toISOString(),
        mode,
      }),
    )
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'bridge_keep_alive_error',
        requestId,
        at: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

async function stopContainer(
  env: BridgeKeepAliveEnv,
  ctx: { requestId: string; reason: string },
): Promise<void> {
  if (!env.BRIDGE) return
  try {
    const container = getContainer(env.BRIDGE, 'default')
    await container.stop()
    console.log(
      JSON.stringify({
        event: 'bridge_keep_alive_stopped',
        requestId: ctx.requestId,
        at: new Date().toISOString(),
        reason: ctx.reason,
      }),
    )
  } catch (error) {
    // `stop()` against a container that was never started is not exceptional;
    // swallow silently at debug level.
    console.log(
      JSON.stringify({
        event: 'bridge_keep_alive_stop_noop',
        requestId: ctx.requestId,
        reason: ctx.reason,
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
