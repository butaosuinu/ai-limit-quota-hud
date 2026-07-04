import { afterEach, describe, expect, it } from "vitest";

import { CLAUDE_JS, resetExtractorEnv, runExtractor } from "./extractorHarness";

const FIXED_NOW = new Date("2026-05-13T12:00:00.000Z");

afterEach(resetExtractorEnv);

describe("claude.js - model rate limit rows", () => {
  it("classifiesWeeklyFableWindowFromFableRateLimitContext", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: "<div><div>Fable rate limit</div><div>18%</div></div>",
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
      html: "<aside><h2>Fable usage 99%</h2></aside>",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "no-rows-final" });
  });

  it("doesNotTreatUnlimitedAsLimitAnchor", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: "<aside><h2>Fable unlimited 99%</h2></aside>",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "no-rows-final" });
  });

  it("classifiesModelRowsFromSharedRateLimitTable", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<section><h2>Rate limit</h2><table><tbody>" +
        "<tr><th>Opus</th><td>10%</td></tr>" +
        "<tr><th>Fable</th><td>18%</td></tr>" +
        "</tbody></table></section>",
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

  it("keepsWeeklyRowsSeparateFromFableCardsInSharedContainer", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<section><div>Weekly usage</div><div>12%</div>" +
        "<div><h2>Fable rate limit</h2><p>Fable 40%</p></div></section>",
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ windowKind: "weekly", percentUsed: 12 }),
        expect.objectContaining({
          windowKind: "weekly-fable",
          percentUsed: 40,
        }),
      ]),
    );
  });

  it("doesNotCombineModelTextWithNeighboringWeeklyAnchor", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<section><aside><h2>Fable 99%</h2></aside>" +
        "<div><h2>Weekly usage</h2><p>12%</p></div></section>",
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ windowKind: "weekly", percentUsed: 12 });
  });

  it("doesNotReadHiddenModelLabelsIntoVisibleQuotaContext", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<section><span hidden>Fable rate limit</span>" +
        "<div>Weekly usage</div><div>12%</div></section>",
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]).toMatchObject({ windowKind: "weekly", percentUsed: 12 });
  });

  it("dropsAmbiguousSharedSessionAndFableContext", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<section><h2>5-hour session usage</h2>" +
        "<h2>Fable rate limit</h2><div><span>30%</span></div></section>",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "no-rows-final" });
  });
});

describe("claude.js - model reset labels", () => {
  it("derivesFableResetAtFromFableResetParent", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<section><h2>Fable rate limit</h2><p>Fable usage 44%</p>" +
        "<p>Resets in 6 hours</p></section>" +
        "<section><h2>Weekly usage</h2><p>12%</p>" +
        "<p>Resets in 2 days</p></section>",
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
      html:
        "<div><section><h2>Fable rate limit</h2><p>Fable usage 40%</p>" +
        "</section><section><h2>Weekly usage</h2><p>20%</p>" +
        "<p>Resets in 2 days</p></section></div>",
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

  it("derivesModelResetLabelsFromSharedRateLimitTable", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<section><h2>Rate limit</h2><table><tbody>" +
        "<tr><th>Opus</th><td>10%</td><td>Resets in 2 days</td></tr>" +
        "<tr><th>Fable</th><td>18%</td><td>Resets in 6 hours</td></tr>" +
        "</tbody></table></section>",
      now: FIXED_NOW,
    });
    expect(payload?.ok).toBe(true);
    const rows = payload?.ok ? payload.rows : [];
    const opus = rows.find((row) => row.windowKind === "weekly-opus");
    const fable = rows.find((row) => row.windowKind === "weekly-fable");
    expect(opus).toMatchObject({
      windowKind: "weekly-opus",
      resetLabel: "2 days",
    });
    expect(opus?.resetAt).toBe(
      new Date(FIXED_NOW.getTime() + 2 * 24 * 3600 * 1000).toISOString(),
    );
    expect(fable).toMatchObject({
      windowKind: "weekly-fable",
      resetLabel: "6 hours",
    });
    expect(fable?.resetAt).toBe(
      new Date(FIXED_NOW.getTime() + 6 * 3600 * 1000).toISOString(),
    );
  });

  it("derivesModelResetLabelsSplitAcrossInlineSiblings", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<section><h2>Rate limit</h2><table><tbody>" +
        "<tr><th>Fable</th><td>18%</td><td>" +
        "<span>Resets in</span><span>6 hours</span></td></tr>" +
        "</tbody></table></section>",
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
});
