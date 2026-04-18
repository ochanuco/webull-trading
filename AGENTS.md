# AGENTS.md

Codex / OpenAI 系エージェント向けエントリ。内容は `CLAUDE.md` と同等なので、更新時は両方揃える。

## この repo の前提

- **POC**: retail auto-trader (Webull OpenAPI / Cloudflare Workers / Hono / TypeScript)
- **POC status: 全 Phase 1–5 merged、[#1](https://github.com/ochanuco/webull-trading/issues/1) closed。follow-up は [#21](https://github.com/ochanuco/webull-trading/issues/21) / [#22](https://github.com/ochanuco/webull-trading/issues/22) / [#23](https://github.com/ochanuco/webull-trading/issues/23) / [#24](https://github.com/ochanuco/webull-trading/issues/24)**
- **実マネー前提の fail-closed 設計**。`DRY_RUN=true` / `TRADING_ENABLED=false` が既定値
- **Phase 単位 PR** (POC 時、全 closed: #3 / #4 / #5 / #6)
- **pnpm 10+** / Node 24 / TypeScript strict / `moduleResolution: Bundler`

## 指示の参照先

Codex からも `.claude/skills/*/SKILL.md` と `.claude/agents/*.md` は参照可能 (読み取り)。以下を必要に応じて読む:

- `.claude/skills/trading-developer/SKILL.md` — 取引コードの姿勢・safety invariants
- `.claude/skills/phase-scope/SKILL.md` — Phase の scope 判定
- `.claude/skills/coderabbit-policy/SKILL.md` — CodeRabbit findings の採用 / 却下基準
- `.claude/agents/trading-strategist.md` — 戦略設計の専門観点

## 非自明な慣習

- ブランチ名: `dev/<topic>`。 `main` 直接編集禁止。 `git gtr new dev/<topic>` で worktree
- PR title: `POC Phase N: <概要> (issue #<n>)`
- commit: 英文1行 subject、prefix `feat:` / `fix:` / `chore:`、body は why のみ
- 並列 PR 共有ファイル (`src/app.ts` / `src/config/env.ts` / `.dev.vars.example`) は末尾 append のみ
- tooling / file layout の詳細は `package.json` / `tsconfig.json` / `ls` で確認

## Codex sandbox メモ

```
codex exec --full-auto \
  -c 'sandbox_workspace_write.network_access=true' \
  -c 'sandbox_workspace_write.writable_roots=["$HOME/.coderabbit"]' \
  - < prompt.md
```

CodeRabbit CLI を codex 内で走らせる場合は OAuth 保存トークン (`coderabbit auth login --agent`) を事前に済ませる。API key 経由は Hoppy CLI 有料アドオン前提。

## 迷ったら

- 安全側に倒す (DRY_RUN skip / Risk bypass の fallback は禁止)
- POC scope 外は別 issue に切り出して打ち切る
- 法令 / 税務 / 個別銘柄推奨は出力しない
