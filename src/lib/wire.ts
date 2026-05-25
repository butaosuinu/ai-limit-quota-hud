/**
 * IPC 境界の正規化レイヤ。Rust は `Option<T>` を `serde_json` で JSON `null`
 * としてシリアライズするため、`invoke` / `listen` の payload には実行時 `null`
 * が含まれる。ここで `null → undefined` に正規化し、UI 側のコードは常に
 * `undefined` のみを扱えるようにする（AGENTS.md TypeScript Guidelines）。
 *
 * wire 形の型は `| null` を保持するが、これは型注釈であり値としての `null`
 * リテラルではない。
 */

import type { OverlaySettings, Position, UsageSnapshot } from "./types";

export type WireUsageSnapshot = Omit<
  UsageSnapshot,
  "limit" | "used" | "remaining" | "remainingPercent" | "resetAt" | "message"
> & {
  limit: number | null;
  used: number | null;
  remaining: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  message: string | null;
};

export type WireOverlaySettings = Omit<OverlaySettings, "position"> & {
  position: Position | null;
};

export function normalizeSnapshot(raw: WireUsageSnapshot): UsageSnapshot {
  return {
    ...raw,
    limit: raw.limit ?? undefined,
    used: raw.used ?? undefined,
    remaining: raw.remaining ?? undefined,
    remainingPercent: raw.remainingPercent ?? undefined,
    resetAt: raw.resetAt ?? undefined,
    message: raw.message ?? undefined,
  };
}

export function normalizeSnapshots(
  raw: readonly WireUsageSnapshot[],
): UsageSnapshot[] {
  return raw.map(normalizeSnapshot);
}

export function normalizeOverlaySettings(
  raw: WireOverlaySettings,
): OverlaySettings {
  return { ...raw, position: raw.position ?? undefined };
}
