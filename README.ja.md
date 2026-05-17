# QuotaHUD

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

`claude.ai` 上の **Claude (Pro/Max)** と `chatgpt.com` 上の **ChatGPT (Plus/Pro/Codex agent)** の残量を、デスクトップ上に常時表示する小さなクロスプラットフォーム overlay。**Tauri 2 + Rust** と **React + TypeScript + Vite** で構築されています。

🇺🇸 English: [README.md](./README.md)

## プロダクト紹介

| Overlay HUD | Settings |
| --- | --- |
| ![残量を水平ゲージで表示する透過 overlay HUD](docs/images/overlay.png) | ![Raycast 風 list-row レイアウトの Settings 画面](docs/images/settings.png) |

QuotaHUD は画面の隅に透過・常時最前面の HUD を常駐させます。有効化したプロバイダごとに 1 行の残量ゲージと `reset at …` のリセット時刻が並ぶので、長時間のコーディング中でもベンダーの web UI に切り替えずに残量を確認できます。Settings ウィンドウは通常のフォーカス可能なウィンドウで、overlay の調整（不透明度、クリックスルー、ロック、位置）と WebView プロバイダのログインフローを担当します。

> ステータス: **Phase 1 (overlay UX) + Phase 3 (CI / リリースパッケージング)。** overlay はインタラクティブで、tray メニュー・クリックスルー切替・グローバルショートカット・ドラッグ/ロック・独立した Settings ウィンドウすべてが動作します。WebView プロバイダ (Phase 2) を実装中。詳細は `docs/PROJECT_SPEC.md` §8 / §13 を参照。

## データソースに関する注意

QuotaHUD は内部的にすべてのスナップショットを `source` と `confidence` のラベル付きで管理し、「推定値」と「実測値」が混在しないようにしています。**出荷時点のすべてのプロバイダはベンダーの web UI を scrape している**ため、以下の値はすべてレイアウト変更で壊れ得る推定値です。

| `source`         | `confidence` | 中身                                                                       | 扱い         |
| ---------------- | ------------ | -------------------------------------------------------------------------- | ------------ |
| `webview-scrape` | `low`        | opt-in WebView 内でベンダーの利用状況ページから DOM 抽出した値             | **推定値**   |
| `unavailable`    | —            | プロバイダは設定済みだが信頼できる値をまだ取得できていない (`NoData` / `Error`) | 主張なし     |

overlay 上のすべての行に `low` / `webview` バッジを描画することはしません。この開示はこの表と Settings ウィンドウの opt-in トグル横で行います。スナップショットのステータス (`warning` / `critical` / `no-data` / `error`) と関連 `message` は引き続き行に表示され、ユーザが急性条件に対応できるようになっています。Phase 1 では live row は表示されません。WebView プロバイダは Phase 2 で着地します。

## インストール

> Developer ID / Windows コード署名のセットアップが整うまでリリースは **未署名** です。バイナリは GitHub Actions のリリースワークフローで生成されますが、署名や notarization のための鍵は使用されません。

1. [GitHub Releases ページ](https://github.com/butaosuinu/ai-limit-quota-hud/releases)から OS 用の最新ビルドを取得。
2. インストール／展開:
   - **macOS** (`.dmg` / `.app.tar.gz`): notarize されていないため、初回起動時に Gatekeeper が拒否します。`.app` を右クリックして **開く** を選ぶか、`/Applications/QuotaHUD.app` にコピー後 `xattr -dr com.apple.quarantine /Applications/QuotaHUD.app` を実行してください。
   - **Windows** (`.msi` / `.exe`): SmartScreen が「Windows によって PC が保護されました」と表示します。ビルドを信頼するなら **詳細情報** → **実行** をクリック。
   - **Linux** (`.AppImage` / `.deb`): AppImage は一度だけ `chmod +x QuotaHUD-*.AppImage` してから起動。`.deb` はシステムパッケージマネージャ経由でインストールします。
3. 初回起動で overlay ウィンドウが表示されます。tray メニュー、または Settings ウィンドウからプロバイダを設定してください (Phase 2 以降)。

ソースからビルドする場合は下記 [開発](#開発) を参照。

## 必要要件

- **Rust** stable (1.93+ で動作確認)
- **Node.js** 20+ と **pnpm** 10+
- macOS / Windows / Linux。Phase 1 は macOS でのみ動作検証済み。

## 開発

```bash
pnpm install
pnpm tauri dev       # overlay ウィンドウを起動
pnpm tauri build     # 現在の OS 向けに配布物をビルド
```

その他のスクリプト:

```bash
pnpm typecheck       # tsc --noEmit
pnpm lint            # oxlint + eslint
pnpm test            # vitest
cargo test --manifest-path src-tauri/Cargo.toml
```

CI は `typecheck` / `lint` / `test` / `cargo test` を **4 つの独立ジョブとして並列実行** します (`cargo test` は macOS/Windows/Linux のマトリクス)。`pnpm tauri build` は意図的に CI に含めず、リリースワークフロー (`v*` タグで起動) が `tauri-apps/tauri-action` を使って全 OS の実バンドルを生成します。これで PR CI を軽く保ちつつリリース時には全 OS をカバーします。

## overlay の使い方

Phase 1 では 2 つのウィンドウを出荷します:

- **`overlay`** — 透過・常時最前面の HUD。ロック解除時はドラッグ移動可能、クリックスルー有効時はマウスイベントを透過。サンプル行は静的。
- **`settings`** — 不透明度スライダー、コンパクト／ロック／クリックスルー／可視性トグル、位置保存、「デフォルトに戻す」ボタンを持つ通常ウィンドウ。起動時は非表示で、tray から開きます。

### Tray メニュー

QuotaHUD はシステムトレイアイコンをインストールします (どの OS でも左クリックでメニューが開きます):

- **Show/Hide overlay** — アプリ終了なしで表示を切替。
- **Click-through** — チェックボックス。有効時は overlay をマウスイベントが透過。
- **Lock position** — チェックボックス。無効時に overlay がドラッグ可能になります。
- **Settings…** — Settings ウィンドウを開く。
- **Quit QuotaHUD** — アプリを終了。

### グローバルショートカット

`Cmd/Ctrl + Shift + \` でクリックスルーをトグルします。登録はベストエフォートで、他アプリが同じ chord を握っている場合は警告ログを出してそのまま起動を続行します。

### 設定の永続化

overlay の状態 (不透明度、コンパクト、クリックスルー、ロック、可視性、位置、コーナー／マージン) は OS 標準のアプリ設定ディレクトリ配下に JSON として保存されます:

- macOS: `~/Library/Application Support/dev.quotahud.app/settings.json`
- Windows: `%APPDATA%/dev.quotahud.app/settings.json`
- Linux: `$XDG_CONFIG_HOME/dev.quotahud.app/settings.json` (または `~/.config/...`)

ここには秘密情報は保存しません。プロバイダのトークンは将来 OS の credential store を経由します。

## プロバイダ

Phase 1 ではプロバイダ統合は出荷されません。Phase 2 (詳細は `docs/PROJECT_SPEC.md` §8 / §13) で 2 つの opt-in WebView プロバイダを追加します:

- **`webview-claude-ai`** — `https://claude.ai/settings/usage` を独立 WebView セッションで読み込み、表示中の残量数値を scrape。
- **`webview-chatgpt-codex`** — `https://chatgpt.com/codex/cloud/settings/analytics` を同様に読み込み。

両プロバイダは **デフォルトで無効** です。Settings から有効化すると、初回はベンダーのログインウィンドウが可視で開き (QuotaHUD は独自のログインフォームを描画しません)、その後は非表示の WebView で 600 秒既定 (300 秒下限) で更新されます。セッション cookie は OS ネイティブの WebView cookie store に保存され、「プロバイダデータを削除」ボタンで強制的に再ログイン状態にします。すべてのスナップショットは `source=webview-scrape`、`confidence=low`。

## WebView プロバイダ (opt-in)

v1 から QuotaHUD は **opt-in** の WebView ベースプロバイダをサポートします。各ベンダーの利用状況ページを埋め込み Tauri WebView で直接読み取ります。これらは **デフォルトで無効** で、**Settings → WebView プロバイダ** で明示的にトグルするまで一切のネットワーク通信は発生しません。

- **Claude (web)** — `claude.ai/settings/usage` を読み取り (Pro / Max プラン)。本ビルドで実装済み (`webview-claude-ai`)。
- **ChatGPT Codex (web)** — `chatgpt.com` の Codex analytics を読み取り。バックエンドは別途着地予定 ([issue #31](https://github.com/butaosuinu/ai-limit-quota-hud/issues/31))。UI トグルはあるが、現状では Tauri コマンドがエラーを返します。

すべての WebView スナップショットには `source = webview-scrape`、`confidence = low` のラベルが付きます。第三者 web アプリの DOM 契約は **安定したインターフェースではない** ため、ページレイアウトが変わった場合は推測せず `Error` か `NoData` にフォールバックします。

**Hard rules (詳細は `docs/PROJECT_SPEC.md` §8.7):**

- 更新間隔は既定 600 s、下限 300 s。ベンダーサイトをそれより速くポーリングしません。
- 非表示の更新ウィンドウは `visible=false`、`focused=false`、`decorations=false`、`resizable=false`。Windows / Linux では `skip_taskbar=true` も追加します。macOS の AppKit `NSWindow` にはウィンドウ単位の taskbar 概念がないため `visible=false` だけで十分です。
- Tauri の内部 IPC (`__TAURI__`) は **`claude.ai` に公開しません**。抽出 JS は `document.title` 経由でのみ結果を報告し、QuotaHUD はキーストローク、パスワード、個別 cookie 値を読み取りません。

### 既知の制限

- **macOS の WKWebView セッション削除はベストエフォート。** Tauri 2 / Wry は per-provider 分離のために `data_store_identifier([u8; 16])` を公開していますが、後から `WKWebsiteDataStore` を削除する公開 API は **提供していません**。そのため macOS の **プロバイダデータを削除** ボタンは警告ログを出し、次回更新で in-process WebView の `clear_all_browsing_data` 呼び出しに頼ります。macOS 13 以前では `dataStoreIdentifier` 単位のストアは launch をまたいで永続化されません。これはユーザが「データ削除」が見えない cookie store をワイプすると誤解しないよう、ここに明記しています。Windows / Linux ではアプリデータディレクトリ配下の `webview-<provider>/` を単に `rm -rf` します。
- **Cloudflare のチャレンジは更新を中断します。** `claude.ai` が「あなたが人間であることを確認」インターステイシャルを返した場合、回避を試みず `SnapshotStatus::Error` を返します。通常のブラウザで `claude.ai` を開いてチャレンジを解消後、overlay から更新をトリガーしてください。
- **ログインセッションの失効。** cookie store がエイジアウトした場合、次の更新は `SnapshotStatus::NoData` (`session expired`) を返します。**Settings → WebView プロバイダ → ログイン** から可視ウィンドウで再認証してください。

## OS 別 overlay の制限

- **macOS**: 透過 overlay は Tauri の `macOSPrivateApi: true` に依存します。直配布バイナリでは許容されますが、Mac App Store には乗せられません。Phase 1 のネイティブフックは AppKit にすべての Space に参加しフルスクリーンアプリの上に滞在するよう要求します (`NSWindowCollectionBehavior::CanJoinAllSpaces | Stationary | FullScreenAuxiliary`)。
- **Windows**: Tauri の `skipTaskbar` + `alwaysOnTop` は尊重されますが、Win32 レベルの磨き上げ (`WS_EX_TOOLWINDOW`、仮想デスクトップフォールバック、`WS_EX_NOACTIVATE`) は Phase 2 以降に持ち越し。**Windows のすべての仮想デスクトップでの永続表示は保証されません** — OS ビルドによっては overlay が最後に表示されたデスクトップに留まることがあります。tray アイコンから再表示するのが回避策です。この制限は隠さず明記します。
- **Linux**: X11 が主ターゲット。EWMH 準拠のウィンドウマネージャは Tauri の `alwaysOnTop` を尊重します。**Wayland はベストエフォート** — ほとんどのコンポジタが `alwaysOnTop` / sticky ヒントを拒否し、overlay があらゆる surface の上に浮かないことがあります。ヒントが拒否されてもアプリはクラッシュせず、機能を縮退させるだけです。起動時に検出した `XDG_SESSION_TYPE` をログに出すので、bug report で縮退動作を識別できます。

## プライバシーとセキュリティ

- テレメトリなし。利用データの自動アップロードもなし。
- ユーザが WebView プロバイダを opt-in しない限り、起動時のネットワーク通信はなし。
- QuotaHUD は API キー、OAuth トークン、プロキシ認証情報を扱いません。永続化される認証情報は opt-in WebView プロバイダ用の OS ネイティブ WebView cookie store のみで、QuotaHUD のコードは個別 cookie 値を読み取りません。「プロバイダデータを削除」でプロバイダ単位のセッションをワイプします。
- ベンダーのログインフロー中、よく知られた ID プロバイダ (Google、Apple、Microsoft、Okta、Cloudflare Access、GitHub など) へのリダイレクトはベンダーの認証に必要なため許可します。ログインリダイレクトチェーン外では、WebView は設定済みターゲットオリジンに制限されます。

## ロードマップ / 今後の作業

追跡中ですが、本リリースには **含まれない** もの:

- **macOS Developer ID 署名 + notarization** で直配布の `.dmg` / `.app.tar.gz` を署名 (現状は未署名)。
- **Windows コード署名** で `.msi` / `.exe` の SmartScreen 摩擦を解消。
- **Tauri updater** によるアプリ内アップデート — 上記署名鍵とリリースホスティングの決定に依存。
- WebView プロバイダ統合 (`webview-claude-ai`、`webview-chatgpt-codex`) — `docs/PROJECT_SPEC.md` §13 Phase 2 を参照。

## 抽出器の不具合報告

**サニタイズ済み** の DOM 抜粋とともに issue を作成してください (識別子、会話内容、アカウント固有情報を露呈するものはすべて削除)。生のページダンプは貼らないでください。

## ライセンス

[MIT License](./LICENSE) © 2026 ぶた桔梗
