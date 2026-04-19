-- Singleton global_config row。運用者が UPDATE で runtime に切り替える。
-- 使い方: wrangler d1 execute webull-trading-staging --env=staging --remote --file=docs/seed/global_config.sql

INSERT INTO global_config (
  id, dry_run, trading_enabled, market_hours_check,
  max_order_notional, drawdown_kill_threshold,
  stale_quote_ms, gap_reject_pct,
  spread_limit_pct_us, spread_limit_pct_jp,
  bridge_run_mode, updated_at
) VALUES (
  'default', 1, 0, 0,
  100, -0.02,
  900000, 0.03,
  0.0025, 0.006,
  'auto', '2026-04-19T00:00:00.000Z'
);
