# 戦略モデルの検証・昇格・リプレイ

アルゴリズムとパラメタの組を **モデル** として登録し、過去データで検証して、基準を満たしたものだけを本番設定に昇格する仕組み。昇格した後も、過去に稼働していたモデルを同じ期間でリプレイし、「旧モデルのままだったらどうなっていたか」を比較できる。

実発注の経路 (Strategy → Risk → Execution) は一切変えない。昇格で書き換わるのは `global_config` の `pullback_default_*` と `atr_baseline_mode` だけで、`dry_run` / `trading_enabled` には触れない。

## フロー

```
登録 ──▶ 検証 (in_sample / out_of_sample) ──▶ 昇格ゲート ──▶ 昇格 ──▶ リプレイで継続比較
 POST /admin/models   POST /admin/models/:id/backtest   GET …/gate   POST …/promote   /dashboard/models
```

1. **登録**: `POST /admin/models`
   - 新しいモデル: `{"kind":"pullback_uptrend","params":{…全キー…},"label":"tp8"}`
   - 現行の本番設定をベースラインとして登録: `{"fromGlobalConfig":true,"label":"baseline"}`
   - パラメタは全キー必須。未知のキーは 400。同じパラメタを再登録すると既存の行を返す (200)
2. **検証**: `POST /admin/models/:id/backtest`
   - `{"purpose":"in_sample","from":"2022-01-01","to":"2024-12-31"}` でパラメタを決めた期間の結果を、`{"purpose":"out_of_sample","from":"2025-01-01","to":"2025-12-31"}` で確認期間の結果を記録する
   - `symbols` を省略すると有効銘柄すべて。日足は Yahoo (`/admin/backtest` と同じ)
3. **ゲートの事前確認**: `GET /admin/models/:id/gate`
4. **昇格**: `POST /admin/models/:id/promote` に `{"reason":"…","confirm":true}`
   - ゲートを通過していなければ 409 (`promotion_gate_failed`)。理由ごとのチェック結果が返る
   - `global_config` の書き換え・旧デプロイの終了・新デプロイの記録を 1 つの D1 batch で行う。途中で失敗したら全部巻き戻る
   - `config_audit_log` に before/after を記録する
   - パラメタが現在の `global_config` と完全に一致するモデルは、ゲートなしで昇格できる (理由に `[adopt]` が付く)。本番の挙動は何も変わらないため。現行設定を最初のベースラインとして追跡し始めるときに使う
5. **ロールバック**: `{"reason":"…","confirm":true,"rollback":true}`
   - **この環境で過去に稼働したモデルに限り**、ゲートを免除する。一度も稼働していないモデルには使えない (409 `rollback_not_allowed`)
6. **継続比較**: `/dashboard/models` (レビュー → モデル比較)、または `GET /admin/models/replay`
   - 既定では、この環境で一度でも稼働したモデルをすべて、最初の昇格日から今日までリプレイする
   - グラフには各モデルの資産推移と昇格日の縦線が出る

## 昇格ゲート

最新の `out_of_sample` 検証 1 件を根拠に判定する。閾値はコードに固定している (`src/trading/models/promotionGate.ts`)。リクエストで緩められるようにすると、それ自体が抜け道になるため。

| チェック | 基準 |
|---|---|
| `oos_run_exists` | out_of_sample の検証が 1 件以上ある |
| `evidence_fresh` | その検証が 30 日以内 |
| `min_trades` | 取引数 ≥ 20 |
| `profit_factor` | PF ≥ 1.2 (損失取引ゼロは判定不能として不合格) |
| `total_return` | リターン > 0 |
| `max_drawdown` | 最大ドローダウン ≥ -25% |
| `oos_after_in_sample` | in_sample の期間より後の期間で確認している (in_sample の記録がある場合のみ) |
| `oos_sharpe_retention` | 確認期間の Sharpe ≥ パラメタを決めた期間の Sharpe × 0.5 (過剰最適化の検出) |
| `beats_active_model` | 稼働中モデルに同じ期間・銘柄の検証があれば、その Sharpe 以上 |

該当しないチェック (例: in_sample の記録がない) は `passed: null` になり、合否には影響しない。

## データモデル (D1, migration `0051`)

| テーブル | 役割 |
|---|---|
| `strategy_model` | モデル定義。`kind` + 全パラメタ (`params_json`)。**作成後は更新しない**。`params_hash` (sha256) が unique で重複登録を防ぐ。`parent_model_id` で派生元を記録 |
| `backtest_run` | 検証結果。期間・銘柄・初期資金 (USD / JPY 別)・集計指標・銘柄別指標。資産推移は保存せず、リプレイで再計算する (同じ日足なら結果は決定的) |
| `model_deployment` | 昇格履歴。`env` (worker の `ENVIRONMENT`) ごとに `ended_at IS NULL` の行が稼働中モデル。部分 unique index で、同じ環境に稼働中が 2 行できないことを DB 側でも保証 |

- `env` はリクエストからは受け取らず、worker 自身の `ENVIRONMENT` を使う。staging の worker が production の昇格を記録することはできない
- `GET /admin/models` の `driftKeys` は、昇格後に `global_config` が手で書き換えられたキー。空でなければ、稼働中モデルのリプレイは本番の挙動と一致しない

## リプレイの前提 (結果を読むときの注意)

- 日足の終値で判断・約定する簡易シミュレーション (`runBacktest` と同じ)。`decide()` は本番と同じコードを呼ぶ
- **再現しないもの**: サイズ計算 (risk-% / 予算配分)、VIX・決算・マクロ・ニュースなどのゲート、銘柄別の `symbol_config` 上書き、再エントリーガード、手数料。本番より甘い結果になる
- 複数銘柄は「銘柄ごとに同額で始めた場合の平均」で合算する。USD と JPY を足さないため、指標はリターンベース (PF も取引ごとのリターンで計算)
- 1 リクエストで比較するモデルは最大 10、銘柄は最大 30、期間は日足が取れる約 5 年まで
- `breakout_momentum` は検証・比較はできるが、本番の scheduler が使っていないので昇格はできない (409 `not_promotable`)

## 例: 新しいパラメタを試して昇格する

```bash
# 1) 現行設定をベースラインとして登録 → id=1、稼働中モデルとして記録 (設定は変わらない)
curl -X POST …/admin/models -d '{"fromGlobalConfig":true,"label":"baseline"}'
curl -X POST …/admin/models/1/promote -d '{"reason":"現行設定の追跡開始","confirm":true}'
# 2) 候補を登録 → id=2
curl -X POST …/admin/models -d '{"kind":"pullback_uptrend","label":"tp8","parentModelId":1,"params":{…}}'
# 3) 両方を同じ期間で検証 (ベースラインも同じ期間で検証すると beats_active_model が効く)
for id in 1 2; do
  curl -X POST …/admin/models/$id/backtest -d '{"purpose":"out_of_sample","from":"2025-01-01","to":"2025-12-31"}'
done
# 4) ゲート確認 → 昇格
curl …/admin/models/2/gate
curl -X POST …/admin/models/2/promote -d '{"reason":"OOS で PF 1.6","confirm":true}'
```
