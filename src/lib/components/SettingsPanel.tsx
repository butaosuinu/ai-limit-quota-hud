import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";

import {
  overlaySettingsAtom,
  updateOverlaySettingsAtom,
} from "../atoms/overlayAtoms";
import { DEFAULT_OVERLAY_SETTINGS, type OverlaySettings } from "../types";

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
          Phase 1 では overlay の外観と挙動のみ調整できます。プロバイダ設定は
          Phase 2 以降で追加されます。
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
