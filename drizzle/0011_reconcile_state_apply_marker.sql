ALTER TABLE `trade_journal` ADD `state_applied_at` text;--> statement-breakpoint
ALTER TABLE `trade_journal` ADD `state_apply_error` text;--> statement-breakpoint
ALTER TABLE `trade_journal` ADD `state_apply_attempts` integer DEFAULT 0 NOT NULL;
