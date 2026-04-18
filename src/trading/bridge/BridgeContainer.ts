import { Container } from '@cloudflare/containers'

/**
 * Always-on (best-effort) Webull gRPC trade-event bridge, run as a Cloudflare
 * Container instance. The Worker's cron handler pings `start()` every 5 min so
 * that if the host has been restarted or the container has been swept for
 * inactivity, it comes back without operator intervention. Cloudflare does not
 * guarantee arbitrary-length process lifetime, so the bridge Node entry still
 * holds its own reconnect loop inside.
 *
 * Secrets (WEBULL_APP_KEY / _SECRET / _ACCOUNT_ID, WEBULL_GRPC_ENDPOINT,
 * EVENT_INGEST_URL, EVENT_INGEST_SECRET) flow from Worker `env` → `.start({
 * envVars: { ... } })` → container process env. They are never baked into the
 * image.
 */
export class BridgeContainer extends Container {
  // Outbound-only: no inbound HTTP. `defaultPort` omitted.
  override sleepAfter = '24h'
  override enableInternet = true

  override onStart() {
    console.log(JSON.stringify({ event: 'bridge_container_started', at: new Date().toISOString() }))
  }

  override onStop(params: { exitCode: number; reason: string }) {
    console.log(
      JSON.stringify({
        event: 'bridge_container_stopped',
        at: new Date().toISOString(),
        exitCode: params.exitCode,
        reason: params.reason,
      }),
    )
  }

  override onError(error: unknown) {
    console.error(
      JSON.stringify({
        event: 'bridge_container_error',
        at: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
