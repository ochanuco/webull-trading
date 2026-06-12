CREATE TABLE `tradable_instrument` (
	`symbol` text PRIMARY KEY NOT NULL,
	`instrument_id` text,
	`name` text,
	`currency` text,
	`exchange_code` text,
	`currently_tradable` integer DEFAULT true NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tradable_instrument_currently_idx` ON `tradable_instrument` (`currently_tradable`);