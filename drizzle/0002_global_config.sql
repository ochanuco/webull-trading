CREATE TABLE `global_config` (
	`id` text PRIMARY KEY NOT NULL,
	`dry_run` integer DEFAULT true NOT NULL,
	`trading_enabled` integer DEFAULT false NOT NULL,
	`market_hours_check` integer DEFAULT false NOT NULL,
	`max_order_notional` real DEFAULT 100 NOT NULL,
	`drawdown_kill_threshold` real DEFAULT -0.02 NOT NULL,
	`stale_quote_ms` integer DEFAULT 900000 NOT NULL,
	`gap_reject_pct` real DEFAULT 0.03 NOT NULL,
	`spread_limit_pct_us` real DEFAULT 0.0025 NOT NULL,
	`spread_limit_pct_jp` real DEFAULT 0.006 NOT NULL,
	`bridge_run_mode` text DEFAULT 'auto' NOT NULL,
	`updated_at` text NOT NULL
);
