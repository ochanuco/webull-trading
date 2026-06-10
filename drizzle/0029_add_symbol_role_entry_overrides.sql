ALTER TABLE `symbol_config` ADD `role` text;--> statement-breakpoint
ALTER TABLE `symbol_config` ADD `pullback_max_override` real;--> statement-breakpoint
ALTER TABLE `symbol_config` ADD `pullback_min_override` real;--> statement-breakpoint
ALTER TABLE `symbol_config` ADD `min_return_50d_override` real;--> statement-breakpoint
ALTER TABLE `symbol_config` ADD `max_atr_ratio_override` real;--> statement-breakpoint
ALTER TABLE `symbol_config` ADD `max_sma50_deviation_pct_override` real;--> statement-breakpoint
ALTER TABLE `symbol_config` ADD `require_above_sma50_override` integer;--> statement-breakpoint
ALTER TABLE `symbol_config` ADD `alternatives` text;