-- Per-symbol strategy override columns (issue #316)。NULL = global_config の
-- pullback default を使う (fall-through)、値があれば SymbolRule build 時に override。
-- 3x leveraged ETF (SOXL / 1570 等) で短い hold / 緩い ATR stop を効かせる用途。
--
-- drizzle-kit は table rebuild SQL を提案してくるが、(1) MAX_TIME_STOP_DAYS が
-- bind parameter として `?` で emit されて apply 不能、(2) 全列 rebuild は
-- 既存 symbol_config 行の整合性 risk が高い、ので ALTER TABLE ADD COLUMN
-- (SQLite ≥ 3.25, D1 OK) で additive に運用する。CHECK 制約は column 単位で
-- ADD COLUMN に同梱可。0017 と同じ「additive only」方針。
ALTER TABLE `symbol_config` ADD COLUMN `time_stop_days_override` integer CHECK(`time_stop_days_override` IS NULL OR (`time_stop_days_override` >= 1 AND `time_stop_days_override` <= 365));--> statement-breakpoint
ALTER TABLE `symbol_config` ADD COLUMN `k_atr_override` real CHECK(`k_atr_override` IS NULL OR (`k_atr_override` >= 0.5 AND `k_atr_override` <= 5.0));
