# AGENTS.md

Codex / OpenAI 系エージェント向けエントリ。内容は `CLAUDE.md` と同等なので、更新時は両方揃える。

## この repo の前提

- **POC**: retail auto-trader (Webull OpenAPI / Cloudflare Workers / Hono / TypeScript)
- **実マネー前提の fail-closed 設計**。`DRY_RUN=true` / `TRADING_ENABLED=false` が既定値
- **Phase 単位 PR** (#3 Phase 2 / #4 Phase 3 / #5 Phase 4 / #6 Phase 5)
- **pnpm 10+** / Node 24 / TypeScript strict / `moduleResolution: Bundler`

## 指示の参照先

Codex からも `.claude/skills/*/SKILL.md` と `.claude/agents/*.md` は参照可能 (読み取り)。以下を必要に応じて読む:

- `.claude/skills/trading-developer/SKILL.md` — 取引コードの姿勢・safety invariants
- `.claude/skills/phase-scope/SKILL.md` — Phase の scope 判定
- `.claude/skills/coderabbit-policy/SKILL.md` — CodeRabbit findings の採用 / 却下基準
- `.claude/skills/dev-conventions/SKILL.md` — pnpm / TS / commit / branch 規約
- `.claude/agents/trading-strategist.md` — 戦略設計の専門観点

## Codex sandbox メモ

```
codex exec --full-auto \
  -c 'sandbox_workspace_write.network_access=true' \
  -c 'sandbox_workspace_write.writable_roots=["/Users/chanu/.coderabbit"]' \
  - < prompt.md
```

CodeRabbit CLI を codex 内で走らせる場合は OAuth 保存トークン (`coderabbit auth login --agent`) を事前に済ませる。API key 経由は Hoppy CLI 有料アドオン前提。

## 迷ったら

- 安全側に倒す (DRY_RUN skip / Risk bypass の fallback は禁止)
- POC scope 外は別 issue に切り出して打ち切る
- 法令 / 税務 / 個別銘柄推奨は出力しない
