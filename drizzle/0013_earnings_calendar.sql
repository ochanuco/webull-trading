CREATE TABLE `earnings_calendar` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`earnings_date` text NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `earnings_calendar_symbol_date_unique` ON `earnings_calendar` (`symbol`,`earnings_date`);
