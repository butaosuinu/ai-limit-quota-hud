import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupInvoke } from "../helpers/invokeMock";
import { setupListen } from "../helpers/eventBus";

type CapturedNode = { windowLabel: string };
type ReactElementLike = { props: Record<string, unknown> };

let captured: CapturedNode | null = null;

function isReactElementLike(node: unknown): node is ReactElementLike {
  return (
    typeof node === "object" &&
    node !== null &&
    "props" in node &&
    typeof (node as { props: unknown }).props === "object"
  );
}

function walkTree(node: unknown): void {
  if (!isReactElementLike(node)) return;
  const { props } = node;
  if (typeof props.windowLabel === "string") {
    captured = { windowLabel: props.windowLabel };
  }
  if ("children" in props) {
    const ch = props.children;
    if (Array.isArray(ch)) ch.forEach(walkTree);
    else walkTree(ch);
  }
}

vi.mock("react-dom/client", () => ({
  default: {
    createRoot: () => ({ render: walkTree }),
  },
  createRoot: () => ({
    render: () => {},
  }),
}));

beforeEach(() => {
  captured = null;
  document.body.innerHTML = '<div id="root"></div>';
  setupInvoke();
  setupListen();
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@tauri-apps/api/webviewWindow");
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
});

describe("main.tsx bootstrap", () => {
  it("mountsWithOverlayLabelWhenTauriInternalsMissing", async () => {
    // jsdom default: window exists, __TAURI_INTERNALS__ does not → overlay.
    await import("../../main");
    expect(captured?.windowLabel).toBe("overlay");
  });

  it("mountsWithLabelFromTauriWebviewWindowWhenRuntimeAvailable", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.doMock("@tauri-apps/api/webviewWindow", () => ({
      getCurrentWebviewWindow: () => ({ label: "settings" }),
    }));
    await import("../../main");
    expect(captured?.windowLabel).toBe("settings");
  });

  it("throwsWhenRootElementIsMissing", async () => {
    document.body.innerHTML = "";
    await expect(import("../../main")).rejects.toThrow(
      /Root element #root not found/u,
    );
  });
});
