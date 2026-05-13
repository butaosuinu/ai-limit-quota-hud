import { useAtom, useAtomValue, useSetAtom } from "jotai";

import {
  clickThroughAtom,
  compactAtom,
  lockedAtom,
  opacityAtom,
  overlaySettingsAtom,
  resetSettingsAtom,
  visibleAtom,
} from "../atoms/overlayAtoms";

const OPACITY_STEP = 0.01;
const OPACITY_MIN = 0.15;
const OPACITY_MAX = 1;

export function SettingsPanel() {
  const settings = useAtomValue(overlaySettingsAtom);
  const [opacity, setOpacity] = useAtom(opacityAtom);
  const [compact, setCompact] = useAtom(compactAtom);
  const [clickThrough, setClickThrough] = useAtom(clickThroughAtom);
  const [locked, setLocked] = useAtom(lockedAtom);
  const [visible, setVisible] = useAtom(visibleAtom);
  const resetSettings = useSetAtom(resetSettingsAtom);

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
          不透明度 ({Math.round(opacity * 100)}%)
        </label>
        <input
          id="opacity"
          type="range"
          min={OPACITY_MIN}
          max={OPACITY_MAX}
          step={OPACITY_STEP}
          value={opacity}
          onChange={(event) => setOpacity(Number(event.currentTarget.value))}
        />
      </section>

      <section className="settings__group settings__group--row">
        <SettingToggle
          id="compact"
          label="Compact モード"
          checked={compact}
          onChange={setCompact}
        />
        <SettingToggle
          id="locked"
          label="位置をロック"
          checked={locked}
          onChange={setLocked}
        />
        <SettingToggle
          id="click-through"
          label="クリックスルー"
          checked={clickThrough}
          onChange={setClickThrough}
        />
        <SettingToggle
          id="visible"
          label="Overlay を表示"
          checked={visible}
          onChange={setVisible}
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
        <button type="button" onClick={() => resetSettings()}>
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
      <span>{label}</span>
    </label>
  );
}
