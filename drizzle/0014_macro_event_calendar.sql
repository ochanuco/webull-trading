CREATE TABLE `macro_event_calendar` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`event_date` text NOT NULL,
	`event_time` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `macro_event_calendar_type_date_unique` ON `macro_event_calendar` (`event_type`,`event_date`);--> statement-breakpoint
CREATE INDEX `macro_event_calendar_date_idx` ON `macro_event_calendar` (`event_date`);
