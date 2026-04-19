-- 初期 symbol_config seed。現 ALLOWED_SYMBOLS / SYMBOL_MAX_NOTIONAL を反映した最小構成。
-- 使い方: wrangler d1 execute webull-trading-staging --env=staging --remote --file=docs/seed/symbol_config.sql

INSERT INTO symbol_config (symbol, market, active, max_notional, updated_at) VALUES
  ('SOXL', 'US', 1, NULL, '2026-04-19T00:00:00.000Z'),
  ('SOXS', 'US', 1, NULL, '2026-04-19T00:00:00.000Z');

-- 3x ETF の逆相関ペア
INSERT INTO inverse_pairs (symbol, inverse, updated_at) VALUES
  ('SOXL', 'SOXS', '2026-04-19T00:00:00.000Z');
