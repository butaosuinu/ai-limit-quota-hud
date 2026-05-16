import { useAtomValue, useSetAtom } from "jotai";
import { type CSSProperties, useEffect, useState } from "react";

import {
  MAX_OPACITY,
  MIN_OPACITY,
  overlaySettingsAtom,
  updateOverlaySettingsAtom,
} from "../atoms/overlayAtoms";
import { DEFAULT_OVERLAY_SETTINGS, type OverlaySettings } from "../types";
import { Kbd } from "./Kbd";
import { SettingsRow } from "./SettingsRow";
import { ToggleSwitch } from "./ToggleSwitch";
import { WebviewProvidersPanel } from "./WebviewProvidersPanel";
import {
  CrosshairIcon,
  EyeIcon,
  LayersIcon,
  LockIcon,
  OpacityIcon,
  PointerIcon,
  ResetIcon,
  SearchIcon,
} from "./icons";

const OPACITY_STEP = 0.01;
const PERCENT_BASE = 100;

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Macintosh|iPhone|iPad/u.test(navigator.userAgent);
const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

type SliderStyle = CSSProperties & Record<`--${string}`, string>;

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

  const opacityPercent = Math.round(draftOpacity * PERCENT_BASE);
  const opacityFill =
    ((draftOpacity - MIN_OPACITY) / (MAX_OPACITY - MIN_OPACITY)) * PERCENT_BASE;
  const sliderStyle: SliderStyle = {
    "--slider-fill": `${opacityFill.toString()}%`,
  };

  return (
    <main className="settings" data-testid="settings-root">
      <header className="settings__header">
        <h1 className="settings__title">
          <span className="settings__title-mark" aria-hidden="true">
            Q
          </span>
          <span className="settings__title-text">QuotaHUD Settings</span>
        </h1>
        <div className="settings__search">
          <span className="settings__search-icon">
            <SearchIcon />
          </span>
          <input
            className="settings__search-input"
            placeholder="設定を検索…"
            disabled
            aria-label="設定を検索 (検索機能は今後追加予定)"
            type="search"
          />
          <Kbd keys={[MOD_KEY, "K"]} />
        </div>
      </header>

      <div className="settings__body">
        <section className="settings__section">
          <div className="settings__section-head">
            <span className="settings__section-label">Appearance</span>
          </div>
          <ul className="settings__card">
            <SettingsRow
              icon={<OpacityIcon />}
              title="不透明度"
              description="overlay 全体の透明度。15%〜100%"
              accessory={
                <span className="slider">
                  <span className="slider__value">{opacityPercent}%</span>
                  <input
                    id="opacity"
                    type="range"
                    className="slider__input"
                    min={MIN_OPACITY}
                    max={MAX_OPACITY}
                    step={OPACITY_STEP}
                    value={draftOpacity}
                    aria-label="overlay の不透明度"
                    style={sliderStyle}
                    onChange={(event) => {
                      setDraftOpacity(Number(event.currentTarget.value));
                    }}
                    onPointerUp={commitOpacity}
                    onKeyUp={commitOpacity}
                  />
                </span>
              }
            />
            <SettingsRow
              icon={<LayersIcon />}
              title="Compact モード"
              description="title / footer / reset 表示を畳んで 1 行サイズに収める"
              accessory={
                <ToggleSwitch
                  id="compact"
                  label="Compact モード"
                  checked={settings.compact}
                  onChange={toggle("compact")}
                />
              }
            />
            <SettingsRow
              icon={<LockIcon />}
              title="位置をロック"
              description="overlay のドラッグを無効化して意図しない移動を防ぐ"
              accessory={
                <ToggleSwitch
                  id="locked"
                  label="位置をロック"
                  checked={settings.locked}
                  onChange={toggle("locked")}
                />
              }
            />
            <SettingsRow
              icon={<PointerIcon />}
              title="クリックスルー"
              description={`マウス操作を背面に透過。${MOD_KEY} + Shift + \\ で即時切替`}
              accessory={
                <ToggleSwitch
                  id="click-through"
                  label="クリックスルー"
                  checked={settings.clickThrough}
                  onChange={toggle("clickThrough")}
                />
              }
            />
            <SettingsRow
              icon={<EyeIcon />}
              title="Overlay を表示"
              description="off にすると overlay ウィンドウを隠す (設定は保持)"
              accessory={
                <ToggleSwitch
                  id="visible"
                  label="Overlay を表示"
                  checked={settings.visible}
                  onChange={toggle("visible")}
                />
              }
            />
          </ul>
        </section>

        <section className="settings__section">
          <div className="settings__section-head">
            <span className="settings__section-label">Position</span>
          </div>
          <ul className="settings__card">
            <SettingsRow
              icon={<CrosshairIcon />}
              title="保存された位置"
              description="overlay をドラッグするとここに座標が保存される"
              accessory={
                settings.position === null ? (
                  <span className="mono-value mono-value--empty">未保存</span>
                ) : (
                  <span className="mono-value">
                    x: {settings.position.x.toString()} y:{" "}
                    {settings.position.y.toString()}
                  </span>
                )
              }
            />
          </ul>
        </section>

        <WebviewProvidersPanel />
      </div>

      <footer className="settings__footer">
        <div className="settings__footer-hint">
          <Kbd keys={[MOD_KEY, "⇧", "\\"]} />
          <span>クリックスルーをトグル</span>
        </div>
        <div className="settings__footer-actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              void updateSettings(DEFAULT_OVERLAY_SETTINGS);
            }}
          >
            <ResetIcon />
            Reset to defaults
          </button>
        </div>
      </footer>
    </main>
  );
}
