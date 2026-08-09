# webull-trading

Retail auto-trading system on Cloudflare Workers + Hono + TypeScript, speaking Webull OpenAPI directly (no SDK).

production で Pullback / BreakoutMomentum 戦略が 15 分 cron で**実発注稼働中** (Webull JP 本番口座)。US + JP 両通貨対応。Cloudflare Access で保護した read-only dashboard と MCP server 付き。

**安全既定は fail-closed**: `dry_run=1` / `trading_enabled=0`。実発注は D1 `global_config` を明示的に切り替えた環境でのみ動く。

## ドキュメント

| | 内容 |
|---|---|
| [docs/onboarding.md](docs/onboarding.md) | 開発を始める手順。ローカル実行 / secrets / Webull 口座の初期作業 |
| [docs/architecture.md](docs/architecture.md) | 全体像・cron・bindings・ディレクトリ構成・層の境界 |
| [docs/configuration.md](docs/configuration.md) | `global_config` / `symbol_config` の全パラメタと既定値 |
| [docs/endpoints.md](docs/endpoints.md) | HTTP endpoint 一覧と認証 |
| [docs/db-operations.md](docs/db-operations.md) | D1 の初回セットアップ・schema 変更・運用 SQL レシピ |
| [docs/production-cd.md](docs/production-cd.md) | リリースフロー (main → 昇格 PR → Workers Builds) |
| [docs/production-deployment.md](docs/production-deployment.md) | 本番投入の手順とロールバック |
| [docs/env-separation.md](docs/env-separation.md) | dev / staging / production の分離方針 |
| [docs/review-queries.md](docs/review-queries.md) | 障害・振り返り用のクエリ集と運用 runbook |

## クイックスタート

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm dev            # wrangler dev (ローカル D1 自動作成)
```

`.dev.vars.example` を `.dev.vars` にコピーして 1Password 参照を埋める。詳細は [docs/onboarding.md](docs/onboarding.md)。

## 開発の約束

- ブランチは `dev/<topic>`。`main` 直接編集は禁止
- merge 方式は repo 設定で強制済み — `main` / `production` とも merge commit のみ
- commit は Conventional Commits (履歴の可読性のため。採番には使っていない)
- 発注経路は **Strategy → Risk → Execution** の一方向。Risk を迂回する導線は作らない

## ライセンスと免責

MIT License ([LICENSE](LICENSE))。

**このリポジトリは個人が自分の口座で運用している実験的な自動売買システムです。** 実マネーが動くコードを参考にする場合、損失を含むすべての結果は利用者の責任です。投資助言ではありません。ライセンスの定めるとおり無保証で提供されます。

## AI エージェント / レビュー設定

- `CLAUDE.md` — Claude 用エントリ (skill / agent index)
- `AGENTS.md` — Codex 用エントリ
- `.claude/skills/trading-developer/` — 取引コードの safety invariants auto-activate
- `.claude/skills/phase-scope/` — Phase 境界の scope 判定
- `.claude/skills/coderabbit-policy/` — CodeRabbit findings の採用 / 却下基準
- `.claude/agents/trading-strategist.md` — 戦略設計 delegate 用 subagent
- `.coderabbit.yaml` — 自動レビュー設定 (profile: chill + path_instructions)
