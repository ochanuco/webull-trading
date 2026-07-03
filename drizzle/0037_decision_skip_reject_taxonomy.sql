-- Decision 3値タクソノミ (data-only migration、schema 変更なし):
--   SKIP   = bot 内部ゲートで見送り (broker 未到達) — 旧 REJECT の全ケース
--   REJECT = broker が注文を確定拒否 (HTTP 4xx: 417 SELL_SHORT / TICKER_IS_DENY 等)
--   ERROR  = それ以外の失敗 (5xx / ネットワーク断 / 想定外の例外)
--
-- 判定は内容ベースで冪等:
--   (1) 旧 REJECT (内部ゲート見送り) → SKIP。新分類の REJECT (broker 拒否) は
--       reason が必ず `broker submit error: ` で始まるので除外する。旧 REJECT の
--       reason prefix は risk:/sizing/role:/insufficient bars のみ (本番実データで
--       全件確認済) なので、この guard により新コード先行稼働後の再実行も安全。
--   (2) 旧 ERROR のうち broker 4xx 確定拒否 → REJECT。WebullHttpClient が 4xx を
--       即時 throw する唯一の message 形式 (`... failed permanently with status
--       4xx:`) に限定。5xx/retry 尽きは `failed after N attempts ...`、ネットワーク
--       断は別 message で、いずれも一致しない (= ERROR のまま残る)。
--
-- 長い LIKE パターンは D1 の SQLITE_LIMIT_LIKE_PATTERN_LENGTH (50 bytes) を超えて
-- `LIKE or GLOB pattern too complex` になるため (staging 適用失敗で実証)、
-- substr() の等値比較で prefix match する。長さは prefix 文字列の実長:
--   'broker submit error: ' = 21 chars
--   'broker submit error: Webull request failed permanently with status 4' = 68 chars
UPDATE strategy_decision_log SET decision = 'SKIP'
  WHERE decision = 'REJECT'
    AND COALESCE(substr(reason, 1, 21), '') != 'broker submit error: ';--> statement-breakpoint
UPDATE strategy_decision_log SET decision = 'REJECT'
  WHERE decision = 'ERROR'
    AND substr(reason, 1, 68) = 'broker submit error: Webull request failed permanently with status 4';
