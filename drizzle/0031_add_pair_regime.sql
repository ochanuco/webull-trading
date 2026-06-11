ALTER TABLE `global_config` ADD `pair_regime_mode` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `pair_regime_theta_bull_enter` real DEFAULT 0.03 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `pair_regime_theta_bull_exit` real DEFAULT 0.01 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `pair_regime_theta_bear_enter` real DEFAULT -0.04 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `pair_regime_theta_bear_exit` real DEFAULT -0.015 NOT NULL;--> statement-breakpoint
ALTER TABLE `inverse_pairs` ADD `regime_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `inverse_pairs` ADD `regime_proxy_symbol` text;--> statement-breakpoint
ALTER TABLE `inverse_pairs` ADD `regime_bull_symbol` text;