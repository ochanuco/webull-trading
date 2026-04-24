ALTER TABLE `strategy_decision_log` ADD `client_order_id` text;--> statement-breakpoint
CREATE INDEX `strategy_decision_log_coid_idx` ON `strategy_decision_log` (`client_order_id`);