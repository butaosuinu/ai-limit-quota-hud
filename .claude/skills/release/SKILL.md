---
name: release
description: QuotaHUD の新バージョンをリリースする手順。基本は `/release` での明示起動。加えて「リリースして」「v0.0.4 を出して」「最新 main をリリース」「バージョンを上げて公開」など、バージョン発行・タグ付け・GitHub Release 作成・updater 配信に関わる依頼でも使う。version bump(4 ファイル)→ PR(人間がマージ)→ merge commit にタグ push → release.yml が draft 生成 → 日本語リリースノート → 人間が publish、という固定フローと 2 つの人間ゲートを守る。
---

# QuotaHUD リリース

このフローは `/release` での明示起動を基本とする。`/release v0.0.4` のように対象バージョンを渡せる。

QuotaHUD のリリースはタグ push でしか起動しない（`.github/workflows/release.yml` が `v*` タグで全 OS をビルドし draft リリースを作る）。version 番号・タグ・GitHub Release・Tauri updater 配信がすべて連動するため、手順とゲートを外すと updater が壊れたり「壊れた」リリースが公開される。落ち着いて順番に進めること。

## 2 つの人間ゲート（最重要）

agent は次の 2 つを**絶対に自動実行しない**。CI が green でも、mergeable でも、人間の操作を待つ。

1. **bump PR のマージ** — 人間が行う。
2. **draft リリースの publish** — 人間が行う（publish した瞬間に updater 配信が始まる）。

agent の担当は「bump PR の作成」→（人間がマージ）→「タグ push」→「draft への日本語リリースノート反映」まで。publish 直前で必ず停止して人間に渡す。

## 全体像

```
[agent] 4 ファイル bump → precheck → commit → push → PR 作成
   ↓
[人間]  PR をマージ
   ↓
[agent] origin/main を fetch → merge commit に vX.Y.Z タグ push
   ↓
release.yml が全 OS ビルド → draft リリース自動作成（固定英語本文）
   ↓
[agent] draft 本文を日本語リリースノートに差し替え → latest.json を確認
   ↓
[人間]  draft をレビューして publish（updater 配信開始）
```

---

## Step 0: 対象バージョンの決定

- ユーザーがバージョンを明示（例 `v0.0.4` / `0.0.4`）したらそれを使う。
- 無指定なら直近タグから patch を 1 上げた値を**既定として提示し確認**する。

```bash
git tag --list 'v*' | sort -V | tail -1   # 直近リリースタグ
```

以降 `X.Y.Z`（タグは `vX.Y.Z`）と表記する。

## Step 1: プリフライト確認

```bash
git fetch origin --tags -q
git rev-parse --abbrev-ref HEAD            # 作業ブランチ
git status -s                              # clean か
git log --oneline -1 origin/main           # リリース対象の HEAD
git tag --list vX.Y.Z                      # 空 = 未作成（既存なら中断して相談）
```

確認事項:
- 対象タグ `vX.Y.Z` が**未作成**であること。
- ワークツリーが clean で、作業ブランチが origin/main 基点であること（マージ済みの古いブランチは使わず、必要なら `git checkout -b feat/bump-vX.Y.Z origin/main`）。
- 現状 4 ファイルの version が直近リリースと一致していること（途中状態でないこと）。

## Step 2 (Phase A): バージョン bump PR

### 2-1. 4 ファイルすべてを `X.Y.Z` に更新

| ファイル | 対象 |
| --- | --- |
| `package.json` | `"version"` |
| `src-tauri/Cargo.toml` | `[package]` の `version` |
| `src-tauri/tauri.conf.json` | トップレベルの `"version"` |
| `src-tauri/Cargo.lock` | `name = "quotahud"` エントリ直下の `version`（単一エントリ） |

最小 diff にするため当該行を直接 Edit する（sed や lockfile 全再生成はしない）。**4 ファイル全部を必ず揃える** — 1 つでも漏れると updater が報告する version と `latest.json` が食い違い、自動更新が壊れる。

確認:
```bash
git diff --stat   # 4 ファイル各 1 行のはず
```

### 2-2. precheck（PR 前必須ゲート）

```bash
pnpm precheck     # typecheck + lint + format:check
```

green でなければ PR を作らない（AGENTS.md の規約）。version bump だけなら通常そのまま通る。

### 2-3. コミット

メッセージは過去のリリース bump に倣う（日本語 + Co-Authored-By）:

```
chore: vX.Y.Z へバージョン bump

package.json / Cargo.toml / tauri.conf.json / Cargo.lock の version を
A.B.C から X.Y.Z に更新。updater が正しいバージョンを報告し latest.json も
X.Y.Z になるようにするためのリリース用 bump。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

### 2-4. push & PR 作成（本文は日本語）

直近タグ以降の変更を集めて PR 本文に要約する:

```bash
git log <直近タグ>..origin/main --oneline   # 含まれる変更
gh pr view <PR番号> --json title,body        # 各 PR の内容を確認
```

`gh pr create --base main` で日本語タイトル・本文。本文には「変更要約（PR 番号付き）」と「このPRマージ後のリリース手順メモ」を含める。

### 2-5. 停止して人間のマージを待つ

ここで一旦止め、PR URL と「マージしたら教えてください」を伝える。CI（typecheck / lint / test / cargo test ×3 OS）が green になるのを確認するとよい。**自分でマージしない。**

---

## Step 3 (Phase B): タグ push（人間のマージ後）

```bash
git fetch origin --tags -q
git log --oneline -3 origin/main
git show origin/main:package.json | grep '"version"'   # X.Y.Z を確認
```

origin/main の version が `X.Y.Z` であることを確認してから、その merge commit を指す annotated タグを作る:

```bash
git tag -a vX.Y.Z <merge commit SHA> -m "QuotaHUD vX.Y.Z"
git push origin vX.Y.Z
```

タグは**必ず version=X.Y.Z を含む post-merge commit** を指すこと。bump 前の commit に付けると古い version でビルドされる。

push 後、release.yml の起動とビルドを監視:

```bash
gh run list --workflow=release.yml --limit 3
gh run watch <run-id> --exit-status --interval 20
```

macOS / Windows / Linux の 3 ジョブがすべて success になれば draft リリースが出来ている（前回実績で 6〜8 分程度）。

---

## Step 4 (Phase C): リリースノート反映 → 人間が publish

release.yml は draft を**固定の英語本文**（"Alpha build …"）で作る。これを日本語ノートに差し替える。

### 4-1. アセットと latest.json の sanity check

```bash
gh release view vX.Y.Z --json isDraft,isPrerelease,assets \
  -q '"draft=" + (.isDraft|tostring) + " prerelease=" + (.isPrerelease|tostring) + "\n" + ([.assets[].name] | join("\n"))'
```

`latest.json` + 各 OS バンドル + `.sig` が揃い、`latest.json` の version が `X.Y.Z` であることを確認する（`gh release download vX.Y.Z -p latest.json -D /tmp/... --clobber` で取得して中身を見る）。

### 4-2. 日本語リリースノートに差し替え

```bash
gh release edit vX.Y.Z --notes "<日本語ノート>"
```

ノートの型（過去リリースに準拠）:

```
QuotaHUD vX.Y.Z（macOS は ad-hoc 署名済み・未公証、Windows は未署名の alpha build）。直前バージョンからの主な変更点です。

## 修正 / 新機能 / 改善 / ドキュメント   ← 該当する分類だけ
- **見出し** (#PR番号): 変更内容を簡潔に。

---

## インストール時の注意
- **macOS**: ad-hoc 署名済み・未公証。初回は右クリック →「開く」（macOS 15 はシステム設定 → プライバシーとセキュリティ →「このまま開く」）。
- **Windows**: 未署名。SmartScreen は「詳細情報」→「実行」。
- **Linux**: `.AppImage` は `chmod +x` が必要な場合あり。`.deb` / `.rpm` も提供。

> v0.0.2 以降は Settings → Updates の自動更新から本バージョンへ更新できます。配布物は minisign 署名され latest.json 経由で検証されます。
```

### 4-3. 停止して人間に publish を渡す

draft の URL（publish 前はタグ未確定 URL）と「内容を確認して publish してください」を伝える。**自分で publish しない。**

---

## 規約と背景（why）

- **日本語**: PR 本文・タイトル・リリースノートは日本語で書く。
- **precheck ゲート**: PR 前に `pnpm precheck` green が必須。
- **4 ファイル同期の理由**: updater が報告する version（Cargo.toml/tauri.conf.json）と `latest.json`（ビルド時の version）が一致しないと自動更新が誤動作する。`package.json` / `Cargo.lock` も含め 4 つを揃える。
- **タグ = post-merge commit**: ビルドはタグの commit を checkout する。bump がその commit に含まれていないと古い version のバイナリが出る。
- **maintainer-publish ゲート**: release.yml は `releaseDraft: true` / `prerelease: false`。draft と prerelease は `releases/latest` から除外されるため、人間が publish して初めて updater に配信される。

署名鍵（minisign）の生成・GitHub secrets・ローテーション手順は重複させない。`docs/PROJECT_SPEC.md` §12.3 と `docs/DEVELOPMENT.md` を参照する。
