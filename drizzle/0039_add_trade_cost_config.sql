ALTER TABLE `global_config` ADD `fee_pct_of_notional` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `fee_fixed_per_order` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trade_journal` ADD `estimated_cost` real;