import { afterEach, describe, expect, it } from "vitest";
import { Provider, createStore } from "jotai";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { resetInvoke, setupInvoke } from "../helpers/invokeMock";
import { setupListen } from "../helpers/eventBus";
import { flush } from "../helpers/flush";
import { overlaySettingsAtom } from "../../lib/atoms/overlayAtoms";
import { SettingsPanel } from "../../lib/components/SettingsPanel";
import { withI18n } from "../../test/i18nTestUtils";
import {
  DEFAULT_OVERLAY_SETTINGS,
  OVERLAY_SETTINGS_CHANGED_EVENT,
  type OverlaySettings,
} from "../../lib/types";

async function mountSettings(
  initial: Partial<OverlaySettings> = {},
  invokeMap: Record<string, unknown> = {},
) {
  const merged: OverlaySettings = { ...DEFAULT_OVERLAY_SETTINGS, ...initial };
  setupInvoke({ get_overlay_settings: merged, ...invokeMap });
  const store = createStore();
  store.set(overlaySettingsAtom, merged);
  const rendered = render(
    withI18n(
      <Provider store={store}>
        <SettingsPanel />
      </Provider>,
    ),
  );
  // Let bootstrap (get_overlay_settings + get_provider_settings) settle before
  // any user interaction so we don't race a deferred setState onto a clicked
  // state.
  await act(async () => {
    await flush();
  });
  return { store, ...rendered };
}

afterEach(() => {
  resetInvoke();
});

describe("SettingsPanel integration — opacity slider", () => {
  it("displaysCurrentOpacityFromAtomOnMount", async () => {
    setupListen();
    const { store } = await mountSettings({ opacity: 0.5 });
    const slider = screen.getByLabelText(
      "overlay の不透明度",
    ) as HTMLInputElement;
    expect(Number(slider.value)).toBeCloseTo(0.5);
    expect(store.get(overlaySettingsAtom).opacity).toBe(0.5);
  });

  it("keepsAtomOpacityUnchangedDuringSliderDrag", async () => {
    setupListen();
    const { store } = await mountSettings({ opacity: 0.5 });
    const slider = screen.getByLabelText(
      "overlay の不透明度",
    ) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "0.8" } });
    await flush();
    expect(store.get(overlaySettingsAtom).opacity).toBe(0.5);
  });

  it("propagatesOpacityToAtomOnPointerUp", async () => {
    setupListen();
    const { store } = await mountSettings({ opacity: 0.5 });
    const slider = screen.getByLabelText(
      "overlay の不透明度",
    ) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "0.9" } });
    fireEvent.pointerUp(slider);
    await flush();
    expect(store.get(overlaySettingsAtom).opacity).toBeCloseTo(0.9);
  });

  it("propagatesOpacityToAtomOnKeyUp", async () => {
    setupListen();
    const { store } = await mountSettings({ opacity: 0.5 });
    const slider = screen.getByLabelText(
      "overlay の不透明度",
    ) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "0.3" } });
    fireEvent.keyUp(slider);
    await flush();
    expect(store.get(overlaySettingsAtom).opacity).toBeCloseTo(0.3);
  });

  it("skipsAtomWriteWhenSliderReleasedAtSameValue", async () => {
    setupListen();
    const { store } = await mountSettings({ opacity: 0.72 });
    const before = store.get(overlaySettingsAtom);
    const slider = screen.getByLabelText(
      "overlay の不透明度",
    ) as HTMLInputElement;
    // No change event between mount and pointerUp — draft equals settings, so
    // commitOpacity() bails out before calling updateSettings(): the atom
    // reference stays identical.
    fireEvent.pointerUp(slider);
    await flush();
    expect(store.get(overlaySettingsAtom)).toBe(before);
  });

  it("resyncsSliderWhenAtomOpacityChangesExternally", async () => {
    setupListen();
    const { store } = await mountSettings({ opacity: 0.5 });
    await act(async () => {
      store.set(overlaySettingsAtom, {
        ...DEFAULT_OVERLAY_SETTINGS,
        opacity: 0.3,
      });
    });
    const slider = screen.getByLabelText(
      "overlay の不透明度",
    ) as HTMLInputElement;
    expect(Number(slider.value)).toBeCloseTo(0.3);
  });
});

describe("SettingsPanel integration — toggles", () => {
  const cases: Array<{ name: keyof OverlaySettings; label: string }> = [
    { name: "compact", label: "Compact モード" },
    { name: "locked", label: "位置をロック" },
    { name: "clickThrough", label: "クリックスルー" },
    { name: "visible", label: "Overlay を表示" },
  ];

  for (const { name, label } of cases) {
    it(`persists${name}TogglesToAtomOnChange`, async () => {
      setupListen();
      const { store } = await mountSettings({
        [name]: false,
      } as Partial<OverlaySettings>);
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect(input.checked).toBe(false);
      await act(async () => {
        fireEvent.click(input);
      });
      await flush();
      expect(store.get(overlaySettingsAtom)[name]).toBe(true);
    });
  }
});

describe("SettingsPanel integration — saved position", () => {
  it("showsUnsavedLabelWhenAtomPositionIsNull", async () => {
    setupListen();
    await mountSettings({ position: null });
    expect(screen.getByText("未保存")).toBeTruthy();
  });

  it("showsCoordinatesWhenAtomPositionIsSet", async () => {
    setupListen();
    await mountSettings({ position: { x: 123, y: 456 } });
    expect(screen.getByText(/x: 123 y: 456/u)).toBeTruthy();
  });
});

describe("SettingsPanel integration — reset", () => {
  it("restoresDefaultsWhenResetButtonClicked", async () => {
    setupListen();
    const { store } = await mountSettings({
      opacity: 0.3,
      compact: true,
      locked: false,
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /Reset to defaults/u }),
      );
    });
    await flush();
    const next = store.get(overlaySettingsAtom);
    expect(next.opacity).toBe(DEFAULT_OVERLAY_SETTINGS.opacity);
    expect(next.compact).toBe(DEFAULT_OVERLAY_SETTINGS.compact);
    expect(next.locked).toBe(DEFAULT_OVERLAY_SETTINGS.locked);
  });
});

describe("SettingsPanel integration — atom event bus", () => {
  it("reflectsRemoteSettingsChangedEventInSliderValue", async () => {
    const bus = setupListen();
    const { store } = await mountSettings();
    await act(async () => {
      bus.emit(OVERLAY_SETTINGS_CHANGED_EVENT, {
        settings: { ...DEFAULT_OVERLAY_SETTINGS, opacity: 0.42 },
      });
    });
    expect(store.get(overlaySettingsAtom).opacity).toBeCloseTo(0.42);
    const slider = screen.getByLabelText(
      "overlay の不透明度",
    ) as HTMLInputElement;
    expect(Number(slider.value)).toBeCloseTo(0.42);
  });
});
