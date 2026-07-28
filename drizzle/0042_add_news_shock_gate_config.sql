ALTER TABLE `global_config` ADD `news_shock_mode` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `news_shock_warn_ratio` real DEFAULT 2.3 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `news_shock_block_ratio` real DEFAULT 4.4 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `news_shock_warn_size_scale` real DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `news_shock_tone_drop_threshold` real DEFAULT 1.5 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `news_shock_require_tone` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `news_shock_baseline_days` integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `news_shock_min_samples` integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `news_shock_window_min` integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `news_shock_max_age_min` integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `attention_stale_policy` text DEFAULT 'fail_open' NOT NULL;