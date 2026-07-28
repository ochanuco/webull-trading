CREATE TABLE `attention_observation` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`probe_key` text NOT NULL,
	`metric` text NOT NULL,
	`bucket_at` text NOT NULL,
	`value` real NOT NULL,
	`fetched_at` text NOT NULL,
	`request_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attention_observation_source_probe_metric_bucket_unique` ON `attention_observation` (`source`,`probe_key`,`metric`,`bucket_at`);