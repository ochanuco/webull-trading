# webull-trading — Claude / Codex 用プロジェクト指示

このファイルは AI エージェントがこのリポジトリで作業する時の最小エントリ。詳細は skill / agent / 設定ファイルに分割してある (auto-activate)。

## この repo の前提

- **POC**: 小規模 retail の算出的自動売買 (Webull OpenAPI, Cloudflare Workers, Hono, TypeScript)
- **POC status: 全 Phase 1–5 merged、[#1](https://github.com/ochanuco/webull-trading/issues/1) closed。以降の作業は [follow-up issues](#関連リンク) 参照**
- **実マネー前提で fail-closed 設計**。`DRY_RUN=true` / `TRADING_ENABLED=false` が既定
- **Phase 単位 PR** (POC 時): 各 Phase の scope を守る (#3 Phase 2 / #4 Phase 3 / #5 Phase 4 / #6 Phase 5 — 全 closed)
- **pnpm 10+** / Node 24 / TypeScript strict / `moduleResolution: Bundler`

## Skill / Agent の使い分け

| 実体 | 場所 | いつ使う |
|---|---|---|
| `trading-developer` skill | `.claude/skills/trading-developer/` | 取引系コード (`src/trading/`, `src/infrastructure/webull/`) を触る時。ドメイン姿勢と safety invariants を自動で適用 |
| `trading-strategist` agent | `.claude/agents/trading-strategist.md` | 戦略設計・backtest 議論。コード実装は main に戻す。`Task(subagent_type="trading-strategist", ...)` で呼ぶ |
| `phase-scope` skill | `.claude/skills/phase-scope/` | PR 作成前 / CodeRabbit 指摘受領時。scope 判定して他 Phase に回す判断 |
| `coderabbit-policy` skill | `.claude/skills/coderabbit-policy/` | findings の apply / skip 判断、スキップ理由テンプレ |

## 非自明な慣習 (package.json / tsconfig.json 見れば分かる話は省略)

- ブランチ名: `dev/<topic>` (例: `dev/poc-phase-2-trading`)。 `main` 直接編集禁止
- **merge 方式は ruleset で強制済み — 選ぶ必要はない**: `main` は **merge commit のみ** (`gh pr merge --merge`)、`production` は **squash のみ** (`gh pr merge --squash`)。他方を指定すると GitHub 側で reject される
- worktree: `git gtr new dev/<topic>` で作成、`git gtr rm` で削除
- PR title: Conventional Commits 形式 (POC 期は `POC Phase N: <概要> (issue #<n>)` を使っていた)
- リリース: `chore(main): release x.y.z` PR を merge して tag を切る → 生成された Release が production 昇格 PR を作る (詳細は `docs/production-cd.md`)
- commit: 英文1行 subject、**Conventional Commits** (`feat:` / `fix:` / `chore:` / `docs:` / `refactor:` / `perf:` / `test:` / `ci:`)、body は **why** のみ
  - squash merge なので **PR title がそのまま commit subject = リリースノートの 1 行**になる。release-please が採番と CHANGELOG 生成に使うので prefix を外さない
  - 破壊的変更は `feat!:` か body に `BREAKING CHANGE:` (major bump のトリガー)
- 並列 PR 共有ファイル (`src/app.ts` / `src/config/env.ts` / `.dev.vars.example`) は **末尾 append のみ** → 後発 PR が rebase で解決

## 関連設定

- `.coderabbit.yaml` — CodeRabbit 自動レビューの path_instructions (Phase scope / POC 姿勢をプリロード)
- `.claude/settings.json` — よく使う pnpm / wrangler コマンドを allow-list

## 関連リンク

### POC (closed)
- POC 設計書: [#1](https://github.com/ochanuco/webull-trading/issues/1)
- Phase issues: [#3](https://github.com/ochanuco/webull-trading/issues/3) / [#4](https://github.com/ochanuco/webull-trading/issues/4) / [#5](https://github.com/ochanuco/webull-trading/issues/5) / [#6](https://github.com/ochanuco/webull-trading/issues/6)
- Phase 1 merged PR: [#2](https://github.com/ochanuco/webull-trading/pull/2)

### POC 後の follow-up
- [#21](https://github.com/ochanuco/webull-trading/issues/21) Webull OpenAPI 実運用化 (canonical signing / live 疎通 / エラー細分化)
- [#23](https://github.com/ochanuco/webull-trading/issues/23) Risk policy 詳細化 (halt / PDT / short locate / settlement — DST は #338 で解決済)
- [#24](https://github.com/ochanuco/webull-trading/issues/24) Production operational readiness (secrets / CI / deploy / observability)

## 迷ったら

- 安全側に倒す (実発注しない / エラー返す / ログだけ残す)
- POC scope 外は別 issue に切り出して打ち切る
- 法令 / 税務 / 個別銘柄推奨 は出力しない
