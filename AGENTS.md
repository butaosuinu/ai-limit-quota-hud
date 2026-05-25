# AGENTS.md — AI Quota Overlay / QuotaHUD

## Mission

Build a small cross-platform Tauri 2 desktop app that shows remaining AI subscription-usage headroom (Claude Pro/Max, ChatGPT Plus/Pro/Codex agent) via opt-in WebView providers in a transparent, always-visible overlay.

The app is tentatively named `QuotaHUD`. Rename only if the repository already has a different name.

## Hard requirements

- Use Tauri 2 for the desktop app.
- Produce distributable binaries/installers for macOS, Windows, and Linux.
- Do not require Python at runtime, during normal development, in tests, in build scripts, or in CI.
- Prefer Rust for backend/platform code and TypeScript + React + Vite for UI. Do not scaffold Svelte/Vue/Solid.
- Show an overlay window that can be always-on-top, transparent, click-through, and visible across virtual desktops/workspaces where the OS supports it.
- Support multiple provider/account rows through a provider adapter interface.
- v1 ships opt-in WebView providers only; session cookies live in the OS-native WebView cookie store (per-provider `data_directory` on Windows/Linux, `dataStoreIdentifier` on macOS 14+). QuotaHUD code must not read individual cookie values. See `docs/PROJECT_SPEC.md` §8 / §10.2 / §14.
- Treat every WebView snapshot as `source=webview-scrape`, `confidence=low`. Failure modes (Cloudflare challenge, login redirect, DOM layout change) must surface as `SnapshotStatus::Error` / `NoData`, never crashes.

## Before editing

Read these files first:

1. `docs/PROJECT_SPEC.md`
2. `docs/ACCEPTANCE_CHECKLIST.md`
3. `docs/IMPLEMENTATION_PROMPTS.md` when you need task-by-task prompts

## Default stack

- Package manager: `pnpm`
- Frontend: TypeScript, React, Vite
- Frontend state: Jotai for shared state when needed; React local state for component-local concerns
- Backend: Rust stable, Tauri 2
- Rust async/http: `tokio`, `reqwest` with rustls where practical
- Serialization/time: `serde`, `serde_json`, `time` or `chrono`
- Persistence: small JSON files (e.g. `provider_settings.json`) under the platform app-config dir; avoid SQLite or ORMs until a feature requires them
- Session storage: OS-native WebView cookie store, isolated per provider (see PROJECT_SPEC §8 / §10.2). No keyring or API-key handling in v1.
- Tests: `cargo test`, `vitest`, small deterministic fixtures

## Commands the project should support

Use these exact scripts unless the repository has a strong reason not to:

```bash
pnpm install
pnpm dev
pnpm tauri dev
pnpm lint
pnpm test
pnpm build
pnpm tauri build
cargo test --manifest-path src-tauri/Cargo.toml
```

## Coding rules

- Keep provider collection code isolated from UI rendering.
- Use React function components and hooks. Keep component-local state with `useState`/`useReducer`; use Jotai atoms only for shared UI/app state such as overlay settings, provider snapshots, connection status, and selected provider/account.
- Keep Jotai atoms small and typed. Put atoms under `src/lib/atoms/` or `src/state/`, and avoid storing secrets in frontend atoms.
- Every provider result must include `source` and `confidence`.
- Use typed DTOs shared conceptually between Rust and TypeScript. Do not pass anonymous unvalidated JSON through the UI.
- Error states must be visible in the UI without crashing the overlay.
- No telemetry by default.
- No network call should happen on startup unless the user configured a provider that requires it.
- Exception: the Tauri updater plugin performs a startup check by default. Users can opt out via Settings → Updates.
- Avoid polling faster than necessary. Default provider refresh interval should be configurable and no faster than 60 seconds.
- Make platform-specific overlay behavior explicit in `src-tauri/src/platform/`.

## Review expectations

Before considering work complete:

- Run relevant Rust and frontend tests.
- Run format/lint where configured.
- Verify the app starts with `pnpm tauri dev`.
- Update docs when architecture, limitations, or build commands change.
- If an OS-specific feature is unsupported or flaky, document the limitation and leave the code path safe rather than pretending it works.

## General coding guidelines

- 過剰なコメントは禁止。
- 作業ログ的なコメントは禁止。
- `oxfmt` がファイル保存時（`.claude/hooks/format-on-edit.sh`）に整形するため、保存時に内容が変わってもフォーマット起因なので気にしない。

## Static analysis workflow

- 自動: `oxfmt` / `oxlint` が Edit/Write のたびに hook で実行される（手動実行不要）。
- ファイル変更が完了したら、`pnpm typecheck`（`tsc --noEmit`）と `pnpm lint`（`oxlint` + `eslint`）を手動実行すること。
- `npx tsc --noEmit path/to/file.ts` のような単発実行は `tsconfig.json` 設定が無視されるため使わない。型チェックは常にプロジェクトの `tsconfig.json` 経由で行う。
- PR 作成前に `pnpm precheck`（typecheck + lint + format:check）を必ず実行する。エラーが残った状態での PR 作成は禁止。

## i18n (Lingui)

- `src/` 配下でユーザーに表示される文字列は、必ず Lingui マクロで囲むこと。ハードコードした文字列の直書きは禁止。
  - JSX コンテンツ: `<Trans>テキスト</Trans>`（`@lingui/react/macro`）
  - 属性値（placeholder, aria-label, title 等）: `t` マクロ（`@lingui/react/macro` の `useLingui`）
  - 定数・ラベル定義: `msg` マクロ（`@lingui/core/macro`）
- 例外: overlay ウィンドウのコンポーネント（`src/lib/components/Overlay.tsx` / `UsageRow.tsx` / `ErrorBadge.tsx`）は対象外。overlay 起動パスを i18n オーバーヘッドゼロに保つため Lingui ランタイムは settings ウィンドウだけで dynamic import しており（`src/main.tsx` 参照）、overlay は英語固定 UI とする。これらのファイルは `lingui.config.ts` の `include` にも含めない。
- UI テキスト変更後の手順: `pnpm i18n:extract` で PO を更新 → `src/locales/en/messages.po` の未翻訳エントリ（`msgstr ""`）に翻訳を記入 → `pnpm i18n:compile` でコンパイル済みファイルを再生成。
- `sourceLocale` は `ja`、対象ロケールは `ja` / `en`（`lingui.config.ts`）。

## TypeScript conventions

TypeScript フロントエンドコードに適用する規約。多くは `eslint.config.js` の `typescript-eslint` strict / `eslint-config-love` / `eslint-plugin-functional` で既に強制されている。

- バレルファイル（`index.ts` / `index.tsx` による re-export）は禁止。常に直接ファイルパスで import する。
- `any` 型は禁止。型アサーション（Type Assertion）は禁止。`type` を `interface` より優先する。型名は PascalCase。
- `let` は原則禁止で `const` を優先。宣言済みオブジェクトのプロパティのミュータブル更新は禁止。`for` よりも `map` / `filter` 等の高階関数を優先し、配列・オブジェクトはイミュータブルに更新する。
- 命名規則: 変数・関数は camelCase、定数は UPPER_SNAKE_CASE、クラス・型は PascalCase。
- `null` は DOM 関連の返り値を扱う場合以外は禁止。値がない場合は常に `undefined` を使う。ただし null/undefined を同時に弾く目的の `変数 != null` は許可。
- boolean 以外の変数で `!変数名` のような曖昧な比較を避け、`===` で厳密に比較する。
- マジックナンバー・マジック文字列は禁止。`Object.freeze()` + `as const` で定数化する。
- RORO パターン（Receive an Object, Return an Object）を用いる。
- 非同期処理は `await` + `.catch()` を使う。`try/catch` は禁止、`Promise.then().catch()` も禁止。

## Testing standards

- Kent C. Dodds の Testing Trophy に従う（Static Analysis → Unit → Integration → E2E）。**Integration テストを最重要**とする。
- Unit テストは純粋関数・ビジネスロジックのみ（モックは最小限）。Integration テストは React コンポーネントの実ユーザー操作を中心に据える。
- Detroit 学派に従い過度なモックを避ける。モックは境界（IPC / FS / 時計）のみに留め、観測は state / output で行う（インタラクション検証は避ける）。
- カバレッジは目的でなく最低保証。**branch coverage 最低 90%** を floor とし、`pnpm test:coverage` で計測する。floor を下回る場合は不足分のテストを追加してから PR を作成する。例外的に未達のまま進める場合は PR 説明に理由を必ず明記する（自動的なスキップ・閾値の引き下げは禁止）。
- 集約モックや共通テストヘルパーは `src/test` 等にまとめ、各テストでの再実装や個別 `vi.mock` の乱用を避ける。
