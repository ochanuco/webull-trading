CREATE TABLE `inverse_pairs` (
	`symbol` text PRIMARY KEY NOT NULL,
	`inverse` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symbol_config` (
	`symbol` text PRIMARY KEY NOT NULL,
	`name` text,
	`market` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`max_notional` real,
	`notes` text,
	`updated_at` text NOT NULL
);
