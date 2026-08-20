CREATE TABLE `extended_hours_observation` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`captured_at` text NOT NULL,
	`session_ymd` text NOT NULL,
	`status` text NOT NULL,
	`pre_market_last` real,
	`pre_market_low` real,
	`prev_close` real,
	`gap_pct` real,
	`direction_15m_pct` real,
	`to_stop_pct` real,
	`last_bar_at` text,
	`freshness_sec` integer,
	`request_id` text
);
--> statement-breakpoint
CREATE INDEX `extended_hours_observation_symbol_id_idx` ON `extended_hours_observation` (`symbol`,`id`);