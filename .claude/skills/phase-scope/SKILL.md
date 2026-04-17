---
name: phase-scope
description: Use this skill before opening a PR, before accepting a CodeRabbit suggestion, or when planning changes — to verify that work stays inside the current PR's Phase scope and to route out-of-scope items to the correct Phase issue.
---

# Phase Scope

POC は **Phase 単位の PR** で進める。Phase 跨ぎの変更要求は必ず該当 issue に回し、この PR では対応しない。

## Phase → Issue

| Phase | Issue | 概要 |
|---|---|---|
| 1 | — (PR #2 merged) | Scaffold |
| 2 | [#3](https://github.com/ochanuco/webull-trading/issues/3) | Trading core (Strategy / Risk / MockExecution) |
| 3 | [#4](https://github.com/ochanuco/webull-trading/issues/4) | Webull HTTP |
| 4 | [#5](https://github.com/ochanuco/webull-trading/issues/5) | gRPC trade events |
| 5 | [#6](https://github.com/ochanuco/webull-trading/issues/6) | retry / audit 強化 / symbol config |

owned ファイル / acceptance / in-out scope の詳細は **各 issue** を参照 (`gh issue view <N>`)。

## 判定フロー

1. 現 PR の Phase を branch 名 / title から特定
2. 変更対象が当該 Phase の owned ファイル? (issue の scope 表で確認)
   - YES → 進める
3. 共有ファイル (`src/app.ts` / `src/config/env.ts` / `.dev.vars.example`) への **末尾 append**?
   - YES → 進める (後発 PR が rebase で union 解決)
4. 他 Phase の owned ファイルへの変更 or 機能追加か?
   - **却下**。該当 issue への参照でスキップ理由を書く

## スキップ理由テンプレ

- `Phase N scope (#issue)` — 他 Phase に属する機能/ハードニング要求
- `Not in scope for this POC` — HFT / ML / multi-broker / Queue / DO
- `Stale finding` — 既対応 or 前提誤認
- `Premature abstraction for POC` — DI / factory / 設定間接化
- `Intentional TODO per issue` — scope 明記の placeholder
- `POC coverage is adequate` — exhaustive 境界テスト要求

## 例外 (Phase 不問で採用)

- セキュリティ (timing-safe、credential leak、auth bypass)
- 入力 validation (negative / NaN / empty / zero)
- 明確なバグ (型判定の誤り、status の誤記録等)
- 型の厳格化 (literal union + runtime guard)

## 迷ったら

PR 本文に判断を書いて human review に委ねる。一人で抱え込まない。
