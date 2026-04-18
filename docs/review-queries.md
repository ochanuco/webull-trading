# Trade journal review queries

All trade-journal records are emitted to `console.log` as NDJSON (one JSON object per line) from the Worker and end up in Cloudflare Workers Logs. The audit middleware (`src/infrastructure/logger/AuditLogger.ts`) records HTTP request lifecycle; the trade-journal module (`src/infrastructure/logger/tradeJournal.ts`) records trade lifecycle. Both share the same sink so queries below match against Workers Logs output.

## Record shapes

Every trade-journal line has:

- `timestamp` — ISO 8601 (UTC)
- `trade_event_type` — one of `decision`, `intent`, `pre_submit`, `post_submit`, `fill`, `exit`
- `symbol` — upper-case ticker (when applicable)
- `request_id` — correlates to a single HTTP call; joins with `AuditLogger` records
- `client_order_id` — correlates a trade across `intent → pre_submit → post_submit → fill → exit`
- other fields depend on the event type; see `TradeJournalRecord` for the full set

## Cloudflare Workers Logs filters

Workers Logs supports JSON path filters. Examples:

### Daily P&L

```
trade_event_type = "exit"
(group by) date(timestamp)
(sum) realized_pnl
```

### Win rate by strategy

```
(join) exit records (trade_event_type = "exit")
       -> decision records (trade_event_type = "decision")
       on client_order_id
(group by) strategy_name, exit_reason
```

Join `exit` back to the original `decision` with matching `client_order_id` to recover `strategy_name`.

### Risk-reject breakdown

```
trade_event_type = "decision" AND risk_allowed = false
(group by) risk_reasons[0]
(count) *
```

### Broker latency

```
trade_event_type = "post_submit"
(avg, p95) latency_ms
```

### Quote staleness fall-through

Look for `decision` records where `signal_action = "HOLD"` and (future) a reason tag like `quote_stale`. Issue #37 will wire the staleness guard to emit that reason; this section will be finalized when it lands.

## Local grep cheatsheet (development)

```
wrangler tail --format=json | jq 'select(.trade_event_type=="exit")'
wrangler tail --format=json | jq 'select(.client_order_id=="<id>")'
```

`wrangler tail` streams NDJSON from the Worker; pipe through `jq` to filter by trade event type or correlate by `client_order_id`.

## Caveats

- Logs older than the Workers Logs retention window (default 3 days unless you have Logpush) are gone. For longer retention, enable Logpush to R2 or an external sink (tracked separately in POC follow-ups).
- `exit` events are only emitted once position tracking lands (issue #37). Until then, use `fill` as the latest trade-lifecycle record.
- `realized_pnl` is emitted by the caller of `logExit` — correctness depends on whoever closes the position computing it against the right base currency.