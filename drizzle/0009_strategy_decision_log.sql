CREATE TABLE `strategy_decision_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` text NOT NULL,
	`request_id` text,
	`symbol` text NOT NULL,
	`decision` text NOT NULL,
	`reason` text,
	`price` real,
	`indicators_json` text
);
--> statement-breakpoint
CREATE INDEX `strategy_decision_log_symbol_id_idx` ON `strategy_decision_log` (`symbol`,`id`);