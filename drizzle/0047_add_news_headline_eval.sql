CREATE TABLE `news_headline_eval` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`evaluated_at` text NOT NULL,
	`source` text NOT NULL,
	`query` text NOT NULL,
	`headline_count` integer NOT NULL,
	`headlines_json` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`model` text,
	`shock` real,
	`direction` text,
	`direction_confidence` real,
	`severity` real,
	`severity_confidence` real,
	`scope` text,
	`scope_confidence` real,
	`answers_json` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`latency_ms` integer,
	`request_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `news_headline_eval_source_evaluated_at_unique` ON `news_headline_eval` (`source`,`evaluated_at`);