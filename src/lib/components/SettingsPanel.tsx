import { msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLingui } from "@lingui/react";
import { useAtomValue, useSetAtom } from "jotai";
import { type CSSProperties, useEffect, useRef, useState } from "react";

import {
  MAX_OPACITY,
  MIN_OPACITY,
  overlaySettingsAtom,
  updateOverlaySettingsAtom,
} from "../atoms/overlayAtoms";
import {
  type Locale,
  SUPPORTED_LOCALES,
  activateLocale,
  isSupported,
  persistLocale,
} from "../i18n";
import {
  DEFAULT_OVERLAY_SETTINGS,
  MENU_BAR_SUMMARY_MODES,
  type MenuBarSummaryMode,
  type OverlaySettings,
} from "../types";
import { Kbd } from "./Kbd";
import { SettingsRow } from "./SettingsRow";
import { ToggleSwitch } from "./ToggleSwitch";
import { UpdatesPanel } from "./UpdatesPanel";
import { WebviewProvidersPanel } from "./WebviewProvidersPanel";
import {
  CrosshairIcon,
  EyeIcon,
  GlobeIcon,
  LayersIcon,
  LockIcon,
  MenuBarIcon,
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

const LOCALE_LABELS: Readonly<Record<Locale, string>> = {
  ja: "日本語",
  en: "English",
};

function isMenuBarSummaryMode(value: string): value is MenuBarSummaryMode {
  return MENU_BAR_SUMMARY_MODES.some((mode) => mode === value);
}

export function SettingsPanel() {
  const { i18n, _ } = useLingui();
  const settings = useAtomValue(overlaySettingsAtom);
  const updateSettings = useSetAtom(updateOverlaySettingsAtom);
  const localeActivation = useRef<AbortController | undefined>(undefined);

  // Abort an in-flight locale activation when the panel unmounts so a late
  // dynamic import can't activate a stale locale and overwrite a newer choice
  // made after reopening the settings window.
  useEffect(() => () => localeActivation.current?.abort(), []);

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

  const modKey = MOD_KEY;
  const compactToggleLabel = _(msg`Compact モード`);
  const lockedToggleLabel = _(msg`位置をロック`);
  const clickThroughToggleLabel = _(msg`クリックスルー`);
  const visibleToggleLabel = _(msg`Overlay を表示`);
  const languageLabel = _(msg`表示言語`);
  const menuBarLabel = _(msg`メニューバー簡易表示`);

  return (
    <main className="settings" data-testid="settings-root">
      <header className="settings__header">
        <h1 className="settings__title">
          <span className="settings__title-mark" aria-hidden="true">
            Q
          </span>
          <span className="settings__title-text">
            <Trans>QuotaHUD Settings</Trans>
          </span>
        </h1>
        <div className="settings__search">
          <span className="settings__search-icon">
            <SearchIcon />
          </span>
          <input
            className="settings__search-input"
            placeholder={_(msg`設定を検索…`)}
            disabled
            aria-label={_(msg`設定を検索 (検索機能は今後追加予定)`)}
            type="search"
          />
          <Kbd keys={[MOD_KEY, "K"]} />
        </div>
      </header>

      <div className="settings__body">
        <section className="settings__section">
          <div className="settings__section-head">
            <span className="settings__section-label">
              <Trans>言語</Trans>
            </span>
          </div>
          <ul className="settings__card">
            <SettingsRow
              icon={<GlobeIcon />}
              title={languageLabel}
              description={_(msg`English と 日本語 を切り替えます。`)}
              accessory={
                <select
                  className="select"
                  value={i18n.locale}
                  aria-label={languageLabel}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    if (!isSupported(next)) return;
                    persistLocale(next);
                    localeActivation.current?.abort();
                    const controller = new AbortController();
                    localeActivation.current = controller;
                    void activateLocale({
                      locale: next,
                      signal: controller.signal,
                    });
                  }}
                >
                  {SUPPORTED_LOCALES.map((locale) => (
                    <option key={locale} value={locale}>
                      {LOCALE_LABELS[locale]}
                    </option>
                  ))}
                </select>
              }
            />
          </ul>
        </section>

        <section className="settings__section">
          <div className="settings__section-head">
            <span className="settings__section-label">
              <Trans>Appearance</Trans>
            </span>
          </div>
          <ul className="settings__card">
            <SettingsRow
              icon={<OpacityIcon />}
              title={_(msg`不透明度`)}
              description={_(msg`overlay 全体の透明度。15%〜100%`)}
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
                    aria-label={_(msg`overlay の不透明度`)}
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
              title={_(msg`Compact モード`)}
              description={_(
                msg`title / footer / reset 表示を畳んで 1 行サイズに収める`,
              )}
              accessory={
                <ToggleSwitch
                  id="compact"
                  label={compactToggleLabel}
                  checked={settings.compact}
                  onChange={toggle("compact")}
                />
              }
            />
            <SettingsRow
              icon={<LockIcon />}
              title={_(msg`位置をロック`)}
              description={_(
                msg`overlay のドラッグを無効化して意図しない移動を防ぐ`,
              )}
              accessory={
                <ToggleSwitch
                  id="locked"
                  label={lockedToggleLabel}
                  checked={settings.locked}
                  onChange={toggle("locked")}
                />
              }
            />
            <SettingsRow
              icon={<PointerIcon />}
              title={_(msg`クリックスルー`)}
              description={_(
                msg`マウス操作を背面に透過。${modKey} + Shift + \\ で即時切替`,
              )}
              accessory={
                <ToggleSwitch
                  id="click-through"
                  label={clickThroughToggleLabel}
                  checked={settings.clickThrough}
                  onChange={toggle("clickThrough")}
                />
              }
            />
            <SettingsRow
              icon={<EyeIcon />}
              title={_(msg`Overlay を表示`)}
              description={_(
                msg`off にすると overlay ウィンドウを隠す (設定は保持)`,
              )}
              accessory={
                <ToggleSwitch
                  id="visible"
                  label={visibleToggleLabel}
                  checked={settings.visible}
                  onChange={toggle("visible")}
                />
              }
            />
            <SettingsRow
              icon={<MenuBarIcon />}
              title={menuBarLabel}
              description={
                IS_MAC
                  ? _(
                      msg`macOS のメニューバーに Claude / Codex の 5h リミット残量を表示`,
                    )
                  : _(msg`macOS のみ対応`)
              }
              accessory={
                <select
                  id="menu-bar-summary"
                  className="select"
                  aria-label={menuBarLabel}
                  disabled={!IS_MAC}
                  value={settings.menuBarSummary}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    if (isMenuBarSummaryMode(next)) {
                      void updateSettings({ menuBarSummary: next });
                    }
                  }}
                >
                  <option value="off">OFF</option>
                  <option value="always">{_(msg`常に表示`)}</option>
                  <option value="when-hidden">
                    {_(msg`HUD 非表示時のみ`)}
                  </option>
                </select>
              }
            />
          </ul>
        </section>

        <section className="settings__section">
          <div className="settings__section-head">
            <span className="settings__section-label">
              <Trans>Position</Trans>
            </span>
          </div>
          <ul className="settings__card">
            <SettingsRow
              icon={<CrosshairIcon />}
              title={_(msg`保存された位置`)}
              description={_(
                msg`overlay をドラッグするとここに座標が保存される`,
              )}
              accessory={
                settings.position === null ? (
                  <span className="mono-value mono-value--empty">
                    <Trans>未保存</Trans>
                  </span>
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

        <UpdatesPanel />

        <WebviewProvidersPanel />
      </div>

      <footer className="settings__footer">
        <div className="settings__footer-hint">
          <Kbd keys={[MOD_KEY, "⇧", "\\"]} />
          <span>
            <Trans>クリックスルーをトグル</Trans>
          </span>
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
            <Trans>Reset to defaults</Trans>
          </button>
        </div>
      </footer>
    </main>
  );
}
