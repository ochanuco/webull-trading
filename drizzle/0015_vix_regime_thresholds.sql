-- VIX regime filter (issue #196 3/3) — global_config に VIX 閾値 / size 縮小率を追加。
-- earnings (0013) / macro (0014) gate と異なり VIX は **size scaling 系** なので、
-- 専用 table は持たず global_config に閾値だけ生やす。
-- - vix_warning_threshold:  VIX > これで size を `vix_warning_size_scale` 倍に
-- - vix_critical_threshold: VIX > これで BUY 全停止 (sizeScale=0)
-- - vix_warning_size_scale: warning 領域の size 倍率 (default 0.5)
--
-- SQLite は ALTER TABLE ADD COLUMN で CHECK 制約を直接付けられないため、
-- range / order 制約は schema.ts 側で宣言し、DB 制約は global_config の
-- 次回 table-rebuild migration (将来) でまとめて流す方針。本 migration では
-- column 追加と default のみ。0007_add_risk_scale_params.sql のような
-- table-rebuild は schema 全体の再生成が必要で副作用が大きいので避ける。
ALTER TABLE `global_config` ADD COLUMN `vix_warning_threshold` REAL NOT NULL DEFAULT 25.0;
--> statement-breakpoint
ALTER TABLE `global_config` ADD COLUMN `vix_critical_threshold` REAL NOT NULL DEFAULT 30.0;
--> statement-breakpoint
ALTER TABLE `global_config` ADD COLUMN `vix_warning_size_scale` REAL NOT NULL DEFAULT 0.5;
