ALTER TABLE `global_config` ADD `atr_baseline_mode` text DEFAULT 'percentile' NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` DROP COLUMN `atr_baseline_exclude_recent`;