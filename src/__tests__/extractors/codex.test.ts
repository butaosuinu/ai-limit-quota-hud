import { afterEach, describe, expect, it, vi } from "vitest";

import { CODEX_JS, resetExtractorEnv, runExtractor } from "./extractorHarness";

const FIXED_NOW = new Date("2026-05-13T12:00:00.000Z");

afterEach(resetExtractorEnv);

describe("codex.js — challenge / login detection", () => {
  it("emitsCloudflareChallengeOnVerifyHumanText", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: "<div>Verify you are human</div>",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "cloudflare-challenge" });
  });

  it("emitsCloudflareChallengeOnCheckingYourBrowser", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: "<div>Checking your browser before accessing</div>",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "cloudflare-challenge" });
  });

  it("emitsCloudflareChallengeWhenChallengeRunningElementPresent", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: '<div id="challenge-running">cf widget</div>',
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "cloudflare-challenge" });
  });

  it("emitsLoggedOutOnAuthLoginPath", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: "<div>nope</div>",
      path: "/auth/login",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "logged-out" });
  });

  it("emitsLoggedOutOnLoginPath", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: "<div>nope</div>",
      path: "/login",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "logged-out" });
  });

  it("emitsLoggedOutOnRootWithLoginCta", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: "<div>Welcome — Log in to continue</div>",
      path: "/",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "logged-out" });
  });

  it("emitsLoggedOutOnRootWithJapaneseLoginCta", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: "<div>ログインしてください</div>",
      path: "/",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "logged-out" });
  });

  it("emitsLoggedOutOnAuthLoginAnchor", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: '<a href="/auth/login">Sign in</a>',
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "logged-out" });
  });
});

describe("codex.js — extract rows", () => {
  it("emitsNoRowsFinalWhenPageContainsNoPercents", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: "<div>nothing</div>",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "no-rows-final" });
  });

  it("classifiesFiveHoursWindowFromEnglishContext", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `
        <div>
          <span>5h session limit</span>
          <span>40%</span>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]).toMatchObject({
      windowKind: "five-hours",
      percentUsed: 40,
    });
  });

  it("classifiesWeeklyWindowFromEnglishContext", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `
        <div>
          <span>weekly limit</span>
          <span>60%</span>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]).toMatchObject({ windowKind: "weekly", percentUsed: 60 });
  });

  it("classifiesFiveHoursFromJapaneseContext", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `
        <div>
          <span>5時間使用制限</span>
          <span>25%</span>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]?.windowKind).toBe("five-hours");
  });

  it("flipsPercentWhenContextSaysRemainingNotUsed", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `
        <div>
          <span>5h session</span>
          <span>残り 70%</span>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]?.percentUsed).toBe(30);
  });

  it("preservesPercentWhenContextSaysUsed", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `
        <div>
          <span>5h session limit</span>
          <span>70% used</span>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]?.percentUsed).toBe(70);
  });
});

describe("codex.js — deriveResetAt", () => {
  it("derivesYmdHmAbsoluteWeeklyResetWhenJapaneseAnchorPresent", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `
        <div>
          週あたり使用制限 25%
        </div>
        <div>
          週あたり制限 リセット：2026/05/20 09:30
        </div>
      `,
      now: FIXED_NOW,
    });
    const rows = payload?.ok ? payload.rows : [];
    const weekly = rows.find(
      (r) => (r as { windowKind: string }).windowKind === "weekly",
    );
    expect(weekly?.resetAt).toMatch(/^2026-05-20T/u);
  });

  it("derivesWeeklyResetWhenLabelUsesWeeklyLimitAnchor", async () => {
    // The live page labels the weekly card "週間利用上限" (not "週あたり");
    // the reset must still resolve via the 週間 anchor.
    const payload = await runExtractor(CODEX_JS, {
      html: `
        <div>
          週間利用上限 97%
        </div>
        <div>
          週間利用上限 リセット：2026/05/31 6:24
        </div>
      `,
      now: FIXED_NOW,
    });
    const rows = payload?.ok ? payload.rows : [];
    const weekly = rows.find(
      (r) => (r as { windowKind: string }).windowKind === "weekly",
    );
    expect(weekly?.resetAt).toBe(new Date(2026, 4, 31, 6, 24).toISOString());
  });

  it("derivesHhMmAsFutureTimestampStrictlyAfterNow", async () => {
    // HH:MM parsing depends on local timezone (Date constructor with
    // (y, m, d, h, m) is local-time). Assert only on the observable contract:
    // the derived reset must be in the future relative to "now".
    const now = new Date(2026, 4, 13, 12, 0);
    const payload = await runExtractor(CODEX_JS, {
      html: `
        <div>
          5h session limit 50%
        </div>
        <div>
          5h session limit リセット：05:00
        </div>
      `,
      now,
    });
    const rows = payload?.ok ? payload.rows : [];
    const iso = rows[0]?.resetAt as string | null | undefined;
    expect(iso).toBeTruthy();
    expect(new Date(iso!).getTime()).toBeGreaterThan(now.getTime());
  });

  it("derivesCompoundDurationByAddingAllComponents", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `
        <div>
          5h session limit 50%
        </div>
        <div>
          5h session limit resets in 3h 30m
        </div>
      `,
      now: FIXED_NOW,
    });
    const rows = payload?.ok ? payload.rows : [];
    const expected = new Date(
      FIXED_NOW.getTime() + (3 * 3600 + 30 * 60) * 1000,
    ).toISOString();
    expect(rows[0]?.resetAt).toBe(expected);
  });

  it("derivesSecondsUnitWhenLabelUsesSeconds", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `
        <div>
          5h session limit 99%
        </div>
        <div>
          5h session limit resets in 45 seconds
        </div>
      `,
      now: FIXED_NOW,
    });
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]?.resetAt).toBe(
      new Date(FIXED_NOW.getTime() + 45 * 1000).toISOString(),
    );
  });

  it("derivesWeeklyAnchorUnitWhenLabelUsesWeeks", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `
        <div>
          weekly limit 10%
        </div>
        <div>
          weekly limit resets in 1 week
        </div>
      `,
      now: FIXED_NOW,
    });
    const rows = payload?.ok ? payload.rows : [];
    const weekly = rows.find(
      (r) => (r as { windowKind: string }).windowKind === "weekly",
    );
    expect(weekly?.resetAt).toBe(
      new Date(FIXED_NOW.getTime() + 7 * 24 * 3600 * 1000).toISOString(),
    );
  });

  it("leavesResetAtNullWhenLabelHasNoMatch", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `
        <div>
          5h session limit 30%
        </div>
      `,
      now: FIXED_NOW,
    });
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]?.resetAt).toBeNull();
  });
});

describe("codex.js — emit fallback", () => {
  it("emitsEmitFailedWhenJsonStringifyThrows", async () => {
    vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw new Error("circular");
    });
    const payload = await runExtractor(CODEX_JS, {
      html: "<div>Verify you are human</div>",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ ok: false, kind: "emit-failed" });
  });
});
