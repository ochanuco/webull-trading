CREATE TABLE `portfolio_equity_snapshot` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_at` text NOT NULL,
	`daily_start_equity_usd` real,
	`daily_start_equity_jpy` real,
	`daily_realized_pnl_usd` real,
	`daily_realized_pnl_jpy` real,
	`drawdown_pct` real,
	`request_id` text
);
--> statement-breakpoint
CREATE INDEX `portfolio_equity_snapshot_at_idx` ON `portfolio_equity_snapshot` (`snapshot_at`);