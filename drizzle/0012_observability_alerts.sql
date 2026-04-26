CREATE TABLE `config_state_snapshot` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`snapshot_at` text NOT NULL,
	`request_id` text
);
--> statement-breakpoint
CREATE TABLE `notification_emit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` text NOT NULL,
	`request_id` text,
	`event_type` text NOT NULL,
	`severity` text NOT NULL,
	`symbol` text,
	`cause` text,
	`message` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_emit_log_timestamp_id_idx` ON `notification_emit_log` (`timestamp`,`id`);--> statement-breakpoint
CREATE INDEX `notification_emit_log_severity_timestamp_id_idx` ON `notification_emit_log` (`severity`,`timestamp`,`id`);--> statement-breakpoint
CREATE INDEX `notification_emit_log_event_type_timestamp_id_idx` ON `notification_emit_log` (`event_type`,`timestamp`,`id`);
