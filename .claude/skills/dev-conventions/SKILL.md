---
name: dev-conventions
description: Use this skill when setting up the project, writing code, committing, or running tests — to follow this repository's pnpm / TypeScript / commit / branch conventions.
---

# Dev Conventions

このリポジトリで従う **tooling / code / workflow 規約**。

## Tooling

| 項目 | 値 |
|---|---|
| Package manager | **pnpm 10+** (npm / yarn は使わない) |
| Node | 24 系 (mise で管理) |
| TS strict | `strict` / `noUncheckedIndexedAccess` / `verbatimModuleSyntax` 全部盛り |
| Module resolution | `Bundler` (import 拡張子なし) |
| Hono | ^4.12 |
| Wrangler | ^4 |
| Vitest | ^2.1 |

`bridge/` も同じく `moduleResolution: Bundler` を使う (NodeNext にすると Worker src にも `.js` 拡張子が必要になり、Phase 1 コードが汚染されるため)。bridge の実行は別途 transpiler (tsx / esbuild) を挟む前提。

## ファイル配置 (Issue #1 §8)

```
src/
  app.ts, index.ts
  routes/
  trading/
    application/
    domain/
    strategy/
    risk/
    execution/
    events/
  infrastructure/
    webull/
    logger/
  middleware/
  config/
  shared/
bridge/            Node runtime (Workers 外)
test/
```

## Code style

- TypeScript: `export` は named 優先、default は Hono app / entry だけ
- Class 名 PascalCase / function 名 camelCase / ファイル名は export 名に揃える (PascalCase も camelCase もあり)
- import 順: 外部 (hono / vitest 等) → 内部相対
- import 拡張子なし (`from './app'`) — `.ts` も `.js` も付けない
- **コメントは基本書かない**。書く場合は非自明な why のみ (1行)
- 未使用 optional フィールド / 将来用の抽象化 / 未呼び出しヘルパは追加しない

## Commands

```bash
pnpm install
pnpm install --frozen-lockfile
pnpm run typecheck        # tsc --noEmit
pnpm test                 # vitest run
pnpm test:watch
pnpm dev                  # wrangler dev
pnpm exec wrangler deploy --dry-run
# bridge
cd bridge && pnpm install && pnpm exec tsc --noEmit -p .
```

PR 前には typecheck + test を必ず通す。wrangler dry-run は任意。

## Branch / Worktree

- `main` 直接編集禁止 (保護)
- タスクブランチ: `dev/<topic>` (例: `dev/poc-phase-2-trading`, `dev/repo-rules`)
- worktree 運用: `git gtr new dev/<topic>` で作成、`git gtr rm dev/<topic>` で削除
- 並列作業時は共有ファイル (`src/app.ts` / `src/config/env.ts` / `.dev.vars.example`) を **末尾 append** で揃える → 後発 PR が rebase で解決

## Commit

- subject は英文 1行 (動詞開始 / title case 不要)
- body には **why** を書く。what は diff から読める
- Co-Authored-By / AI 署名は**付けない** (global 設定で無効化済)
- 機能追加は `feat:`、修正は `fix:`、設定系は `chore:`、レビュー対応は `fix: address ...`
- 1 commit 1 関心事。Phase 2 のように多層がある場合は domain → strategy → risk → execution → service → routes → tests の順で分割 commit

## Pull Request

- title: `POC Phase N: <概要> (issue #<n>)` 形式
- body 必須項目:
  - POC Phase scope 明示 (冒頭の "この PR は ..." quote)
  - In scope / Out of scope 表
  - CodeRabbit で却下した findings リスト (理由付き)
  - Acceptance criteria チェック
  - refs: 関連 issue
- Draft PR は `.coderabbit.yaml` で auto_review から除外済

## テスト方針

- **セーフティ系** (Risk blocking / auth 401 / DRY_RUN) は必ずカバー
- 単体テストは代表 1 pass + 1 明確な fail case で足る
- 境界値 / 網羅的エッジケースは POC では不要
- mocked broker が既定。実通信は `.dev.vars` のセット + 手動確認のみ

## Secrets / Env

- `.dev.vars` (Cloudflare Workers ローカル開発用) は `.gitignore` 済。`.dev.vars.example` をテンプレとして更新
- Worker secrets は `wrangler secret put` で設定 (POC 段階は dry-run 前提)
- API key / token は**ログに出さない**、audit log から masked
