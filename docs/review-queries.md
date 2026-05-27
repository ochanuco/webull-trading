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

- Logs older than the Workers Logs retention window (default 3 days unless you have Logpush) only survive in R2 if logpush has been enabled — see [R2 Logpush archive queries](#r2-logpush-archive-queries-207).
- `exit` events are only emitted once position tracking lands (issue #37). Until then, use `fill` as the latest trade-lifecycle record.
- `realized_pnl` is emitted by the caller of `logExit` — correctness depends on whoever closes the position computing it against the right base currency.

## R2 Logpush archive queries (#207)

Workers Logs older than the in-product retention are mirrored to R2 by a Logpush job that Cloudflare provisions automatically when "R2 (automatic setup)" is chosen in the dashboard. The destination bucket name is **`cloudflare-managed-b3e9122f`** (auto-assigned — Cloudflare's automatic setup always creates a fresh `cloudflare-managed-*` bucket; the pre-created `webull-trading-logs` bucket from the earlier MCP step ended up unused and can be deleted). A 90-day lifecycle rule (`logpush-90d`) is attached so shards expire on their own.

### Bucket / object layout

- Bucket: `cloudflare-managed-b3e9122f`
- Top-level prefix: `YYYYMMDD/` (one per UTC date — e.g. `20260527/`)
  - The `00010101/` prefix that may show up is Cloudflare's "epoch sentinel" placeholder; it has no real events.
- Each day folder contains gzipped NDJSON shards (`*.json.gz`).

Set the bucket name in a shell variable for the recipes below:

```sh
export BUCKET=cloudflare-managed-b3e9122f
```

### Listing day folders

```sh
wrangler r2 bucket info "$BUCKET"             # bucket-level metadata (size, object_count)
# Cloudflare R2 doesn't have a bare-`r2 object list` CLI; use the dashboard or
# the S3-compatible endpoint via aws-cli + r2 credentials when programmatic
# listing is needed. The dashboard's "browse" tab is enough for ad-hoc forensics.
```

### Pull a shard and filter for `strategy_cron_error`

```sh
# Cloudflare ships gzipped NDJSON. Stream-decompress and pipe to jq.
# Replace <shard>.json.gz with an actual key from the dashboard's day folder.
wrangler r2 object get "$BUCKET/20260115/<shard>.json.gz" \
  | gunzip \
  | jq -c 'select((.Logs[]?.Message[0] | tostring) | contains("strategy_cron_error"))'
```

### Pin a single `request_id` across the archive

```sh
# When dashboard / D1 references a request_id older than Workers Logs retention,
# the full per-request trace can still be reconstructed from R2.
wrangler r2 object get "$BUCKET/20260115/<shard>.json.gz" \
  | gunzip \
  | jq -c 'select((.Logs[]?.Message[0] | tostring) | contains("<request_id>"))'
```

### Caveats specific to R2 archive

- Logpush emits the **raw Workers Logs envelope**, not the parsed `event` payload. NDJSON lines are `{ "TimestampMs": ..., "Logs": [{ "Message": [...] }] }` shaped — the original `event` / `cause` / `message` fields appear as the string inside `.Logs[].Message[0]`. The `jq` filters above grep against that string; for typed access, parse it with `fromjson?` after extracting.
- Cloudflare's default sample rate is 100%; the automatic setup keeps it at 100% so low-volume events (`strategy_cron_error` is intentionally rare) are not dropped.
- The bucket has a 90-day lifecycle rule (`logpush-90d`). Older shards are auto-deleted by Cloudflare R2; no recovery path.
- Programmatic full-bucket scans need the S3-compatible R2 endpoint + an R2 API token (the Logpush automatic setup already issued one — find it under R2 → Manage R2 API Tokens). Day-folder browsing in the dashboard is sufficient for ad-hoc forensics.

---

# 運用 runbook (issue #208 / #141 follow-up)

「アラート受領 → 一次対応」の最短手順。critical = 即対応 (trading 停止確認が先)、warning = 頻度確認後 follow-up、info = 状態遷移ログ (確認だけ)。

## アラート通知の流れ

1. `Notifier.notify({ type, message, cause, severity })` を cron / route handler から **fire-and-forget** で叩く (`src/infrastructure/notification/Notifier.ts`)。
2. 実体は `LoggingNotifier` で `WebhookNotifier` を装飾している (`src/infrastructure/notification/LoggingNotifier.ts`)。1 回の `notify()` で:
   - Slack / Discord webhook に POST (env: `SLACK_WEBHOOK_URL` / `DISCORD_WEBHOOK_URL`、未設定なら NoopNotifier)
   - D1 `notification_emit_log` に 1 行 INSERT (#141、`severity` / `event_type` / `cause` / `message` / `request_id`)
3. `event_type` は `'TRADE'` / `'ERROR'` / `'STATE_CHANGE'` の 3 種、`severity` は `'critical'` / `'warning'` / `'info'`。
4. webhook が失敗しても D1 行は残る (audit trail)。逆に D1 INSERT が失敗しても webhook は飛ぶ (内部 try/catch)。

ダッシュボード / D1 から「直近に push したアラート」を見る:

- **dashboard**: `/dashboard/alerts?severity=critical&eventType=ERROR` (severity / eventType はそれぞれ AND で組む)
- **D1**:
  ```sql
  SELECT timestamp, severity, event_type, cause, symbol, message
  FROM notification_emit_log
  ORDER BY timestamp DESC, id DESC
  LIMIT 50;
  ```

## 一次対応の優先順位 (severity 別)

| severity | 最初に見る | 「まず確認」 |
|---|---|---|
| `critical` | `/dashboard/alerts?severity=critical` → `/dashboard/portfolio` | trading が止まっているか / global_config が想定値か |
| `warning`  | `/dashboard/alerts?severity=warning` | 同 cause が短時間に連発していないか (頻度) |
| `info`     | `/dashboard/alerts?severity=info`    | STATE_CHANGE の `from`/`to` が意図したものか |

実発注 (`dry_run=0 && trading_enabled=1`) を即時止めたい場合の break-glass:

```sql
UPDATE global_config
SET trading_enabled = 0,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'default';
```

詳しい SQL は `docs/db-operations.md` の「global_config 運用」を参照。

## 各アラートイベントの runbook

emit 箇所は `cause` (ERROR) / `field` (STATE_CHANGE) で識別する。`event_type` は `notification_emit_log.event_type` 列。

### `cause = 'strategy_cron'` (severity: critical)

**何が起きたか**: 15 分の Pullback 戦略 cron (`runStrategyCron`) が global throw した (D1 失敗 / unexpected exception)。`src/index.ts` の scheduled handler が catch して 1 回通知する。

**確認手順**:

1. dashboard `/dashboard/alerts?severity=critical&eventType=ERROR` で `cause='strategy_cron'` 行の `message` を読む。
2. workers logs:
   ```sh
   wrangler tail --format=pretty --search '"event":"strategy_cron_error"'
   ```
   `request_id` で前後の `strategy_cron_run` (= 正常完了行) と挟み込んで「いつから落ち始めたか」を特定。
3. cron 単位の判定詳細は `/dashboard/cron?requestId=<request_id>` で 1 fire 全銘柄分の decision を見る。

**対応**:

- 直近 deploy がある → revert を検討 (戦略本体が落ちている = 全銘柄の decision が出ていない = entry/exit が止まっている)。
- D1 / DO 起因 (binding 切れ等) → wrangler dashboard で binding 状態を確認、`pnpm wrangler d1 info webull-trading-production` で疎通確認。
- 同 message が連続発火 → kill-switch を打つ:
  ```sql
  UPDATE global_config SET trading_enabled = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'default';
  ```

### `cause = 'reconcile_fills'` (severity: critical)

**何が起きたか**: 5 分 cron の `reconcileFills` 全体が throw した。split-brain 修復 (D1 FILLED 行を DO に流し込む) の経路が止まっているので、放置すると `state_applied_at IS NULL` の積み残しが増える (issue #142 系)。

**確認手順**:

1. dashboard `/dashboard/alerts?severity=critical&eventType=ERROR` の `message` 列。
2. workers logs:
   ```sh
   wrangler tail --format=pretty --search '"event":"reconcile_fills_error"'
   ```
3. 積み残し件数を D1 で確認:
   ```sql
   SELECT COUNT(*) AS pending_apply
   FROM trade_journal
   WHERE trade_event_type = 'post_submit'
     AND broker_status = 'FILLED'
     AND state_applied_at IS NULL;
   ```
   または HTTP で `GET /admin/orders/repair-status` (同じ count を返す)。

**対応**:

- 5 分後の次 cron で自然に再走するので、まずは 2-3 tick 待って収まるか観察。
- 収まらない / 件数が増え続ける → 手動 sweep:
  ```sh
  curl -X POST -u "$ADMIN_USER:$ADMIN_PASS" \
    "$WORKER_URL/admin/orders/reconcile?retryStateApply=1"
  ```
  `retryStateApply=1` は cron lookback を抜けた古い行も含めて拾う (issue #142 / #203)。

### `cause = 'reconcile_fills_partial'` (severity: warning)

**何が起きたか**: reconcile 全体は走ったが、内部で per-row エラー (`reconcile_fill_update_error` / `reconcile_state_apply_error`) が発生して summary に積まれた。1 row 1 通知だと連発するので summary 単位で 1 件にまとめている。

**確認手順**:

1. dashboard で `cause='reconcile_fills_partial'` の `message` ("reconcile fills had N error(s) across M row(s)") を見る。
2. 詳細は workers logs に per-row で出る:
   ```sh
   wrangler tail --format=pretty --search '"event":"reconcile_fill_update_error"'
   wrangler tail --format=pretty --search '"event":"reconcile_state_apply_error"'
   ```
3. D1 で `state_apply_error` が non-NULL な row を直接見る:
   ```sql
   SELECT id, timestamp, client_order_id, symbol, side, broker_status,
          state_applied_at, state_apply_attempts, state_apply_error
   FROM trade_journal
   WHERE state_apply_error IS NOT NULL
     AND state_applied_at IS NULL
   ORDER BY id DESC
   LIMIT 50;
   ```

**対応**:

- 同じ `client_order_id` が `state_apply_attempts >> 1` で詰まっていれば、原因 (DO binding / position 不整合) を読み解いて手動修正後に `?retryStateApply=1` を叩く。
- 一過性 (DO 一時 throw 等) → 次 cron tick で `state_apply_attempts` が 1 増えて成功する場合あり。

### `cause = 'quote_feed'` (severity: warning)

**何が起きたか**: 5 分 cron の `runQuoteFeed` が global throw した (Yahoo / Webull endpoint の DNS / 429 等)。per-symbol skip (= `summary.errors` に積む) ではなく、scheduler 自体が落ちたケース。

**確認手順**:

1. dashboard `/dashboard/alerts?severity=warning&eventType=ERROR` で `cause='quote_feed'` の `message`。
2. workers logs で連続発火を確認:
   ```sh
   wrangler tail --format=pretty --search '"event":"quote_feed_error"'
   ```
3. 直近の quote が D1 / DO に書けているか確認:
   ```sh
   curl -u "$ADMIN_USER:$ADMIN_PASS" "$WORKER_URL/dashboard/positions"
   ```
   `lastQuote` の updatedAt が止まっていれば quote feed の連続失敗確定。

**対応**:

- 1-2 tick (5-10 分) で復旧することが多い。連続発火 (10 分以上連続) のときだけ Yahoo / Webull の status を見に行く。
- 戦略 cron は `lastQuote ?? avgPrice` で進めるので即停止には繋がらないが、長時間止まると bucket gate が古い値で判定するので注意。

### `cause = 'bar fetch'` (severity: warning, symbol あり)

**何が起きたか**: 戦略 cron 中、ある `symbol` の daily/intraday bar 取得 (`barClient.getDailyBars` / `getIntradayBars`) で例外。当該銘柄だけ ERROR / continue して他は通常進行する (`pullbackScheduler.ts`)。

**確認手順**:

1. dashboard `/dashboard/alerts?eventType=ERROR` の `symbol` 列で銘柄絞り込み。
2. D1 の strategy_decision_log で同 symbol の ERROR 連続を確認:
   ```sql
   SELECT timestamp, decision, reason
   FROM strategy_decision_log
   WHERE symbol = ?
   ORDER BY id DESC
   LIMIT 20;
   ```

**対応**:

- 単発なら無視 (Yahoo の rate limit / network blip)。
- 連続 → `symbol_config.active = 0` で一時 universe から外す:
  ```sql
  UPDATE symbol_config SET active = 0,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE symbol = ?;
  ```

### `cause = 'broker submit'` (severity: warning, symbol あり)

**何が起きたか**: 戦略 cron が `tradingService.executeIntent()` を叩いた時の例外 (broker 4xx/5xx、credential、rate limit 等)。当該銘柄のみ ERROR で続行。

**確認手順**:

1. dashboard `/dashboard/alerts?eventType=ERROR` の `cause='broker submit'` 行。
2. 該当 cron fire の判定詳細:
   `/dashboard/cron?requestId=<request_id>` で BUY/SELL の intent / pre_submit が記録されているはず。
3. workers logs (cron 経路の post_submit ログ):
   ```sh
   wrangler tail --format=pretty --search '"event":"cron_log_post_submit_failed"'
   ```

**対応**:

- 単発 + dry_run=true → 無視で良い (記録のみ)。
- 連続 + dry_run=false → 即 `trading_enabled=0` で止める。Webull credential / IP allowlist を確認。
- broker order id が D1 に残っているなら次 reconcile cron で status patch される (idempotent)。

### `cause = 'portfolio_halted'` (severity: critical)

**何が起きたか**: 戦略 cron が以下のいずれかで全 entry を skip した (`emitSkipReasonNotify` from `runStrategyCron.ts`):

- `PORTFOLIO_STATE` binding が無い
- `PortfolioStateClient.getPortfolio()` が throw
- portfolio 側の risk gate (drawdown 以外) で halt 判定

**確認手順**:

1. dashboard `/dashboard/portfolio` で `kill-switch` / `dailyStartEquity` / `lastRolledAt` を確認。
2. D1 で global_config:
   ```sql
   SELECT dry_run, trading_enabled, drawdown_kill_threshold
   FROM global_config WHERE id = 'default';
   ```

**対応**:

- 意図した halt (drawdown / kill-switch ON) なら通知だけ受け取って継続。
- 意図しない halt (binding 切れ等) → wrangler dashboard で `PORTFOLIO_STATE` DO binding を確認。

### `cause = 'drawdown_kill'` (severity: critical)

**何が起きたか**: portfolio drawdown が `global_config.drawdown_kill_threshold` (default -2%) を下回り、cron が新規 entry を全 skip した。

**確認手順**:

1. `/dashboard/portfolio` で `dailyRealizedPnl` / `dailyStartEquity` から drawdown を計算。
2. D1:
   ```sql
   SELECT drawdown_kill_threshold,
          risk_dd_half_threshold,
          risk_dd_halt_threshold
   FROM global_config WHERE id = 'default';
   ```

**対応**:

- 想定内の防御発動。EOD `runPortfolioRoll` (22:00 UTC、`/admin/portfolio/roll-daily`) が走るまで「今日の」分は止まったまま。break-glass で即時 reset したい場合のみ手動で `/admin/portfolio/seed-equity` (notional を渡して `dailyStartEquity` を上書き、`dailyRealizedPnl=0` クリア)。
- 閾値が厳しすぎる → 検証のうえ:
  ```sql
  UPDATE global_config SET drawdown_kill_threshold = -0.03,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'default';
  ```
  (緩める方向は `STATE_CHANGE` で critical 通知される。意図確認の意味で対 0 が条件。)

### `cause = 'no_bridge_state'` (severity: critical)

**何が起きたか**: 戦略 cron が bridge (Webull state proxy) から position state を取れず、全 skip した。

**確認手順**:

1. dashboard `/dashboard/positions` で各 symbol の DO state を確認 (= bridge が無くても DO 経由で取れていれば部分的に判断可)。
2. workers logs:
   ```sh
   wrangler tail --format=pretty --search '"skipReason":"no_bridge_state"'
   ```

**対応**:

- bridge 側の deploy / health を確認 (gRPC bridge は別 issue 系列、#22)。
- 復旧待ち。bridge が戻れば次 cron で自動的に entry が再開。

### `event_type = 'STATE_CHANGE'` (severity: critical / info)

**何が起きたか**: `global_config` の watched 4 field (`dry_run` / `trading_enabled` / `market_hours_check` / `drawdown_kill_threshold`) が cron tick 間で変化した (`detectAndNotifyConfigStateChanges`)。

- `dry_run: true → false` / `trading_enabled: false → true` / `market_hours_check: true → false` → critical (実発注に近づく)
- `drawdown_kill_threshold` が緩む方向 → critical
- 上記の逆方向 (停止に近づく) → info
- 上記以外の遷移 → warning

**確認手順**:

1. dashboard `/dashboard/alerts?eventType=STATE_CHANGE` で `cause` (= field 名) と `message` (from→to) を確認。
2. 現状値 (snapshot vs current):
   ```sql
   SELECT key, value, snapshot_at FROM config_state_snapshot;
   SELECT dry_run, trading_enabled, market_hours_check, drawdown_kill_threshold
   FROM global_config WHERE id = 'default';
   ```

**対応**:

- 意図した変更なら通知だけ確認して継続。
- 想定外 (誰かが誤 UPDATE) → 即元に戻す (例: `UPDATE global_config SET trading_enabled = 0 ...`)、 git log / 認証ログで誰が叩いたかを追う。

### `event_type = 'TRADE'` (severity: info)

**何が起きたか**: cron / `/trade/execute` が DRY_RUN / LIVE で BUY または SELL を出した。`side` / `qty` / `price` (+ SELL なら `realizedPnl`) / `mode` を webhook と D1 に流す。

**確認手順**:

1. dashboard `/dashboard/alerts?eventType=TRADE` で時系列。
2. `/dashboard/trades?limit=50` で trade_journal 直近。
3. 1 注文の lifecycle 詳細:
   ```sql
   SELECT timestamp, trade_event_type, broker_status, filled_qty, filled_price, realized_pnl, error_class
   FROM trade_journal
   WHERE client_order_id = ?
   ORDER BY id ASC;
   ```

**対応**: 通知のみ — 監視。`mode='LIVE'` が出始めたら毎件確認。

## D1 query レシピ集

```sql
-- 直近 24h の TRADE alert (BUY/SELL 別件数)
SELECT
  CASE WHEN message LIKE '%BUY%' THEN 'BUY' ELSE 'SELL' END AS side,
  COUNT(*) AS n
FROM notification_emit_log
WHERE event_type = 'TRADE'
  AND timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
GROUP BY side;

-- 直近 7 日 strategy_decision_log の breakdown (BUY/SELL/HOLD/REJECT/ERROR)
SELECT
  date(timestamp) AS d,
  decision,
  COUNT(*) AS n
FROM strategy_decision_log
WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
GROUP BY d, decision
ORDER BY d DESC, decision;

-- 銘柄ごとの cumulative realized PnL (post_submit の SELL 集計)
SELECT
  symbol,
  COUNT(*) AS n_sells,
  SUM(realized_pnl) AS sum_pnl,
  AVG(realized_pnl) AS avg_pnl
FROM trade_journal
WHERE trade_event_type = 'post_submit'
  AND side = 'SELL'
  AND realized_pnl IS NOT NULL
GROUP BY symbol
ORDER BY sum_pnl DESC;

-- 未約定 (broker_status NULL の post_submit。reconcile が次 tick で patch する想定)
SELECT id, timestamp, client_order_id, symbol, side, quantity, limit_price
FROM trade_journal
WHERE trade_event_type = 'post_submit'
  AND broker_status IS NULL
ORDER BY id DESC
LIMIT 50;

-- split-brain 候補 (FILLED だが DO に未反映、issue #142 / #203)
SELECT id, timestamp, client_order_id, symbol, side,
       broker_status, state_applied_at, state_apply_attempts, state_apply_error
FROM trade_journal
WHERE trade_event_type = 'post_submit'
  AND broker_status = 'FILLED'
  AND state_applied_at IS NULL
ORDER BY id DESC;

-- 直近 100 件の critical / warning アラート (dashboard と同等 SELECT)
SELECT timestamp, severity, event_type, cause, symbol, message
FROM notification_emit_log
WHERE severity IN ('critical', 'warning')
ORDER BY timestamp DESC, id DESC
LIMIT 100;

-- 直近 5 分の ERROR を cause 別に集計 (broker 連続失敗のスポット用)
SELECT cause, COUNT(*) AS n
FROM notification_emit_log
WHERE event_type = 'ERROR'
  AND timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')
GROUP BY cause
ORDER BY n DESC;

-- earnings_calendar の next 14 営業日 (BUY 凍結窓の前確認)
SELECT symbol, earnings_date, notes
FROM earnings_calendar
WHERE earnings_date >= date('now')
  AND earnings_date <= date('now', '+14 days')
ORDER BY earnings_date ASC, symbol ASC;

-- macro_event_calendar の next 30 日
SELECT event_type, event_date, event_time, notes
FROM macro_event_calendar
WHERE event_date >= date('now')
  AND event_date <= date('now', '+30 days')
ORDER BY event_date ASC, event_type ASC;

-- config snapshot vs 現在値 (STATE_CHANGE の追跡)
SELECT
  s.key, s.value AS snapshot_value, s.snapshot_at
FROM config_state_snapshot s
ORDER BY s.key;
```

## Debug 手順

### `wrangler tail` 絞り込み

```sh
# 1 cron fire の全銘柄判定 (request_id を URL から拾って渡す)
wrangler tail --format=pretty --search '"requestId":"<id>"'

# trade lifecycle (1 client_order_id を端から端まで)
wrangler tail --format=json | jq 'select(.client_order_id=="<coid>")'

# 通知関連の失敗 (webhook / D1 INSERT)
wrangler tail --format=pretty --search '"event":"notifier_webhook_failed"'
wrangler tail --format=pretty --search '"event":"logging_notifier_db_failed"'

# reconcile の per-row 失敗 (summary では潰される詳細)
wrangler tail --format=pretty --search '"event":"reconcile_state_apply_error"'

# state change 検知の内部失敗
wrangler tail --format=pretty --search '"event":"config_state_snapshot_load_failed"'
wrangler tail --format=pretty --search '"event":"config_state_change_notify_failed"'
```

### Admin endpoint (手動オペレーション)

すべて Basic 認証 (`ADMIN_USER` / `ADMIN_PASS`)。`POST` は idempotent なものだけ列挙。

| endpoint | 用途 | 主な参照 issue |
|---|---|---|
| `POST /admin/strategy/run` | 戦略 cron を 1 回手動 fire (`runStrategyCron`)。bar fetch / skip reason 確認用。`global_config.dry_run` を尊重。 | #128 |
| `POST /admin/orders/reconcile` | 5 分 reconcile cron の手動再走。`?retryStateApply=1` で lookback を抜けた split-brain 行も拾う。 | #142 / #203 |
| `GET  /admin/orders/repair-status` | `pendingApply` 件数だけ返す軽量 query。dashboard / monitor から scrape 可。 | #142 |
| `GET  /admin/orders/:clientOrderId` | Webull side で当該 coid を直接 lookup (recent history 50 件のみ、超過は 404)。 | — |
| `POST /admin/portfolio/roll-daily` | EOD 手動 rollover (`dailyRealizedPnl → dailyStartEquity`)。22:00 UTC cron が落ちた時の break-glass。 | #140 / #205 |
| `POST /admin/portfolio/seed-equity` | `dailyStartEquity` 上書き + `dailyRealizedPnl=0`。drawdown kill から強制復帰させる時のみ。 | — |
| `POST /admin/symbols/:symbol/seed-cash` | per-symbol `settledCash` を初期化。新銘柄追加直後の seed。 | — |
| `POST /admin/symbols/:symbol/clear-cooldown` | `cooldownUntil` を epoch に戻して即失効 (staging で連続テストする時)。 | — |
| `GET  /admin/backtest` | offline backtest harness。Yahoo daily bars + 戦略 rule で計算のみ (実発注なし)。 | #200 |
| `POST /admin/earnings/seed`  + `GET /admin/earnings?symbol=` + `DELETE /admin/earnings/:id` | `earnings_calendar` 編集 (BUY 凍結窓のソース)。 | #196 1/3 / #211 |
| `POST /admin/macro-events/seed` + `GET /admin/macro-events?from=&to=&type=` + `DELETE /admin/macro-events/:id` | `macro_event_calendar` 編集 (FOMC/CPI/NFP 凍結ソース)。 | #196 2/3 / #212 |

cURL 例:

```sh
# 戦略 cron を即実行 (dry_run 中の動作確認)
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST "$WORKER_URL/admin/strategy/run"

# split-brain 修復 sweep (lookback 外も)
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST \
  "$WORKER_URL/admin/orders/reconcile?retryStateApply=1"

# repair backlog 件数だけ
curl -u "$ADMIN_USER:$ADMIN_PASS" "$WORKER_URL/admin/orders/repair-status"

# AAPL の 2026 Q2 earnings を 1 件 seed
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST \
  -H 'content-type: application/json' \
  -d '[{"symbol":"AAPL","earnings_date":"2026-04-30","notes":"Q2"}]' \
  "$WORKER_URL/admin/earnings/seed"

# 6 月 FOMC を seed
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST \
  -H 'content-type: application/json' \
  -d '[{"event_type":"FOMC","event_date":"2026-06-17","event_time":"14:00","notes":"June FOMC"}]' \
  "$WORKER_URL/admin/macro-events/seed"

# offline backtest (1 銘柄分、計算のみ)
curl -u "$ADMIN_USER:$ADMIN_PASS" \
  "$WORKER_URL/admin/backtest?symbol=SOXL&from=2025-01-01&to=2025-12-31"
```

## Dashboard 索引

すべて Basic 認証 (operator)。

| URL | 主に何が見えるか |
|---|---|
| `/dashboard` | ホーム (各ページ概要のリンク集) |
| `/dashboard/positions` | 全銘柄の SymbolStateDO (保有 / 平均取得単価 / 未約定 / cooldown) と直近 strategy 価格 |
| `/dashboard/portfolio` | PortfolioStateDO (`dailyStartEquity` / `dailyRealizedPnl` / drawdown / `lastRolledAt` / kill-switch) |
| `/dashboard/trades?limit=N` | `trade_journal` 直近 (default 50、最大 200) |
| `/dashboard/config` | `global_config` 1 行 + `symbol_config` (有効銘柄 + advisory 詳細) |
| `/dashboard/cron` | `strategy_decision_log` (最新 cron fire 全銘柄)。`?symbol=` / `?requestId=` / `?decisionId=` で絞り込み |
| `/dashboard/cron/json?requestId=` | 同データを JSON で export (CodeRabbit 共有 / 解析用) |
| `/dashboard/charts?tab=overview` | エクイティカーブ + drawdown |
| `/dashboard/charts?tab=quality` | PnL 分布 + 統計 + Decision breakdown (BUY/SELL/HOLD/REJECT/ERROR) |
| `/dashboard/charts?tab=symbol&symbol=` | 個別銘柄: candle + SMA50 + 線形回帰 trend + entry/exit pin + position lines (TP/stop/avg) |
| `/dashboard/charts?tab=grid` | ALLOWED_SYMBOLS を 4 列 grid (全 panel dataZoom 同期) |
| `/dashboard/alerts` | `notification_emit_log` 直近。`?severity=critical,warning` / `?eventType=ERROR` / `?limit=N` で絞り込み (severity と eventType は AND で組む) |

## 関連リンク

- `docs/db-operations.md` — D1 直編集 (`global_config` / `symbol_config` / `inverse_pairs` / 通貨別 cap) のレシピ。
- 通知 spec: `src/infrastructure/notification/Notifier.ts` (`NotificationEvent` / `NotificationSeverity` の定義)。
- 通知ログ schema: `src/infrastructure/db/schema.ts` の `notificationEmitLog` (table 名 `notification_emit_log`)。
- 関連 issue: #141 (alerts emit + dashboard view) / #199 (webhook notifier) / #208 (本 runbook)。
