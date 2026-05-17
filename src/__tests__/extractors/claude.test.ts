import { afterEach, describe, expect, it, vi } from "vitest";

import { CLAUDE_JS, resetExtractorEnv, runExtractor } from "./extractorHarness";

const FIXED_NOW = new Date("2026-05-13T12:00:00.000Z");

afterEach(resetExtractorEnv);

describe("claude.js — challenge / login detection", () => {
  it("emitsCloudflareChallengeWhenBodyContainsVerifyHuman", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: "<div>Verify you are human by completing the action below.</div>",
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(false);
    expect(payload).toMatchObject({ kind: "cloudflare-challenge" });
  });

  it("emitsCloudflareChallengeWhenBodyContainsJustAMomentAndCloudflare", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: "<div>Just a moment...</div><div>Powered by Cloudflare</div>",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "cloudflare-challenge" });
  });

  it("emitsLoggedOutWhenPathnameStartsWithLogin", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: "<p>nothing here</p>",
      path: "/login",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "logged-out" });
  });

  it("emitsLoggedOutWhenLoginAnchorPresent", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: '<a href="/login">Sign in</a>',
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "logged-out" });
  });
});

describe("claude.js — extract rows", () => {
  it("emitsNoRowsFinalAfterRetryBudgetExhaustedOnEmptyPage", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: "<p>nothing of interest</p>",
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(false);
    // The retry budget (~15 × 700 ms) was exceeded — Rust treats this as
    // terminal, not transient.
    expect(payload).toMatchObject({ kind: "no-rows-final" });
  });

  it("classifiesFiveHoursWindowFromEnglishContext", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <div>
          <div>5-hour session usage</div>
          <div>30%</div>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]).toMatchObject({
      windowKind: "five-hours",
      percentUsed: 30,
    });
  });

  it("classifiesWeeklyWindowFromEnglishContext", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <div>
          <div>Weekly usage</div>
          <div>45%</div>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]).toMatchObject({ windowKind: "weekly", percentUsed: 45 });
  });

  it("classifiesWeeklyOpusWindowFromOpusContext", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <div>
          <div>Weekly Opus usage</div>
          <div>10%</div>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]).toMatchObject({
      windowKind: "weekly-opus",
      percentUsed: 10,
    });
  });

  it("classifiesWeeklyWindowFromJapaneseContext", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <div>
          <div>週間使用量</div>
          <div>22%</div>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]).toMatchObject({ windowKind: "weekly", percentUsed: 22 });
  });

  it("classifiesFiveHoursWindowFromJapaneseSessionLabel", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <div>
          <div>セッション</div>
          <div>15%</div>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]).toMatchObject({
      windowKind: "five-hours",
      percentUsed: 15,
    });
  });

  it("dedupesRowsByWindowKindWhenSamePctRepeats", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <ul>
          <li><span>Weekly</span><span>40%</span></li>
          <li><span>Weekly</span><span>40%</span></li>
        </ul>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows.length).toBe(1);
  });
});

describe("claude.js — reset label parsing", () => {
  it("derivesResetAtFromEnglishHoursPhrase", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <div>
          <div>5-hour session usage</div>
          <div>30% · Resets in 3 hours</div>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const row = payload?.ok ? payload.rows[0] : undefined;
    const expected = new Date(
      FIXED_NOW.getTime() + 3 * 3600 * 1000,
    ).toISOString();
    expect(row?.resetAt).toBe(expected);
  });

  it("derivesResetAtFromJapaneseRelativePhrase", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <div>
          <div>セッション</div>
          <div>12% · 4時間17分後にリセット</div>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const row = payload?.ok ? payload.rows[0] : undefined;
    const expected = new Date(
      FIXED_NOW.getTime() + (4 * 3600 + 17 * 60) * 1000,
    ).toISOString();
    expect(row?.resetAt).toBe(expected);
  });

  it("derivesResetAtFromEnglishDaysPhrase", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <div>
          <div>Weekly usage</div>
          <div>30% · Resets in 2 days</div>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const row = payload?.ok ? payload.rows[0] : undefined;
    const expected = new Date(
      FIXED_NOW.getTime() + 2 * 24 * 3600 * 1000,
    ).toISOString();
    expect(row?.resetAt).toBe(expected);
  });

  it("leavesResetAtNullWhenNoLabelMatches", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <div>
          <div>Weekly usage</div>
          <div>30%</div>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const row = payload?.ok ? payload.rows[0] : undefined;
    expect(row?.resetAt).toBeNull();
  });
});

describe("claude.js — emit fallback", () => {
  it("emitsEmitFailedPayloadWhenJsonStringifyThrows", async () => {
    vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw new Error("circular");
    });
    const payload = await runExtractor(CLAUDE_JS, {
      html: "<p>Verify you are human</p>",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ ok: false, kind: "emit-failed" });
  });
});
