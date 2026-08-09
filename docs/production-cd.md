# Production CD

本番 deploy は `main` への通常 PR merge では走らせず、`production` branch への release PR merge を唯一の入口にする。

リリースは **1 段**: `main` push ごとに GitHub Actions が昇格 PR を自動更新するので、operator はその PR を merge するだけ。「リリースする」判断 = 昇格 PR の merge。

> 以前は release-please による tag/semver リリース (2 段) だったが、配布物がなく採番の必要がないため撤去した (経緯と当時の設定は git history 参照)。ロールバック参照点は tag ではなく `production` branch のコミット (1 リリース = 1 コミット) が担う。

## Branch model

| Branch | Role | Automation |
|---|---|---|
| `main` | 開発統合。通常 PR の merge 先 | CI + CodeRabbit + 昇格 PR 更新 |
| `release/production` | GitHub Actions が **main の tree** から作る昇格 PR branch | force-update by workflow |
| `production` | Cloudflare Workers Builds の production branch | merge された commit を本番 deploy |

昇格する内容は **workflow 実行時点の `main` の tree**。`main` に新しい PR が merge されるたびに昇格 PR は main 先端の snapshot に自動更新されるので、**merge する直前の PR diff = 本番に出る内容**。混入を避けたい変更があるなら、先に昇格 PR を merge してから main に入れる。

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

`main` push で `release/production` branch を main の snapshot で作り直し、`production` 向け PR を作成または更新する。

仕組み: `release/production` は `production` の先端に **main の tree を `git read-tree` で丸ごと 1 コミット積んだ** branch。3-way merge をしないので、squash 運用で merge-base が凍結されていても add/add コンフリクトが発生しない (2026-07-03 に `git merge --squash` 方式で実際に詰まった対策)。

この PR は「コードの再レビュー」ではなく「本番昇格の承認ゲート」。title は初回作成時の `🚀リリース yyyy-MM-dd HH:mm:ss` (Asia/Tokyo) のまま維持し (「いつから昇格待ちか」を表す)、body の変更一覧と main SHA が更新される。変更一覧は「production の tree と一致する main 上の commit」を前回昇格点として、そこから main 先端までの first-parent ログから生成する。

`.coderabbit.yaml` 側では release PR title keyword で CodeRabbit auto review を skip する。

`production` がすでに `main` と同じ tree の場合、release PR に差分がないため workflow は PR 作成を skip して success にする。初回 bootstrap 直後や、production が main に追いついている状態ではこれが期待値。

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
2. `production release PR` workflow が昇格 PR (`release/production -> production`) を作成または main 先端に更新
3. Operator が昇格 PR の diff・変更一覧・checklist を確認
4. 昇格 PR を merge
5. Cloudflare Workers Builds が `production` branch push を検知して production deploy
6. `/admin/production-readiness` / dashboard / Workers logs で確認

`workflow_dispatch` で `production release PR` を手動実行すると、昇格 PR を作り直せる。

## Merge 方式

repo 設定で **merge commit のみ**を許可している (squash / rebase は無効)。`main` も `production` も merge commit で merge する。

`production` は以前 squash-only + `required_linear_history` だったが、`release/production` が機械生成の単一 snapshot コミットになったため squash に意味がなくなり、2026-08-09 に merge commit へ統一した。1 リリース = 昇格 PR の merge commit 1 つ (親に snapshot コミットがぶら下がる) で、ロールバック先の一意性は保たれる。

## Rollback

ロールバックの参照点は `production` branch の merge commit (`🚀リリース` PR 単位)。戻したいリリースの commit を checkout した tree を `production` に流し直せば戻せる (workflow の read-tree と同じ要領で snapshot コミットを作り PR する)。Cloudflare 側でも [versions rollback](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/) が使えるが、D1 schema 変更を跨ぐ場合は不可。

## Versioning

semver 採番・CHANGELOG 生成 (release-please) は撤去済み。`package.json` の `version` は 1.6.0 で凍結、`CHANGELOG.md` は v1.5.0 までの履歴として残す。リリース単位の変更一覧は昇格 PR の body と `production` branch のコミット履歴が担う。
