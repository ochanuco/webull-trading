CREATE TABLE `config_audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` text NOT NULL,
	`actor` text NOT NULL,
	`endpoint` text NOT NULL,
	`target_key` text,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`request_id` text
);
--> statement-breakpoint
CREATE INDEX `config_audit_log_timestamp_id_idx` ON `config_audit_log` (`timestamp`,`id`);--> statement-breakpoint
CREATE INDEX `config_audit_log_actor_timestamp_id_idx` ON `config_audit_log` (`actor`,`timestamp`,`id`);--> statement-breakpoint
CREATE INDEX `config_audit_log_endpoint_timestamp_id_idx` ON `config_audit_log` (`endpoint`,`timestamp`,`id`);
