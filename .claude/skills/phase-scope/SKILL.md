---
name: phase-scope
description: Use this skill before opening a PR, before accepting a CodeRabbit suggestion, or when planning changes — to verify that work stays inside the current Phase's declared scope and to route out-of-scope items to the correct Phase issue.
---

# Phase Scope

このリポジトリは **Phase 単位で区切って PR を出す** 方針。Phase を跨いだ変更要求はここで判定して**必ず該当 Phase issue に回す**。

## Phase 対応表

| Phase | Issue | 概要 | 主な owned ファイル |
|---|---|---|---|
| 1 | — (PR #2 merged) | Hono + Workers + `/health` + audit logger + basic auth 雛形 | `src/app.ts`, `src/routes/health.ts`, `src/middleware/basicAuth.ts`, `src/infrastructure/logger/AuditLogger.ts`, `src/config/env.ts`, `wrangler.jsonc`, `tsconfig.json` |
| 2 | #3 | Strategy / Risk / MockExecution / `/trade/decide` / `/trade/execute` | `src/trading/{domain,strategy,risk,execution,application}/`, `src/routes/trade.ts` |
| 3 | #4 | Webull HTTP integration | `src/infrastructure/webull/{WebullHttpClient,WebullAuth,dto}.ts`, `src/trading/execution/WebullExecution.ts`, `src/routes/webull.ts` |
| 4 | #5 | gRPC trade events bridge + `/events/trade` | `src/trading/{events,application/TradeEventService}`, `src/trading/domain/TradeEvent.ts`, `src/routes/events.ts`, `src/infrastructure/webull/TradeEventBridge.ts`, `bridge/` |
| 5 | #6 | retry / audit log 強化 / symbol別 config | 既存の Webull / Bridge 周りにリトライ、`shared/errors.ts`、symbol config の拡張 |

## 判定フロー

何か変更を加える or CodeRabbit 指摘を受けたら:

1. **この PR の Phase は?** → PR title / body / branch 名 (`dev/poc-phase-N-*`) から特定
2. **変更対象ファイルはその Phase の owned か?**
   - YES → scope 内、進めてよい
   - NO → 下へ
3. **append-only の共有ファイル (`src/app.ts`, `src/config/env.ts`, `.dev.vars.example`) か?**
   - YES → **末尾追記のみ**なら進めてよい。並列 PR との conflict は merge 時に rebase で機械解決
   - NO → 下へ
4. **他 Phase の owned ファイルへの変更が必要か?**
   - 採用しない。**該当 Phase issue を参照して別 PR で対応**する旨を記述
   - 例: Phase 4 PR で `postTradeEvent` に retry を要求された → 「Phase 5 (#6) scope」と明記してスキップ
5. **他 Phase の機能追加を求められたか?**
   - 却下。issue 立てるよう促す

## スキップ理由のテンプレート

PR body や CodeRabbit コメントへの返信で使える定型:

- `Phase 5 scope (#6)` — retry / timeout / audit 強化 系の指摘
- `Phase 3 scope (#4)` — Webull 実通信 / SDK 代替 系
- `Not in scope for this POC` — HFT / ML / multi-broker / Queue / DO
- `Stale finding` — コードが既に対応済 or 前提を誤解している指摘
- `Premature abstraction for POC` — DI / factory / 設定ファイル化の前倒し提案
- `Intentional TODO per issue` — scope に明記された placeholder (例: `bridge/grpc/client.ts`)

## よくある誤爆と対処

| 指摘内容 | 実際の Phase | 対応 |
|---|---|---|
| "retry を入れて" | Phase 5 | skip + reference #6 |
| "DI で Service 注入" | POC 範囲外 | skip (premature) |
| "WebullExecution 実装" | Phase 3 | skip + reference #4 |
| "timing-safe 比較" | 該当 Phase | **apply** (security は Phase 不問で採用) |
| "入力 validation" | 該当 Phase | **apply** (correctness は採用) |
| "exhaustive 境界テスト" | — | skip (POC coverage) |
| "market hours チェック" | Phase 5 | skip + reference #6 |

## セキュリティ / correctness は例外扱い

Phase に関係なく以下は**受け入れる**:

- 認証の timing-safe 比較
- 入力 validation (negative / NaN / Infinity / empty)
- 型の厳格化 (literal union / guard 追加)
- 明確なバグ (array が object として判定される等)
- audit log が実際の status code を反映しないバグ

## 判断に迷ったら

- Phase の owner ファイル表を再確認
- それでも迷ったら PR 本文に書いてレビュアに判断を委ねる (一人で抱え込まない)
