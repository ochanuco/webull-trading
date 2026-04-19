-- Singleton global_config row。運用者が UPDATE で runtime に切り替える。
-- 使い方: wrangler d1 execute webull-trading-staging --env=staging --remote --file=docs/seed/global_config.sql
--
-- Phase E (#76) で通貨別 max_order_notional_{usd,jpy} と total_capital /
-- max_portfolio_exposure_pct カラムを追加。旧 max_order_notional は
-- deprecated だが NOT NULL 維持のため 100 で埋める (gate では未参照)。

INSERT INTO global_config (
  id, dry_run, trading_enabled, market_hours_check,
  max_order_notional, max_order_notional_usd, max_order_notional_jpy,
  total_capital_usd, total_capital_jpy, max_portfolio_exposure_pct,
  drawdown_kill_threshold,
  stale_quote_ms, gap_reject_pct,
  spread_limit_pct_us, spread_limit_pct_jp,
  bridge_run_mode, updated_at
) VALUES (
  'default', 1, 0, 0,
  100,           -- max_order_notional (deprecated placeholder)
  2000,          -- max_order_notional_usd
  100000,        -- max_order_notional_jpy (¥10万)
  NULL, NULL,    -- total_capital_{usd,jpy} は operator 側で後から seed
  0.6,           -- max_portfolio_exposure_pct (exposure tracking は follow-up で有効化)
  -0.02,
  900000, 0.03,
  0.0025, 0.006,
  'auto', '2026-04-20T00:00:00.000Z'
);
