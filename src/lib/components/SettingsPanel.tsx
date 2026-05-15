import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";

import {
  overlaySettingsAtom,
  updateOverlaySettingsAtom,
} from "../atoms/overlayAtoms";
import {
  deleteProviderDataAtom,
  isProviderEnabledAtom,
  openProviderLoginAtom,
  providerSettingsErrorAtom,
  setProviderEnabledAtom,
} from "../atoms/providerSettingsAtom";
import {
  DEFAULT_OVERLAY_SETTINGS,
  type OverlaySettings,
  type ProviderKind,
} from "../types";
import { ManualRowsPanel } from "./ManualRowsPanel";

const OPACITY_STEP = 0.01;
const OPACITY_MIN = 0.15;
const OPACITY_MAX = 1;

export function SettingsPanel() {
  const settings = useAtomValue(overlaySettingsAtom);
  const updateSettings = useSetAtom(updateOverlaySettingsAtom);

  // Slider drives a local value during drag so the IPC fires only on release.
  const [draftOpacity, setDraftOpacity] = useState(settings.opacity);
  useEffect(() => {
    setDraftOpacity(settings.opacity);
  }, [settings.opacity]);

  const commitOpacity = () => {
    if (draftOpacity !== settings.opacity) {
      void updateSettings({ opacity: draftOpacity });
    }
  };

  const toggle = (field: keyof OverlaySettings) => (value: boolean) => {
    const partial: Partial<OverlaySettings> = { [field]: value };
    void updateSettings(partial);
  };

  return (
    <main className="settings" data-testid="settings-root">
      <header className="settings__header">
        <h1>QuotaHUD Settings</h1>
        <p className="settings__hint">
          overlay の外観と挙動、および manual provider の行を編集できます。API
          プロバイダは Phase 3 以降で追加されます。
        </p>
      </header>

      <section className="settings__group">
        <label className="settings__label" htmlFor="opacity">
          不透明度 ({Math.round(draftOpacity * 100)}%)
        </label>
        <input
          id="opacity"
          type="range"
          min={OPACITY_MIN}
          max={OPACITY_MAX}
          step={OPACITY_STEP}
          value={draftOpacity}
          onChange={(event) =>
            setDraftOpacity(Number(event.currentTarget.value))
          }
          onPointerUp={commitOpacity}
          onKeyUp={commitOpacity}
        />
      </section>

      <section className="settings__group settings__group--row">
        <SettingToggle
          id="compact"
          label="Compact モード"
          checked={settings.compact}
          onChange={toggle("compact")}
        />
        <SettingToggle
          id="locked"
          label="位置をロック"
          checked={settings.locked}
          onChange={toggle("locked")}
        />
        <SettingToggle
          id="click-through"
          label="クリックスルー"
          checked={settings.clickThrough}
          onChange={toggle("clickThrough")}
        />
        <SettingToggle
          id="visible"
          label="Overlay を表示"
          checked={settings.visible}
          onChange={toggle("visible")}
        />
      </section>

      <section className="settings__group">
        <h2>現在位置</h2>
        <p className="settings__position">
          {settings.position
            ? `x: ${settings.position.x}, y: ${settings.position.y}`
            : "(まだ未保存。overlay をドラッグすると保存されます)"}
        </p>
      </section>

      <ManualRowsPanel />

      <WebviewProvidersPanel />

      <footer className="settings__footer">
        <button
          type="button"
          onClick={() => {
            void updateSettings(DEFAULT_OVERLAY_SETTINGS);
          }}
        >
          Reset to defaults
        </button>
        <p className="settings__shortcut-hint">
          グローバルショートカット: Cmd/Ctrl + Shift + \ で
          クリックスルーをトグル
        </p>
      </footer>
    </main>
  );
}

type ToggleProps = {
  id: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
};

function SettingToggle({ id, label, checked, onChange }: ToggleProps) {
  return (
    <label className="settings__toggle" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      {label}
    </label>
  );
}

/**
 * WebView-backed provider opt-in section (PROJECT_SPEC §8.7).
 *
 * Each row is **off by default**. Toggling it on persists the opt-in flag
 * in `provider_settings.json`; clicking "Login" opens a visible WebView
 * window pointing at the provider's first-party login; "Delete data"
 * clears the provider's persistent session so the next refresh forces a
 * fresh login.
 *
 * PR #31 (this branch) wires up the Codex (ChatGPT) row. PR #30 will add
 * a sibling row for `webview-claude-ai`. The two PRs target the same
 * section so conflicts here are expected and resolved during rebase.
 */
function WebviewProvidersPanel() {
  const isEnabled = useAtomValue(isProviderEnabledAtom);
  const settingsError = useAtomValue(providerSettingsErrorAtom);
  const setEnabled = useSetAtom(setProviderEnabledAtom);
  const openLogin = useSetAtom(openProviderLoginAtom);
  const deleteData = useSetAtom(deleteProviderDataAtom);

  return (
    <section
      className="settings__group settings__group--webview"
      data-testid="webview-providers-panel"
    >
      <h2>WebView プロバイダ (opt-in)</h2>
      <p className="settings__hint">
        サブスクリプション枠の usage を取得するため、QuotaHUD
        内蔵の WebView から各プロバイダのページを参照します。利用は明示的な
        opt-in が必要で、初回はベンダー自身のログインページで認証してください
        (PROJECT_SPEC §8.7)。
      </p>

      <WebviewProviderRow
        kind="webview-chatgpt-codex"
        label="Codex (ChatGPT)"
        description="https://chatgpt.com/codex/cloud/settings/analytics から 5h / weekly の残量を取得します。"
        enabled={isEnabled("webview-chatgpt-codex")}
        onToggle={(next) => {
          void setEnabled({ kind: "webview-chatgpt-codex", enabled: next });
        }}
        onLogin={() => {
          void openLogin("webview-chatgpt-codex");
        }}
        onDelete={() => {
          void deleteData("webview-chatgpt-codex");
        }}
      />

      {settingsError !== null && (
        <p
          className="settings__error"
          data-testid="webview-providers-error"
          role="alert"
        >
          {settingsError}
        </p>
      )}
    </section>
  );
}

type WebviewProviderRowProps = {
  kind: ProviderKind;
  label: string;
  description: string;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  onLogin: () => void;
  onDelete: () => void;
};

function WebviewProviderRow({
  kind,
  label,
  description,
  enabled,
  onToggle,
  onLogin,
  onDelete,
}: WebviewProviderRowProps) {
  const toggleId = `webview-provider-toggle-${kind}`;
  return (
    <div className="settings__webview-row" data-testid={`webview-row-${kind}`}>
      <div className="settings__webview-row-main">
        <SettingToggle
          id={toggleId}
          label={label}
          checked={enabled}
          onChange={onToggle}
        />
        <p className="settings__webview-row-description">{description}</p>
      </div>
      <div className="settings__webview-row-actions">
        <button
          type="button"
          disabled={!enabled}
          onClick={onLogin}
          data-testid={`webview-row-${kind}-login`}
        >
          ログイン
        </button>
        <button
          type="button"
          disabled={!enabled}
          onClick={onDelete}
          data-testid={`webview-row-${kind}-delete`}
        >
          データ削除
        </button>
      </div>
    </div>
  );
}
