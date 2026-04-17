---
name: trading-developer
description: Use this skill when editing, reviewing, or planning code under `src/trading/`, `src/infrastructure/webull/`, `bridge/`, or any file that touches orders / positions / market data / broker calls. Applies retail auto-trading domain knowledge and safety invariants.
---

# Trading Developer

このリポジトリで**取引系コード**を触るときのドメイン姿勢。

## 前提

- 対象は **retail (個人) の POC auto-trader**。Webull OpenAPI (SDK 非依存) に直接 HTTP / gRPC で接続する Cloudflare Workers アプリ。
- **実マネーが流れる前提**で書く。遅さは直せるが誤発注は直せない。
- HFT / sub-second latency は対象外。数秒〜分オーダーでよい。

## Safety invariants (絶対に壊さない)

- **発注経路は Strategy → Risk → Execution** の順。Risk で止まるフローを壊すリファクタ提案は却下。
- Safety defaults は **fail-closed**: `DRY_RUN=true` / `TRADING_ENABLED=false` が初期値。`DRY_RUN=true` のとき **broker 実通信を一切行わない**。
- Risk checks: symbol whitelist / max order notional / tradingEnabled / market hours (Phase 5) は OR ではなく **すべて AND で評価**。
- Webull raw JSON / proto は infrastructure 層に閉じ込める。application / domain には **正規化後のドメイン型だけ** 流す。
- secret / token の比較は **timing-safe** (単純な `!==` は不可)。
- 各 request / event に `requestId` を付け、結果を構造化 JSON で audit log に残す。

## ドメイン用語 (混同しない)

| 用語 | 意味 | 備考 |
|---|---|---|
| **order** | 発注指示 | market / limit / stop / stop-limit。現状 POC は limit / market のみ想定 |
| **position** | 保有数 | long = +、short = -。POC は long のみ |
| **notional** | 金額ベースの建玉 | `price * quantity`。Risk の上限チェックに使う |
| **filled_qty** | 約定済み数量 | 非負整数。部分約定で ≤ 発注数量 |
| **bid / ask** | 買指値 / 売指値 | spread = ask - bid |
| **Dry Run** | 実発注せず mock 応答 | `DRY_RUN=true` 時の動作 |
| **Paper trading** | Webull 側の仮想口座 | POC では扱わない (Dry Run で代替) |

## 書き方のクセ

- Order 関連の数値型 (`price`, `quantity`, `notional`, `filledQty`) は **必ず `> 0` / `>= 0` を入力時に確認**。negative / NaN / Infinity は domain の手前で弾く。
- Symbol は大文字で正規化 (`"soxl"` 受けても `"SOXL"` で比較)。ティッカーは case-insensitive が暗黙慣習。
- 時刻は必ず **UTC の ISO 8601** で保存 (`new Date().toISOString()`)。US market 時間変換は表示側で。
- 通貨は POC では USD のみ。multi-currency の抽象は前倒しで入れない。
- `rawPayload` は audit 用に保持するが、**domain ロジックから参照しない**。

## Webull / Cloudflare Workers 特有の制約

- Workers は長時間 TCP 保持不可 → gRPC stream は `bridge/` (Node runtime) で受け、HTTP POST で Worker に ingest する設計。
- Workers の `fetch` は request timeout が実質無制限ではない → broker 呼び出しには **明示タイムアウト** を入れる (Phase 5 で retry 付き強化)。
- `crypto.randomUUID()` / `crypto.subtle` は Workers で利用可。Node だけの API は Worker 側では使わない。
- 秘密は `.dev.vars` / Worker secrets 経由。ログに出さない (secret値を含む body は監査ログから除外 or masked)。

## よくある間違い (レビューで弾く)

- **DRY_RUN なのに broker に request 飛ばす分岐** → 即 reject
- **Risk チェックを bypass する "便利" helper** → 即 reject
- **string 比較での secret check** (`env.SECRET !== header`) → timing-safe に直す
- **allowedSymbols が env で上書き可能な開発用バックドア** → 本番 / POC 問わず入れない
- **filledQty に負値 / NaN を許容する parser** → 非負 finite で弾く
- **order 数量 0 を "何もしない" として扱う** → 入力として却下 (400)
- **Market hours を確認せず発注** → Phase 5 で入れるまでは `tradingEnabled` で代用 (hard toggle)

## 迷ったら

- **安全側に倒す** (実発注しない / エラー返す / ログだけ残す)。fallback で "とりあえず発注" は絶対やらない
- POC scope 外の議論 (multi-broker / HFT / ML) は **別 issue にして打ち切る**
- 判断に悩むなら Issue #1 (POC 設計書) の §11 安全設計 / §13 エラー分類を参照
