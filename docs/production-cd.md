# Production CD

本番 deploy は `main` への通常 PR merge では走らせず、`production` branch への release PR merge を唯一の入口にする。

## Branch model

| Branch | Role | Automation |
|---|---|---|
| `main` | 開発統合。通常 PR の merge 先 | CI + CodeRabbit |
| `release/production` | GitHub Actions が `main` から作る release PR branch | force-update by workflow |
| `production` | Cloudflare Workers Builds の production branch | merge された commit を本番 deploy |

`production` への direct push は禁止。必ず `release/production -> production` の PR を merge する。

## Cloudflare Workers Builds setup

Cloudflare dashboard で Worker を GitHub repo に接続し、production branch を `production` にする。

推奨 build command:

```bash
pnpm install --frozen-lockfile && pnpm deploy:production
```

`pnpm deploy:production` は次を実行する:

1. `pnpm verify:production-d1`
2. `wrangler d1 migrations apply webull-trading-production --env=production --remote`
3. `wrangler deploy --env=production`

`wrangler.jsonc` の `env.production.d1_databases[0].database_id` が `REPLACE_WITH_PRODUCTION_ID` のままなら deploy は止まる。

## GitHub Actions

### `production release PR`

`main` push で `release/production` branch を `main` に更新し、`production` 向け PR を作成または更新する。

この PR は「コードの再レビュー」ではなく「本番昇格の承認ゲート」。初回作成時の title は `🚀リリースyyyy-MM-dd HH:mm:ss` (Asia/Tokyo) にし、その後 `main` に追加 PR が merge されても title は維持する。Description には `production..release/production` に含まれる PR 番号 (`#xxx`) を一覧する。

`.coderabbit.yaml` 側では release PR title keyword で CodeRabbit auto review を skip する。

`production` がすでに `main` と同じ commit を指している場合、release PR に差分がないため workflow は PR 作成を skip して success にする。初回 bootstrap 直後や、production が main に追いついている状態ではこれが期待値。

この workflow は default `GITHUB_TOKEN` を使わず、GitHub App token を使う。`GITHUB_TOKEN` で workflow から PR を作成/更新すると、その PR の `pull_request` workflow が自動実行されず approval 待ちになり得るため。また、CODEOWNER が自分自身なので App bot を PR 作成者にすることで self-approve 制限を回避する。

必要な repository secrets:

- `APP_ID`: GitHub App の ID
- `APP_PRIVATE_KEY`: GitHub App の秘密鍵 (`.pem` の内容)

GitHub App 側に必要な repository permissions:

- Contents: read/write (`release/production` branch push)
- Pull requests: read/write (`production` 向け PR の create/edit)

### `production preflight`

`production` 向け PR で本番 deploy 前提だけを見る。

- `pnpm verify:production-d1`
- `pnpm run deploy:production:dry-run`

通常の typecheck / test / CodeRabbit は `main` に入る通常 PR で済ませる。

## Bootstrap

初回だけ `production` branch を明示的に作る。Cloudflare Workers Builds を有効化する前に実施する。

```bash
git fetch origin main
git push origin refs/remotes/origin/main:refs/heads/production
```

その後、GitHub branch protection で `production` を保護する。

Required checks:

- `production deploy preflight`

推奨ルール:

- Require pull request before merging
- Require approvals
- Restrict who can push directly
- Require branches to be up to date before merging

## Release flow

1. 通常 PR を `main` に merge
2. GitHub Actions が `release/production -> production` PR を作成/更新
3. Operator が release checklist を確認
4. release PR を merge
5. Cloudflare Workers Builds が `production` branch push を検知して production deploy
6. `/admin/production-readiness` / dashboard / Workers logs で確認
