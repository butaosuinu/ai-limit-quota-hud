import { useAtomValue, useSetAtom } from "jotai";

import {
  deleteProviderDataAtom,
  isProviderEnabledAtom,
  openProviderLoginAtom,
  providerSettingsErrorAtom,
  setProviderEnabledAtom,
} from "../atoms/providerSettingsAtom";
import type { ProviderKind } from "../types";

/**
 * Settings UI for opt-in WebView-backed providers (PROJECT_SPEC §8.7).
 *
 * Renders one row per provider with:
 *
 * - Enable / disable toggle (persisted via `set_provider_enabled`).
 * - "Login" button that opens the provider's own visible login window
 *   (`open_provider_login_window`). Only useful when the provider is
 *   enabled, so we disable it while the toggle is off to make the gate
 *   explicit.
 * - "Delete provider data" button that wipes the per-provider session store
 *   (`delete_provider_data`). Forces re-login on the next refresh.
 *
 * The Codex row is rendered in this branch even though the Codex backend
 * lands separately (#31). It calls the same Tauri commands and exercises
 * the same Failure-sentinel pattern as Claude — keeping the UI in this PR
 * means the Codex PR only has to land Rust changes.
 */
type ProviderEntry = {
  kind: ProviderKind;
  label: string;
  description: string;
  helpTooltip: string;
};

const PROVIDER_ENTRIES: readonly ProviderEntry[] = [
  {
    kind: "webview-claude-ai",
    label: "Claude (web)",
    description:
      "claude.ai/settings/usage を埋め込み WebView で読み取り、Pro/Max の 5h / weekly 残量を表示します。confidence は常に low です。",
    helpTooltip:
      "QuotaHUD は claude.ai 自身のログイン画面を表示し、パスワードや cookie を読み取りません。データは『プロバイダのデータを削除』でいつでもクリアできます。",
  },
  {
    kind: "webview-chatgpt-codex",
    label: "ChatGPT Codex (web)",
    description:
      "chatgpt.com の Codex Cloud analytics を埋め込み WebView で読み取り、Plus/Pro/Codex agent の usage を表示します。confidence は常に low です。",
    helpTooltip:
      "QuotaHUD は chatgpt.com 自身のログイン画面を表示し、パスワードや cookie を読み取りません。データは『プロバイダのデータを削除』でいつでもクリアできます。",
  },
];

export function WebviewProvidersPanel() {
  const isEnabled = useAtomValue(isProviderEnabledAtom);
  const setEnabled = useSetAtom(setProviderEnabledAtom);
  const openLogin = useSetAtom(openProviderLoginAtom);
  const deleteData = useSetAtom(deleteProviderDataAtom);
  const error = useAtomValue(providerSettingsErrorAtom);

  return (
    <section
      className="settings__group webview-providers"
      data-testid="webview-providers-panel"
    >
      <header className="webview-providers__header">
        <h3>WebView プロバイダ (オプトイン)</h3>
        <p className="webview-providers__hint">
          QuotaHUD は外部サイトの DOM
          を読み取って残量を表示するため、データは常に
          <code>confidence: low</code>
          としてマークされます。各プロバイダはデフォルトで無効です。
        </p>
      </header>

      {error !== null && (
        <p
          className="webview-providers__error"
          data-testid="webview-providers-error"
          role="alert"
        >
          {error}
        </p>
      )}

      <ul className="webview-providers__list">
        {PROVIDER_ENTRIES.map((entry) => {
          const enabled = isEnabled(entry.kind);
          return (
            <li
              key={entry.kind}
              className="webview-providers__item"
              data-testid={`webview-provider-${entry.kind}`}
            >
              <div className="webview-providers__item-head">
                <label
                  className="webview-providers__toggle"
                  htmlFor={`enable-${entry.kind}`}
                >
                  <input
                    id={`enable-${entry.kind}`}
                    type="checkbox"
                    checked={enabled}
                    data-testid={`webview-toggle-${entry.kind}`}
                    onChange={(event) => {
                      void setEnabled({
                        kind: entry.kind,
                        enabled: event.currentTarget.checked,
                      });
                    }}
                  />
                  <span className="webview-providers__item-label">
                    {entry.label}
                  </span>
                </label>
                <span
                  className={`webview-providers__status webview-providers__status--${enabled ? "on" : "off"}`}
                  data-testid={`webview-status-${entry.kind}`}
                >
                  {enabled ? "有効" : "無効"}
                </span>
              </div>
              <p className="webview-providers__description">
                {entry.description}
              </p>
              <p
                className="webview-providers__help"
                title={entry.helpTooltip}
                aria-label={entry.helpTooltip}
              >
                {entry.helpTooltip}
              </p>
              <div className="webview-providers__actions">
                <button
                  type="button"
                  disabled={!enabled}
                  data-testid={`webview-login-${entry.kind}`}
                  onClick={() => {
                    void openLogin(entry.kind);
                  }}
                >
                  ログイン
                </button>
                <button
                  type="button"
                  data-testid={`webview-delete-${entry.kind}`}
                  onClick={() => {
                    void deleteData(entry.kind);
                  }}
                >
                  プロバイダのデータを削除
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
