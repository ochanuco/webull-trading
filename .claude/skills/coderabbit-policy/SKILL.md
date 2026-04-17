---
name: coderabbit-policy
description: Use this skill when processing CodeRabbit CLI or PR-level findings — to decide which suggestions to apply and which to skip with a documented reason. Keeps POC reviews from scope-creeping.
---

# CodeRabbit Policy

CodeRabbit の指摘は全件反映するのではなく、**POC スコープ + 安全性**の観点でフィルタする。採用基準と却下基準をここに集約。

## 採用する指摘 (apply)

- **セキュリティ**: secret の timing-safe 比較、credential の leak、XSS / injection、auth bypass
- **correctness バグ**: `typeof arr === 'object'` 誤判定、負値 / NaN / Infinity の通過、DRY_RUN が無視される分岐
- **入力 validation**: 空文字 / ゼロ / 非数値を弾く
- **型の厳格化**: loose string → literal union + runtime guard
- **実際に壊れている挙動**: audit log が status を誤記録、認証通さず 200 が返る、等

## スキップする指摘 (skip with reason)

PR body もしくはコメントで明示的に却下理由を書く。「無言で無視」はしない。

| パターン | 却下理由テンプレ |
|---|---|
| 他 Phase に属する機能要求 | `Phase N scope (#issue)` |
| 意図された TODO 実装要求 (e.g. `bridge/grpc/client.ts`) | `Intentional TODO per issue #5 scope` |
| 早期最適化 (middleware closure cache 等) | `Premature optimization for POC` |
| 未使用 optional フィールドの追加 | `Dead interface — no caller populates these fields` |
| DI / factory の前倒し | `Premature abstraction for POC` |
| 過剰な境界テスト / exhaustive coverage | `POC coverage is adequate (1 pass + 1 fail case)` |
| Workers 制約を bridge に誤適用 | `Stale finding: bridge runs in Node, not Workers` |
| 既に対応済 / 前提を誤解 | `Stale finding: <具体的な状況>` |

## フロー

1. `coderabbit review --agent` の findings JSON を読む
2. 各 finding について:
   - セキュリティ or correctness?
     - YES → apply
     - NO → 下へ
   - Phase scope 内?
     - YES → apply (trivial / minor でも入れてよい)
     - NO → skip + テンプレ適用
3. apply リストを 1 commit に束ねる (commit message で CodeRabbit 参照)
4. skip リストを PR body に表形式で記載:
   - `# | finding | 却下理由`

## コマンド

### ローカル実行

```bash
# worktree 内で:
coderabbit review --agent > .local/coderabbit-findings.log
```

### codex 経由での実行

codex sandbox は network と `~/.coderabbit/` への書き込みをデフォルトでブロックする。両方を明示的に許可する:

```bash
codex exec --full-auto \
  -c 'sandbox_workspace_write.network_access=true' \
  -c 'sandbox_workspace_write.writable_roots=["/Users/chanu/.coderabbit"]' \
  - < prompt.md
```

### 認証の渡し方

**推奨: OAuth 保存トークン** (`coderabbit auth login --agent` を事前に1回実行済み)
- `~/.coderabbit/` 内に保存されるため、上記 `writable_roots` を設定すれば codex 内でも読める
- プロンプトでは `coderabbit review --agent` をそのまま呼ぶ (`--api-key` 不要)

**`--api-key` 経由** (有料 Hoppy CLI アドオン必須、通常プランでは "User API keys are not supported" / "No CLI addon found" と弾かれる):
1. 1P の Agentic API key (User API key ではない) を `op://Personal/CODERABBIT_API_KEY/credential` に保存
2. 親シェルで解決して env var で渡す (codex sandbox は 1P デスクトップアプリの IPC socket に到達できないので `op run -- ...` を codex 内から直接呼ぶのは失敗する):

```bash
CODERABBIT_API_KEY="$(op read 'op://Personal/CODERABBIT_API_KEY/credential')" \
  codex exec --full-auto \
    -c 'sandbox_workspace_write.network_access=true' \
    -c 'sandbox_workspace_write.writable_roots=["/Users/chanu/.coderabbit"]' \
    - < prompt.md
```

3. codex 内では `coderabbit review --agent --api-key "$CODERABBIT_API_KEY"` と呼ぶ (env var 単体では CLI は honor しないので flag 渡しが必須)

### よくあるエラーと原因

| エラー | 原因 |
|---|---|
| `Authentication required` | `~/.coderabbit/` が読めない or `--api-key` 未指定。sandbox 設定か OAuth ログインを確認 |
| `Invalid or expired API key` | 1P に保存された key が古い。再発行して更新 |
| `User API keys are not supported for the CLI` | User API key を渡した。**Agentic API key** をダッシュボードで発行 |
| `No CLI addon found` | 通常プランでは API key 経由 CLI が使えない。OAuth 保存トークン経由に戻す |
| `ConnectionRefused` to `posthog.com` | codex sandbox の network_access を有効化していない |
| `EPERM unlink ~/.coderabbit/logs/...` | `writable_roots` に `~/.coderabbit` を含めていない |

### findings の整形

```bash
grep '"type":"finding"' findings.log | python3 -c '
import json, sys
for i, line in enumerate(sys.stdin, 1):
    f = json.loads(line)
    print(f"{i}. [{f[\"severity\"]}] {f[\"fileName\"]}")
    print(f"   {f[\"codegenInstructions\"].split(chr(10)+chr(10), 1)[-1][:200]}")'
```

## CodeRabbit への事前シグナル

`.coderabbit.yaml` の `path_instructions` で Phase scope ルールをプリロードしてある。自動レビュー時の誤爆を減らすためのガードレール。`CLAUDE.md` と同じ方針をレビュア視点で書く。

## 迷ったときの原則

- **安全側 (採用) に倒すのは correctness / security のみ**
- **抽象化 / 網羅性は却下側に倒す**
- 判断に悩むものは PR 本文に明示して human review に渡す
