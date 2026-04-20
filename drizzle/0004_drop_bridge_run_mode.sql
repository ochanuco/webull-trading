PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_global_config` (
	`id` text PRIMARY KEY NOT NULL,
	`dry_run` integer DEFAULT true NOT NULL,
	`trading_enabled` integer DEFAULT false NOT NULL,
	`market_hours_check` integer DEFAULT false NOT NULL,
	`max_order_notional` real DEFAULT 100 NOT NULL,
	`max_order_notional_usd` real DEFAULT 2000 NOT NULL,
	`max_order_notional_jpy` real DEFAULT 100000 NOT NULL,
	`total_capital_usd` real,
	`total_capital_jpy` real,
	`max_portfolio_exposure_pct` real DEFAULT 0.6 NOT NULL,
	`drawdown_kill_threshold` real DEFAULT -0.02 NOT NULL,
	`stale_quote_ms` integer DEFAULT 900000 NOT NULL,
	`gap_reject_pct` real DEFAULT 0.03 NOT NULL,
	`spread_limit_pct_us` real DEFAULT 0.0025 NOT NULL,
	`spread_limit_pct_jp` real DEFAULT 0.006 NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "global_config_max_order_notional_range" CHECK("__new_global_config"."max_order_notional" > 0 AND "__new_global_config"."max_order_notional" <= 10000000),
	CONSTRAINT "global_config_max_order_notional_usd_range" CHECK("__new_global_config"."max_order_notional_usd" > 0 AND "__new_global_config"."max_order_notional_usd" <= 1000000),
	CONSTRAINT "global_config_max_order_notional_jpy_range" CHECK("__new_global_config"."max_order_notional_jpy" > 0 AND "__new_global_config"."max_order_notional_jpy" <= 100000000),
	CONSTRAINT "global_config_total_capital_usd_range" CHECK("__new_global_config"."total_capital_usd" IS NULL OR "__new_global_config"."total_capital_usd" > 0),
	CONSTRAINT "global_config_total_capital_jpy_range" CHECK("__new_global_config"."total_capital_jpy" IS NULL OR "__new_global_config"."total_capital_jpy" > 0),
	CONSTRAINT "global_config_max_portfolio_exposure_pct_range" CHECK("__new_global_config"."max_portfolio_exposure_pct" > 0 AND "__new_global_config"."max_portfolio_exposure_pct" <= 1),
	CONSTRAINT "global_config_drawdown_kill_threshold_range" CHECK("__new_global_config"."drawdown_kill_threshold" >= -1 AND "__new_global_config"."drawdown_kill_threshold" <= 0),
	CONSTRAINT "global_config_stale_quote_ms_range" CHECK("__new_global_config"."stale_quote_ms" >= 0),
	CONSTRAINT "global_config_gap_reject_pct_range" CHECK("__new_global_config"."gap_reject_pct" >= 0 AND "__new_global_config"."gap_reject_pct" <= 1),
	CONSTRAINT "global_config_spread_limit_pct_us_range" CHECK("__new_global_config"."spread_limit_pct_us" >= 0 AND "__new_global_config"."spread_limit_pct_us" <= 1),
	CONSTRAINT "global_config_spread_limit_pct_jp_range" CHECK("__new_global_config"."spread_limit_pct_jp" >= 0 AND "__new_global_config"."spread_limit_pct_jp" <= 1)
);
--> statement-breakpoint
INSERT INTO `__new_global_config`("id", "dry_run", "trading_enabled", "market_hours_check", "max_order_notional", "max_order_notional_usd", "max_order_notional_jpy", "total_capital_usd", "total_capital_jpy", "max_portfolio_exposure_pct", "drawdown_kill_threshold", "stale_quote_ms", "gap_reject_pct", "spread_limit_pct_us", "spread_limit_pct_jp", "updated_at") SELECT "id", "dry_run", "trading_enabled", "market_hours_check", "max_order_notional", "max_order_notional_usd", "max_order_notional_jpy", "total_capital_usd", "total_capital_jpy", "max_portfolio_exposure_pct", "drawdown_kill_threshold", "stale_quote_ms", "gap_reject_pct", "spread_limit_pct_us", "spread_limit_pct_jp", "updated_at" FROM `global_config`;--> statement-breakpoint
DROP TABLE `global_config`;--> statement-breakpoint
ALTER TABLE `__new_global_config` RENAME TO `global_config`;--> statement-breakpoint
PRAGMA foreign_keys=ON;