-- Runtime kill-switch toggle history (issue #276)。`global_config.trading_enabled`
-- は singleton で「現在値」、こちらは append-only で「いつ誰が何故 ON/OFF にしたか」
-- を残す。full audit log は #274 で別途扱う想定なので、ここでは kill-switch の
-- before/after/reason に絞る最小スキーマ。0013/0014/0015 同様に新規 table の
-- CREATE のみで global_config は触らない (drizzle-kit が `__new_global_config`
-- 経由で全列リビルドを提案してくるが副作用が大きいので avoid)。
CREATE TABLE `trading_toggle_history` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `timestamp` text NOT NULL,
  `actor` text,
  `before` integer,
  `after` integer NOT NULL,
  `reason` text NOT NULL,
  `request_id` text
);
