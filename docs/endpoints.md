# Endpoints

auth 列の `Access` は Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` 検証、#29)。admin は数が多いので代表のみ — 全量は `src/routes/admin.ts` / `src/routes/dashboard/index.ts` を参照。

| method | path | auth | 概要 |
|---|---|---|---|
| GET | `/health` | none | `{status, timestamp}` |
| POST | `/trade/decide` | Access | Signal + OrderIntent + RiskDecision を返す (発注しない) |
| POST | `/trade/execute` | Access | 上記 + ExecutionResult (`dry_run=1` で Mock、0 で Webull) |
| POST | `/webull/order/place` | Access | 低レベル疎通用 (`dry_run=1` で synthetic response、`dry_run=0` は 403 で拒否。実発注は `/trade/execute` か `/admin/strategy/run` 経由) |
| GET | `/admin/production-readiness` | Access | 本番 gate 解除前の fail-closed preflight (#379) |
| POST | `/admin/strategy/run` | Access | `runStrategyCron` 手動 trigger (cron を待たず試走) |
| POST | `/admin/trading/toggle` | Access | `trading_enabled` の切替 (履歴を `trading_toggle_history` に記録) |
| POST | `/admin/orders/{reconcile,sync-holdings}` | Access | `reconcileFills` / broker 保有との同期を手動 trigger |
| GET | `/admin/orders/:clientOrderId` | Access | Webull order history を client_order_id で検索 |
| GET | `/admin/orders/repair-status` | Access | `pendingApply` 件数だけ返す軽量 query |
| POST | `/admin/portfolio/{seed-equity,roll-daily,seed-exposure}` | Access | equity 初期化 / EOD rollover / exposure 投入 |
| POST | `/admin/symbol-config/...` | Access | 銘柄の追加 / 更新 / active 切替 / 予算配分 / 取扱可否チェック |
| POST | `/admin/webull-token/{seed,refresh}` | Access | `x-access-token` の DO への投入 / 更新 |
| GET/POST/DELETE | `/admin/{earnings,macro-events}` | Access | イベントカレンダーの参照 / 投入 / 削除 |
| GET | `/admin/backtest` | Access | offline backtest (Yahoo daily bars + 戦略 rule、実発注なし) |
| GET | `/admin/backtest/compare` | Access | 一括投入 vs 段階エントリーの比較 backtest (同一 bars/rule/コスト、実発注なし) |
| GET | `/dashboard` | Access | read-only ランディング (資産サマリ / KPI / equity / 保有 / 直近取引) |
| GET | `/dashboard/{positions,portfolio,trades,config,cron,charts,symbols,events,alerts,audit,broker-probe,webull-token,extended-hours,lifecycle}` | Access | DO / D1 snapshot を HTML で可視化 |
| GET | `/dashboard/{positions,trades,cron,charts/symbol,lifecycle}/json` | Access | 同 packet の JSON 版 |
| GET/POST/DELETE | `/mcp` | Access (service token) | read-only MCP server。dashboard と同一 packet を tool として公開 (#553) |

ブラウザ外から叩くときは `cloudflared access curl` を使う (Access のログインセッションを流用する。service token は本体 application 側で 302 になるため不可)。調査用クエリ集は [`review-queries.md`](review-queries.md)。
