#!/usr/bin/env bash
# 使い方: scripts/deploy.sh <staging|production>
# CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID は呼び出し側 (GitHub Actions の Environment) が環境変数で渡す。
# Worker secret (Webull の鍵など) はここでは反映しない。`wrangler secret put` で別に管理する。
set -euo pipefail

target=${1:?usage: deploy.sh <staging|production>}
# host は wrangler.jsonc の routes と揃える。jsonc をここで parse するとコメント除去を自前で書くことになるため、
# 2 箇所に書く方を選んだ。
case $target in
  staging) host=trading-staging.chanu.co ;;
  production) host=trading.chanu.co ;;
  *) echo "deploy 先は staging か production を指定する: $target" >&2; exit 2 ;;
esac

# CI では wrangler login の状態を持たないので、未設定なら wrangler の認証エラーより先に原因を示す
if [ "${CI:-}" = "true" ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "error: CLOUDFLARE_API_TOKEN が空。GitHub の Environment '$target' に secret を設定する (docs/production-cd.md)" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# deploy:<env> は migrations apply → wrangler deploy の 2 段 (production は先に D1 binding を検証する)。
pnpm "deploy:$target"

# curl -f は 3xx を成功扱いにするので、Access のログイン画面へのリダイレクトを health OK と取り違えないよう本文を見る。
for attempt in $(seq 1 10); do
  if curl -sS --max-time 10 "https://$host/health" | grep -q '"status":"ok"'; then
    echo "$target: https://$host/health OK"
    exit 0
  fi
  echo "health check 再試行 ($attempt/10)" >&2
  sleep 6
done
echo "error: https://$host/health が応答しない" >&2
exit 1
