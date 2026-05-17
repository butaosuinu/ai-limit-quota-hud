# ACCEPTANCE_CHECKLIST.md — QuotaHUD

Use this checklist before opening a PR, tagging a release, or claiming a phase is complete.

## Global checks

- [ ] No Python dependency exists in `package.json`, `Cargo.toml`, CI, build scripts, test scripts, or docs as a required step.
- [ ] Frontend is React + TypeScript + Vite, not Svelte/Vue/Solid.
- [ ] Shared frontend state, if present, uses Jotai atoms/derived atoms rather than Redux/Zustand/Recoil/MobX.
- [ ] No secrets are stored in React state or Jotai atoms. Session cookies live only in the OS-native WebView cookie store (see PROJECT_SPEC §10.2).
- [ ] `pnpm install` succeeds.
- [ ] `pnpm lint` succeeds or has a documented temporary exception.
- [ ] `pnpm test` succeeds.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` succeeds.
- [ ] `pnpm tauri dev` launches the app.
- [ ] `pnpm tauri build` builds on the current OS.
- [ ] All provider results include `source` and `confidence`.
- [ ] Provider errors are shown as row/status errors, not process crashes.
- [ ] No telemetry or hidden network calls happen by default.

## Overlay behavior

- [ ] Overlay is undecorated.
- [ ] Overlay can be transparent or semi-transparent.
- [ ] Overlay supports opacity adjustment.
- [ ] Overlay can be always-on-top.
- [ ] Overlay can be click-through.
- [ ] Click-through can be disabled through tray/menu or shortcut.
- [ ] Overlay can be moved when unlocked.
- [ ] Overlay position persists after restart.
- [ ] Overlay can be hidden/restored.
- [ ] Overlay does not appear as a noisy normal taskbar/Alt-Tab window where avoidable.

## Virtual desktop/workspace checks

### macOS

- [ ] Overlay remains visible when switching Spaces.
- [ ] Overlay remains usable when a normal app is full-screen, or the limitation is documented.
- [ ] Transparent-window private API setting is documented if enabled.

### Windows

- [ ] Overlay is topmost above normal windows.
- [ ] Overlay does not steal focus in normal use.
- [ ] Click-through works.
- [ ] Virtual desktop behavior has been tested.
- [ ] If all-desktops behavior is not fully reliable, there is a safe fallback and a visible documented limitation.

### Linux

- [ ] X11 behavior has been tested when available.
- [ ] Wayland degraded behavior is documented when necessary.
- [ ] App does not crash if the compositor refuses topmost/sticky behavior.

## Provider checks

### WebView providers (opt-in, see PROJECT_SPEC §8)

> Status: `webview-claude-ai` provider implemented (issue #30); the
> `webview-chatgpt-codex` provider lands in #31. The boxes below cover the
> Claude provider where backend work is complete; Codex equivalents stay
> unchecked until #31.

- [x] Each WebView provider is **disabled by default**. No external network
      activity occurs until the user toggles it on in Settings.
- [x] The first-time enable opens a **visible** login window pointing at the
      provider's own login URL. QuotaHUD does not render its own login form
      and does not read or store credentials.
- [x] The post-login refresh window is created with `visible=false`,
      `focused=false`, `decorations=false`, and `resizable=false` on every
      platform. On Windows / Linux it additionally has `skip_taskbar=true`.
      On macOS `skip_taskbar` is omitted (not supported by Tauri 2 on
      macOS); the non-visible NSWindow does not appear in the dock as a
      consequence of `visible=false`. The window must not appear in the
      macOS dock, the Windows taskbar, or the Linux taskbar.
- [x] Cookie persistence is scoped per provider using a platform-specific
      mechanism: `data_directory(app_data_dir/webview-<provider>/)` on
      Windows / Linux, and a deterministic `dataStoreIdentifier` plus
      `WKWebsiteDataStore` on macOS (see PROJECT_SPEC §8). The macOS <14
      fallback is documented as a known limitation in the README.
- [x] A "Delete provider data" action forces re-login on the next refresh on
      every supported platform: removes `webview-<provider>/` on Windows /
      Linux, and removes the `dataStoreIdentifier`-scoped
      `WKWebsiteDataStore` (or per-origin records on macOS <14) on macOS.
      *(macOS: best-effort — see README "Known limitations" — the next
      refresh tick calls `clear_all_browsing_data` because Tauri 2 does not
      yet expose a public API to drop the per-identifier
      `WKWebsiteDataStore`.)*
- [x] A Cloudflare challenge surfaces as `SnapshotStatus::Error` with a
      human-readable message, not a crash.
- [x] A redirect to `/login` surfaces as `SnapshotStatus::NoData` with a
      message indicating that re-login is required, and the Settings UI
      re-enables the "Login" action.
- [x] An extractor returning `null` due to a DOM layout change surfaces as
      `SnapshotStatus::Error` and feeds the scheduler's exponential backoff.
- [x] Every WebView-derived `UsageSnapshot` row carries
      `source=webview-scrape` and `confidence=low` in its serialized form.
      The disclosure that values are webview-scrape estimates lives in
      `README.md` (data-source caveat table) and the Settings window's
      WebView providers panel rather than on every overlay row, so the
      overlay stays glanceable. Per-row badges are intentionally omitted.
- [x] The configured `min_refresh_interval` is **at least 300 seconds** for
      WebView providers (default 600 seconds).
- [x] The internal Tauri IPC (`__TAURI__`) is not reachable from the external
      origin loaded in the WebView. *(Result channel uses
      `document.title` + the `QHJSON:` prefix; no `__TAURI__` plumbing is
      injected into external origins.)*
- [x] During login, redirects to well-known identity providers (Google,
      Apple, Microsoft, Okta, Cloudflare Access, GitHub, etc.) are allowed
      so that the provider's first-party login flow completes (see
      PROJECT_SPEC §14).
- [x] After login completes, the WebView is allowed to fetch resources
      from a constrained set of provider-owned supporting hosts (CDN,
      static-asset, and first-party XHR API domains declared in the
      provider implementation, for example `*.anthropic.com` for the
      Claude provider or `*.openai.com` / `cdn.oaistatic.com` for the
      Codex provider). Requests to hosts outside this list and outside an
      active login redirect chain are blocked at the WebView's navigation
      or resource-request layer.
- [x] No QuotaHUD code reads or inspects individual cookies inside the
      provider's session store (the `webview-<provider>/` directory on
      Windows / Linux, or the per-`dataStoreIdentifier` `WKWebsiteDataStore`
      on macOS).

## Release checks

- [ ] GitHub Actions CI runs for macOS, Windows, and Linux.
- [ ] Release workflow uploads artifacts.
- [ ] README explains unsigned-app warnings if signing is not configured.
- [ ] README explains that WebView snapshots are estimates (`confidence=low`).
- [ ] README explains privacy model.
