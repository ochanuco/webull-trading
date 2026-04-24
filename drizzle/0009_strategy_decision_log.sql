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
