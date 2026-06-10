ALTER TABLE `global_config` ADD `cash_fallback_orders_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `symbol_config` ADD `entry_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `symbol_config` ADD `always_active` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `symbol_config` ADD `cash_fallback_symbol` text;