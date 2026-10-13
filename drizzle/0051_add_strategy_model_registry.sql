CREATE TABLE `backtest_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_id` integer NOT NULL,
	`purpose` text NOT NULL,
	`symbols_json` text NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text NOT NULL,
	`initial_cash_usd` real NOT NULL,
	`initial_cash_jpy` real NOT NULL,
	`bar_source` text NOT NULL,
	`metrics_json` text NOT NULL,
	`per_symbol_json` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`request_id` text
);
--> statement-breakpoint
CREATE INDEX `backtest_run_model_id_idx` ON `backtest_run` (`model_id`,`id`);--> statement-breakpoint
CREATE TABLE `model_deployment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_id` integer NOT NULL,
	`env` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`evidence_run_ids_json` text NOT NULL,
	`gate_json` text NOT NULL,
	`request_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_deployment_active_env_unique` ON `model_deployment` (`env`) WHERE "model_deployment"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX `model_deployment_env_started_idx` ON `model_deployment` (`env`,`started_at`);--> statement-breakpoint
CREATE TABLE `strategy_model` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`params_json` text NOT NULL,
	`params_hash` text NOT NULL,
	`label` text NOT NULL,
	`note` text,
	`parent_model_id` integer,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_model_params_hash_unique` ON `strategy_model` (`params_hash`);