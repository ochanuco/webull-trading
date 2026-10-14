# Production CD

本番は GitHub Actions の `deploy` workflow を手動実行したときだけ deploy する。`main` への merge では本番に出ない。

| 単位 | 契機 | 仕組み |
|---|---|---|
| PR ごとの Preview | PR ブランチへの push | staging Worker の Workers Builds が Worker Preview を作り、URL を PR にコメントする |
| staging | `main` への merge | staging Worker の Workers Builds が `pnpm run deploy:staging` (migration apply → deploy) を実行する |
| production | 手動実行のみ | GitHub Actions の `deploy`。Environment `production` の承認が必要。ref は `main` か `main` 上のコミット SHA |

## production

`deploy` workflow (`.github/workflows/deploy.yml`) は共有 workflow `ochanuco/.github` の `deploy.yml` を呼ぶ。

1. ref が `main` か `main` 上のコミットであることを確認する
2. `pnpm install --frozen-lockfile`
3. `op run --env-file=.github/deploy/production.env.op -- scripts/deploy.sh production`

承認は GitHub の Environment `production` の Required reviewers で行う。Cloudflare の API token は 1Password の `gh-deploy/cloudflare-workers` から `op run` が渡し、GitHub の secret / variable には置かない。

`scripts/deploy.sh production` は `pnpm deploy:production` (D1 binding の検証 → `wrangler deploy --env=production`) を実行し、`https://trading.chanu.co/health` を確認する。

deploy は D1 migration を適用しない。migration を含む PR は、本番 deploy の前に手動で `wrangler d1 migrations apply webull-trading-production --env=production --remote` を実行する。

Worker secret (Webull の鍵など) は deploy では扱わない。`wrangler secret put` で別に管理する。

`wrangler.jsonc` の `env.production.d1_databases[0].database_id` が `REPLACE_WITH_PRODUCTION_ID` のままなら deploy は止まる。

### Rollback

戻したいコミットの SHA を ref に指定して `deploy` を実行する。D1 schema の変更を跨ぐ場合は戻せない。Cloudflare の [versions rollback](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/) も使えるが、同じ制約がある。

## Preview

設定は `wrangler.jsonc` の `env.staging.previews`。Preview は staging の設定を引き継がない。

- `ENVIRONMENT=staging-preview`。`production` 以外なので発注は強制的に止まる (`WebullTradeClient`)
- Webull の secret は渡さない。quote / bars は Yahoo (既定) を使う
- Durable Object は Preview ごとに名前空間が自動で作られる (staging 本体の状態とは混ざらない)
- D1 は staging の DB を共有する。migration を含む PR の Preview では、`main` に入って staging に適用されるまで新しいテーブルが無い
- cron は Preview では動かない。RateLimit binding も載せていない (`rateLimit()` は binding が無いと素通し)
- Preview の URL は既定で公開されるので、Cloudflare Access で staging Worker の Preview を保護する

## Cloudflare Workers Builds (staging Worker)

`webull-trading-staging` の Settings > Build:

- production branch: `main`
- deploy command: `pnpm run deploy:staging`
- preview builds: 有効。preview command は `pnpm exec wrangler preview --env staging`

production Worker には Workers Builds を接続しない。

## Merge 方式

repo 設定で merge commit のみを許可している (squash / rebase は無効)。

## Versioning

semver 採番・CHANGELOG 生成 (release-please) は撤去済み。`package.json` の `version` は 1.6.0 で凍結、`CHANGELOG.md` は v1.5.0 までの履歴として残す。
