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

  it("includesRefreshGenerationFromQuery", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: "<div>Verify you are human by completing the action below.</div>",
      path: "/settings/usage?qhgen=42",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ generation: 42 });
  });

  it("preservesRefreshGenerationFromHashAfterLoginRedirect", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: "<p>login page</p>",
      path: "/login#qhgen=42",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "logged-out", generation: 42 });
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

  it("classifiesWeeklyFableWindowFromFableRateLimitContext", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <div>
          <div>Fable rate limit</div>
          <div>18%</div>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]).toMatchObject({
      windowKind: "weekly-fable",
      percentUsed: 18,
    });
  });

  it("ignoresGenericFableUsageTextWithoutQuotaAnchor", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <aside>
          <h2>Fable usage 99%</h2>
        </aside>
      `,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "no-rows-final" });
  });

  it("classifiesModelRowsFromSharedRateLimitTable", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <section>
          <h2>Rate limit</h2>
          <table>
            <tbody>
              <tr><th>Opus</th><td>10%</td></tr>
              <tr><th>Fable</th><td>18%</td></tr>
            </tbody>
          </table>
        </section>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          windowKind: "weekly-opus",
          percentUsed: 10,
        }),
        expect.objectContaining({
          windowKind: "weekly-fable",
          percentUsed: 18,
        }),
      ]),
    );
  });

  it("dropsAmbiguousSharedSessionAndFableContext", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <section>
          <h2>5-hour session usage</h2>
          <h2>Fable rate limit</h2>
          <div><span>30%</span></div>
        </section>
      `,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "no-rows-final" });
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

  it("derivesFableResetAtFromFableResetParent", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <section>
          <h2>Fable rate limit</h2>
          <p>Fable usage 44%</p>
          <p>Resets in 6 hours</p>
        </section>
        <section>
          <h2>Weekly usage</h2>
          <p>12%</p>
          <p>Resets in 2 days</p>
        </section>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    const fable = rows.find((row) => row.windowKind === "weekly-fable");
    expect(fable).toMatchObject({
      windowKind: "weekly-fable",
      resetLabel: "6 hours",
    });
    expect(fable?.resetAt).toBe(
      new Date(FIXED_NOW.getTime() + 6 * 3600 * 1000).toISOString(),
    );
  });

  it("doesNotReuseNeighboringWeeklyResetForFable", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <div>
          <section>
            <h2>Fable rate limit</h2>
            <p>Fable usage 40%</p>
          </section>
          <section>
            <h2>Weekly usage</h2>
            <p>20%</p>
            <p>Resets in 2 days</p>
          </section>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    const fable = rows.find((row) => row.windowKind === "weekly-fable");
    const weekly = rows.find((row) => row.windowKind === "weekly");
    expect(fable).toMatchObject({
      windowKind: "weekly-fable",
      resetAt: null,
      resetLabel: null,
    });
    expect(weekly?.resetAt).toBe(
      new Date(FIXED_NOW.getTime() + 2 * 24 * 3600 * 1000).toISOString(),
    );
  });

  it("derivesResetAtFromJapaneseWeekdayTime", async () => {
    // claude.ai's weekly window shows an absolute "HH:MM (曜日)にリセット"
    // label, unlike the 5h window's relative "N時間後" form.
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <div>
          <div>週間使用量</div>
          <div>6% · 8:00 (日)にリセット</div>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const row = payload?.ok ? payload.rows[0] : undefined;
    const iso = row?.resetAt as string | null | undefined;
    expect(iso).toBeTruthy();
    // Weekday math is local-time, so assert the observable contract: the next
    // Sunday (日 = 0), strictly in the future, within a week.
    const reset = new Date(iso!);
    expect(reset.getDay()).toBe(0);
    expect(reset.getTime()).toBeGreaterThan(FIXED_NOW.getTime());
    expect(reset.getTime() - FIXED_NOW.getTime()).toBeLessThanOrEqual(
      7 * 24 * 3600 * 1000,
    );
  });

  it("derivesResetAtFromEnglishWeekdayTime", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <div>
          <div>Weekly usage</div>
          <div>6% · Resets at 8:00 AM Sun</div>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const row = payload?.ok ? payload.rows[0] : undefined;
    const iso = row?.resetAt as string | null | undefined;
    expect(iso).toBeTruthy();
    const reset = new Date(iso!);
    expect(reset.getDay()).toBe(0);
    expect(reset.getTime()).toBeGreaterThan(FIXED_NOW.getTime());
  });

  it("doesNotReadWeekdayOutOfUnrelatedWord", async () => {
    // "mon" must not be matched inside "month" — that would yield a wrong
    // Monday reset instead of leaving resetAt unresolved.
    const payload = await runExtractor(CLAUDE_JS, {
      html: `
        <div>
          <div>Weekly usage</div>
          <div>6% · Resets at 8:00 next month</div>
        </div>
      `,
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const row = payload?.ok ? payload.rows[0] : undefined;
    expect(row?.resetAt).toBeNull();
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
