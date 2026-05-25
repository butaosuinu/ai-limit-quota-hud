import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { Trans } from "@lingui/react/macro";
import { useLingui } from "@lingui/react";
import { useAtomValue, useSetAtom } from "jotai";
import type { ReactNode } from "react";

import {
  deleteProviderDataAtom,
  isProviderEnabledAtom,
  openProviderLoginAtom,
  providerSettingsErrorAtom,
  setProviderEnabledAtom,
} from "../atoms/providerSettingsAtom";
import type { ProviderKind } from "../types";
import { SettingsRow } from "./SettingsRow";
import { ToggleSwitch } from "./ToggleSwitch";
import { ChatIcon, LoginIcon, SparkleIcon, TrashIcon } from "./icons";

/**
 * Settings UI for opt-in WebView-backed providers (PROJECT_SPEC §8.7).
 *
 * - Toggle persists via `set_provider_enabled`.
 * - Login button opens the provider's first-party visible login window
 *   (`open_provider_login_window`). Gated on the toggle being on.
 * - Delete button wipes the per-provider session store
 *   (`delete_provider_data`), forcing re-login on the next refresh.
 *
 * `helpTooltip` collapses into the row's info icon (title attr) so the panel
 * stays scannable; the previous inline help paragraph made every row feel
 * heavy.
 */
type ProviderEntry = {
  kind: ProviderKind;
  label: string;
  description: MessageDescriptor;
  help: MessageDescriptor;
  icon: ReactNode;
};

const PROVIDER_ENTRIES: readonly ProviderEntry[] = [
  {
    kind: "webview-claude-ai",
    label: "Claude (web)",
    description: msg`claude.ai/settings/usage を埋め込み WebView で読み取り、Pro/Max の 5h / weekly 残量を表示。confidence は常に low。`,
    help: msg`QuotaHUD は claude.ai 自身のログイン画面を表示し、パスワードや cookie を読み取りません。データは『削除』でいつでもクリアできます。`,
    icon: <SparkleIcon />,
  },
  {
    kind: "webview-chatgpt-codex",
    label: "ChatGPT Codex (web)",
    description: msg`chatgpt.com の Codex Cloud analytics を埋め込み WebView で読み取り、Plus/Pro/Codex agent の usage を表示。confidence は常に low。`,
    help: msg`QuotaHUD は chatgpt.com 自身のログイン画面を表示し、パスワードや cookie を読み取りません。データは『削除』でいつでもクリアできます。`,
    icon: <ChatIcon />,
  },
];

export function WebviewProvidersPanel() {
  const { _ } = useLingui();
  const isEnabled = useAtomValue(isProviderEnabledAtom);
  const setEnabled = useSetAtom(setProviderEnabledAtom);
  const openLogin = useSetAtom(openProviderLoginAtom);
  const deleteData = useSetAtom(deleteProviderDataAtom);
  const error = useAtomValue(providerSettingsErrorAtom);

  return (
    <section
      className="settings__section"
      data-testid="webview-providers-panel"
    >
      <div className="settings__section-head">
        <span className="settings__section-label">
          <Trans>WebView Providers</Trans>
        </span>
        <span className="settings__section-tag">
          <Trans>Opt-in · Low confidence</Trans>
        </span>
      </div>

      {error !== undefined && (
        <p
          className="provider-error"
          data-testid="webview-providers-error"
          role="alert"
        >
          {error}
        </p>
      )}

      <ul className="settings__card">
        {PROVIDER_ENTRIES.map((entry) => {
          const enabled = isEnabled(entry.kind);
          const chipClass = enabled ? "chip chip--on" : "chip chip--off";
          const providerLabel = entry.label;
          const toggleLabel = _(msg`${providerLabel} を有効化`);
          return (
            <SettingsRow
              key={entry.kind}
              testId={`webview-provider-${entry.kind}`}
              icon={entry.icon}
              title={entry.label}
              description={_(entry.description)}
              help={_(entry.help)}
              accessory={
                <>
                  <span
                    className={chipClass}
                    data-testid={`webview-status-${entry.kind}`}
                  >
                    {enabled ? <Trans>Enabled</Trans> : <Trans>Disabled</Trans>}
                  </span>
                  <ToggleSwitch
                    id={`enable-${entry.kind}`}
                    label={toggleLabel}
                    checked={enabled}
                    testId={`webview-toggle-${entry.kind}`}
                    onChange={(next) => {
                      void setEnabled({ kind: entry.kind, enabled: next });
                    }}
                  />
                </>
              }
              actions={
                <>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={!enabled}
                    data-testid={`webview-login-${entry.kind}`}
                    onClick={() => {
                      void openLogin(entry.kind);
                    }}
                  >
                    <LoginIcon />
                    <Trans>ログイン</Trans>
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    data-testid={`webview-delete-${entry.kind}`}
                    onClick={() => {
                      void deleteData(entry.kind);
                    }}
                  >
                    <TrashIcon />
                    <Trans>データを削除</Trans>
                  </button>
                </>
              }
            />
          );
        })}
      </ul>

      <p className="settings__note">
        <Trans>
          WebView providers は外部サイトの DOM
          を読み取って残量を表示するため、データは常に
          <code>confidence: low</code> としてマークされます。
        </Trans>
      </p>
    </section>
  );
}
