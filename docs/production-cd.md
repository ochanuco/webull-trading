# Production CD

本番 deploy は `main` への通常 PR merge では走らせず、`production` branch への release PR merge を唯一の入口にする。

リリースは **2 段**になっている:

1. **リリースを切る** — release-please が維持する `chore(main): release x.y.z` PR を merge。ここで version / CHANGELOG が確定し、tag と GitHub Release (自動生成ノート) が publish される
2. **本番に昇格する** — その Release を trigger に `production` 向けの昇格 PR が作られる。merge すると Workers Builds が deploy

`main` に merge しただけでは昇格 PR は出ない。「リリースを切る」判断が明示的な操作になっている。

## Branch model

| Branch | Role | Automation |
|---|---|---|
| `main` | 開発統合。通常 PR の merge 先 | CI + CodeRabbit + release-please |
| `release/production` | GitHub Actions が **tag の tree** から作る昇格 PR branch | force-update by workflow |
| `production` | Cloudflare Workers Builds の production branch | merge された commit を本番 deploy |

昇格する内容は **tag の時点の tree** で、`main` の先端ではない。リリースを切った後に `main` へ入った変更が、そのリリース名で本番に混ざらないようにしている。

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

1. 通常 PR を `main` に merge (Conventional Commits の subject にする — そのままリリースノートの 1 行になる)
2. `release please` workflow が `chore(main): release x.y.z` PR を作成/更新 (CHANGELOG + version bump)
3. **リリースを切る**: その PR を merge → tag `vx.y.z` と GitHub Release が publish される
4. `production release PR` workflow が Release を検知し、tag の tree から `release/production -> production` PR を作成
5. Operator が release checklist とリリースノートを確認
6. 昇格 PR を merge
7. Cloudflare Workers Builds が `production` branch push を検知して production deploy
8. `/admin/production-readiness` / dashboard / Workers logs で確認

`workflow_dispatch` で `production release PR` を手動実行すると、最新の Release に対して昇格 PR を作り直せる。

## Merge 方式

ブランチごとに ruleset の `pull_request.allowed_merge_methods` で**強制**している。手で選ばない (選べない)。

| 対象 | 方式 | 理由 |
|---|---|---|
| `main` | **merge commit のみ** | フィーチャーブランチの履歴を残す (squash は並列開発でコンフリクト解決や revert の手掛かりを失う) |
| `production` | **squash のみ** | `release/production` は機械生成の単一コミットブランチ。1 リリース = production の 1 コミットを保ち、ロールバック先を一意にする。`required_linear_history` とも整合 |

`main` が merge commit になったことで、**CHANGELOG の粒度が「PR 単位」から「コミット単位」に変わる**。release-please は releasable unit (`feat` / `fix` / `deps`) をコミット単位で拾うため、ブランチ内の細かいコミットもそのままリリースノートに並ぶ。粒度を保ちたい PR は push 前にローカルで畳む。

## Versioning

導入時に踏んだ罠 (再導入・移設時の注意):

- **GitHub Release が 1 つも無いと、merged release PR にタグを打てず `untagged, merged release PRs outstanding - aborting` で止まる**。ベースラインの Release (`v1.0.0`) を手で 1 本作る必要がある
- `packages` に `package-name` を書くと component 扱いになり、grouped release PR (component 無し) と一致せず `PR component: undefined does not match configured component` でタグ生成が skip される。単一パッケージでは書かない
- **`separate-pull-requests: false` を明示すると Merge プラグインが有効になり、component を持たない grouped PR が作られる**。その PR は merge 後に `PR component: undefined does not match configured component` でタグ生成が skip される。単一パッケージでは書かない (書かない場合の PR title は `chore(main): release x.y.z`)
- grouped PR を使う場合、タイトルは `pull-request-title-pattern` ではなく `group-pull-request-title-pattern` から作られる (既定は `chore: release ${branch}` なので版数が出ない)
- `pull-request-title-pattern` から `${scope}` / `${component}` を落とすと既存 release PR を逆パースできず、PR の更新が丸ごと skip される

`release-please-config.json` / `.release-please-manifest.json` が正。`release-type: node` なので `package.json` の `version` も追随する。

- 採番は Conventional Commits 由来 (`feat:` → minor / `fix:` → patch / `!` or `BREAKING CHANGE` → major)
- CHANGELOG に出るのは `feat` / `fix` / `perf` / `refactor` / `deps`。`chore` / `docs` / `test` / `ci` / `style` は hidden
- **hidden な type だけの変更はリリースを生まない** (実測: `chore(deps)` のみを merge しても release PR は出なかった)。依存更新が production に永久に出ない乖離を避けるため、Renovate は `renovate.json` の packageRules で `fix(deps):` を使わせている
- ロールバックの参照点は tag。`git checkout vX.Y.Z` した tree を `production` に流し直せば戻せる
