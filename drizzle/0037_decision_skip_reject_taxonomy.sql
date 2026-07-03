-- Decision 3値タクソノミ (data-only migration、schema 変更なし):
--   SKIP   = bot 内部ゲートで見送り (broker 未到達) — 旧 REJECT の全ケース
--   REJECT = broker が注文を確定拒否 (HTTP 4xx: 417 SELL_SHORT / TICKER_IS_DENY 等)
--   ERROR  = それ以外の失敗 (5xx / ネットワーク断 / 想定外の例外)
--
-- 順序が重要: (1) を先に流さないと、(2) で作った新 REJECT 行が (1) に巻き込まれて
-- SKIP に潰される。
--
-- (2) の reason パターンは WebullHttpClient が 4xx を即時 throw する唯一の message
-- 形式 (`Webull request failed permanently with status 4xx: <body>`) に
-- pullbackScheduler が `broker submit error: ` prefix を付けたもの。5xx / retry 尽き
-- は `failed after N attempts ...`、ネットワーク断は `Webull order placement
-- failed: ...` で、いずれもこの LIKE には一致しない (= ERROR のまま残る)。
UPDATE strategy_decision_log SET decision = 'SKIP' WHERE decision = 'REJECT';--> statement-breakpoint
UPDATE strategy_decision_log SET decision = 'REJECT'
  WHERE decision = 'ERROR'
    AND reason LIKE 'broker submit error: Webull request failed permanently with status 4%';
