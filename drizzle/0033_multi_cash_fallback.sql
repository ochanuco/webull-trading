ALTER TABLE `symbol_config` ADD `cash_fallback_symbols` text;--> statement-breakpoint
UPDATE `symbol_config` SET `cash_fallback_symbols` = json_array(`cash_fallback_symbol`) WHERE `cash_fallback_symbol` IS NOT NULL;
