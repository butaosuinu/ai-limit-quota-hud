# QuotaHUD

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

`claude.ai` 上の **Claude (Pro/Max)** と `chatgpt.com` 上の **ChatGPT (Plus/Pro/Codex agent)** の残量を、デスクトップ上に常時表示する小さなクロスプラットフォーム overlay。**Tauri 2 + Rust** と **React + TypeScript + Vite** で構築されています。

🇺🇸 English: [README.md](./README.md)

## プロダクト紹介

| Overlay HUD                                                            | Settings                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| ![残量を水平ゲージで表示する透過 overlay HUD](docs/images/overlay.png) | ![Raycast 風 list-row レイアウトの Settings 画面](docs/images/settings.png) |

QuotaHUD は画面の隅に透過・常時最前面の HUD を常駐させます。有効化したプロバイダごとに 1 行の残量ゲージと `reset at …` のリセット時刻が並ぶので、長時間のコーディング中でもベンダーの web UI に切り替えずに残量を確認できます。Settings ウィンドウは通常のフォーカス可能なウィンドウで、overlay の調整（不透明度、クリックスルー、ロック、位置）と WebView プロバイダのログインフローを担当します。

## 注意: 表示される値はすべて推定値

出荷時点のすべてのプロバイダはベンダー自身の web UI から数値を読み取るため、表示される値はすべてレイアウト変更で壊れ得る**推定値**（`source=webview-scrape`、`confidence=low`）です。抽出に失敗した場合、QuotaHUD は推測せず行に `no-data` / `error` ステータスを表示します — 古い値や捏造した値を事実として提示することはありません。

## インストール

> macOS ビルドは **ad-hoc 署名** 済みです（Apple Developer ID / notarization はまだ未対応）。Windows ビルドは **未署名** です。リリースワークフローでは Apple / Windows のコード署名証明書は使用していません。

1. [GitHub Releases ページ](https://github.com/butaosuinu/ai-limit-quota-hud/releases)から OS 用の最新ビルドを取得。
2. インストール／展開:
   - **macOS** (`.dmg` / `.app.tar.gz`): ad-hoc 署名済みですが notarize されていないため、初回起動時のみ Gatekeeper の確認が出ます（「壊れているため開けません…ゴミ箱に入れてください」は出なくなります）。`.app` を右クリックして **開く** を選ぶ（macOS 15 Sequoia では一度開こうとしてから **システム設定 → プライバシーとセキュリティ → このまま開く** で許可）か、`/Applications/QuotaHUD.app` にコピー後 `xattr -dr com.apple.quarantine /Applications/QuotaHUD.app` を実行してください。
   - **Windows** (`.msi` / `.exe`): SmartScreen が「Windows によって PC が保護されました」と表示します。ビルドを信頼するなら **詳細情報** → **実行** をクリック。
   - **Linux** (`.AppImage` / `.deb`): AppImage は一度だけ `chmod +x QuotaHUD-*.AppImage` してから起動。`.deb` はシステムパッケージマネージャ経由でインストールします。
3. 初回起動で overlay ウィンドウが表示されます。tray メニュー、または Settings ウィンドウからプロバイダを設定してください。

ソースからビルドする場合は [開発](docs/DEVELOPMENT.md) を参照。

## アップデート

QuotaHUD は Tauri updater プラグインによる自動アップデートを内蔵しています。アプリ起動時に GitHub Releases を確認し、新しいバージョンがあればダウンロードして再起動を提案します。

- デフォルト ON: 起動のたびに自動チェックが走ります。
- オプトアウト: Settings → Updates → 「起動時に確認」トグルを OFF にしてください。

### updater 導入前ビルドからの移行

このリリース (`v0.0.0` 以前) より前のビルドをインストールしているユーザは、最初の updater 内蔵リリースだけは手動でダウンロードしてください — 旧バイナリには updater プラグインが組み込まれていません。

## overlay の使い方

QuotaHUD は 2 つのウィンドウを表示します:

- **Overlay** — 透過・常時最前面の HUD。ロック解除時はドラッグ移動可能、クリックスルー有効時はマウスイベントを透過。
- **Settings** — 不透明度スライダー、コンパクト／ロック／クリックスルー／可視性トグル、位置保存、「デフォルトに戻す」ボタンを持つ通常ウィンドウ。起動時は非表示で、tray から開きます。

### Tray メニュー

QuotaHUD はシステムトレイアイコンをインストールします (どの OS でも左クリックでメニューが開きます):

- **Show/Hide overlay** — アプリ終了なしで表示を切替。
- **Click-through** — 有効時は overlay をマウスイベントが透過。
- **Lock position** — 無効時に overlay がドラッグ可能になります。
- **Settings…** — Settings ウィンドウを開く。
- **Quit QuotaHUD** — アプリを終了。

### グローバルショートカット

`Cmd/Ctrl + Shift + \` でクリックスルーをトグルします。登録はベストエフォートで、他アプリが同じ chord を握っている場合は警告ログを出してそのまま起動を続行します。

overlay の状態 (不透明度、位置、各トグル) は OS 標準のアプリ設定ディレクトリ配下に JSON として保存されます。秘密情報はここに保存しません。

## WebView プロバイダ (opt-in)

QuotaHUD は各ベンダーの利用状況ページを埋め込み WebView で直接読み取ります。これらは **デフォルトで無効** で、**Settings → WebView プロバイダ** で明示的にトグルするまで一切のネットワーク通信は発生しません。

- **Claude (web)** — `claude.ai/settings/usage` を読み取り (Pro / Max プラン)。ページ上に Opus/Fable などのモデル別行が表示される場合はそれも含めます。本ビルドで実装済み。
- **ChatGPT Codex (web)** — `chatgpt.com` の Codex analytics を読み取り。UI トグルはありますが、バックエンドは別途着地予定 ([issue #31](https://github.com/butaosuinu/ai-limit-quota-hud/issues/31)) で、現状では Tauri コマンドがエラーを返します。

プロバイダを有効化すると、初回はベンダー自身のログインウィンドウが開き (QuotaHUD は独自のログインフォームを描画しません)、その後は非表示の WebView で更新されます。セッション cookie は OS ネイティブの WebView cookie store に保存され、**プロバイダデータを削除** ボタンで強制的に再ログイン状態にします。QuotaHUD はキーストローク、パスワード、個別 cookie 値を読み取りません。更新間隔やセッション分離のルールは [`docs/PROJECT_SPEC.md` §8](docs/PROJECT_SPEC.md#8-provider-architecture--opt-in-webview-providers) を参照。

**既知の制限:**

- **Cloudflare のチャレンジは更新を中断します。** `claude.ai` が「あなたが人間であることを確認」インターステイシャルを返した場合、回避を試みずエラーを返します。通常のブラウザで `claude.ai` を開いてチャレンジを解消後、更新をトリガーしてください。
- **ログインセッションの失効。** cookie store がエイジアウトした場合、次の更新は「session expired」を表示します。**Settings → WebView プロバイダ → ログイン** から再認証してください。

## OS 別 overlay の制限

- **macOS**: 透過 overlay は Tauri の private API に依存します。直配布バイナリでは許容されますが、Mac App Store には乗せられません。
- **Windows**: すべての仮想デスクトップでの永続表示は **保証されません** — OS ビルドによっては overlay が最後に表示されたデスクトップに留まることがあります。tray アイコンから再表示してください。
- **Linux**: X11 が主ターゲット。**Wayland はベストエフォート** — ほとんどのコンポジタが always-on-top / sticky ヒントを拒否するため、overlay があらゆる surface の上に浮かないことがあります。アプリはクラッシュせず安全に縮退します。

詳細とプラットフォーム固有の実装メモは [`docs/PROJECT_SPEC.md` §9](docs/PROJECT_SPEC.md#9-overlayplatform-implementation) を参照。

## プライバシーとセキュリティ

- テレメトリなし。利用データの自動アップロードもなし。
- ユーザが WebView プロバイダを opt-in しない限り、起動時のネットワーク通信はなし。
- QuotaHUD は API キー、OAuth トークン、プロキシ認証情報を扱いません。永続化される認証情報は opt-in WebView プロバイダ用の OS ネイティブ WebView cookie store のみで、QuotaHUD のコードは個別 cookie 値を読み取りません。「プロバイダデータを削除」でプロバイダ単位のセッションをワイプします。
- ベンダーのログインフロー中、よく知られた ID プロバイダ (Google、Apple、Microsoft、Okta、Cloudflare Access、GitHub など) へのリダイレクトはベンダーの認証に必要なため許可します。ログインリダイレクトチェーン外では、WebView は設定済みターゲットオリジンに制限されます。

## 抽出器の不具合報告

**サニタイズ済み** の DOM 抜粋とともに issue を作成してください (識別子、会話内容、アカウント固有情報を露呈するものはすべて削除)。生のページダンプは貼らないでください。

## 開発

ビルドコマンド・必要要件・CI 構成・ロードマップは [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) に記載しています。

## ライセンス

[MIT License](./LICENSE) © 2026 ぶた桔梗
