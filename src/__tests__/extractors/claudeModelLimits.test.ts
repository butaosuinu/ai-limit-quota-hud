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
  it("readsAdjacentResetBeforeTheNextQuotaCard", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<main><h2>Weekly limits</h2><div>All models 12% used</div>" +
        "<p>Resets in 2 days</p><div>Fable 18% used</div><p>Resets in 4 days</p></main>",
      now: FIXED_NOW,
    });
    const rows = payload?.ok ? payload.rows : [];
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          windowKind: "weekly",
          percentUsed: 12,
          resetLabel: "2 days",
        }),
        expect.objectContaining({
          windowKind: "weekly-fable",
          percentUsed: 18,
          resetLabel: "4 days",
        }),
      ]),
    );
  });

  it("ignoresProductBreakdownWhenQuotaCardsAreAbsent", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<section><h3>今週の製品別使用状況</h3>" +
        "<div><span>Claude Code</span><div role='meter' aria-valuenow='100' aria-valuetext='100%'><div></div></div><span>100%</span></div>" +
        "<div><span>チャット</span><span>0%</span></div></section>",
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ kind: "no-rows-final" });
  });

  it("findsResetBelowAWrappedCardHeading", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html: "<section><div><h3>Weekly usage</h3></div><div><span>12% used</span></div><p>Resets in 2 days</p></section>",
      now: FIXED_NOW,
    });
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]).toMatchObject({
      windowKind: "weekly",
      percentUsed: 12,
      resetLabel: "2 days",
    });
  });

  it("readsCurrentJapaneseUsageCardsWithoutPromotionOrProductPercentages", async () => {
    const now = new Date(2026, 8, 16, 2, 0);
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<section><div><div><p>順調です。日曜日のリセットまで余裕があります。</p></div><div>" +
        "<div role='status'><span>お知らせ：Claude Codeの週間制限を50%引き上げていた夏のプロモーションは、9月13日に終了しました。ただし、その一部を恒久的なものとします。週間制限はプロモーション開始前より25%高くなりました。</span></div>" +
        "<div>" +
        "<div><div><span><span>現在のセッション</span></span><span>5:40にリセットされます</span></div>" +
        "<div><div><div><div role='meter' aria-valuenow='12' aria-valuetext='12% 使用済み'><div></div></div></div></div><span>12% 使用済み</span></div></div>" +
        "<div><div><span><span>今週</span></span><span>8:00 (日曜日)にリセット</span></div>" +
        "<div><div><div><div role='meter' aria-valuenow='20' aria-valuetext='20% 使用済み'><div></div></div></div></div><span>20% 使用済み</span></div></div>" +
        "<div><div><span><span>今週のFable</span></span><span>Fableには別の週間上限があります</span><span>8:00 (日曜日)にリセット</span></div>" +
        "<div><div><div><div role='meter' aria-valuenow='38' aria-valuetext='38% 使用済み'><div></div></div></div></div><span>38% 使用済み</span></div></div>" +
        "</div></div></div></section>" +
        "<section><h3>今週の製品別使用状況</h3>" +
        "<div><span>Claude Code</span><div role='meter' aria-valuenow='100' aria-valuetext='100%'><div></div></div><span>100%</span></div>" +
        "<div><span>チャット</span><div role='meter' aria-valuenow='0' aria-valuetext='0%'><div></div></div><span>0%</span></div>" +
        "<div><span>Cowork</span><div role='meter' aria-valuenow='0' aria-valuetext='0%'><div></div></div><span>0%</span></div>" +
        "<div><span>その他</span><div role='meter' aria-valuenow='0' aria-valuetext='0%'><div></div></div><span>0%</span></div></section>",
      now,
    });
    const rows = payload?.ok ? payload.rows : [];
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          windowKind: "five-hours",
          percentUsed: 12,
          resetAt: new Date(2026, 8, 16, 5, 40).toISOString(),
        }),
        expect.objectContaining({
          windowKind: "weekly",
          percentUsed: 20,
          resetAt: new Date(2026, 8, 20, 8, 0).toISOString(),
        }),
        expect.objectContaining({
          windowKind: "weekly-fable",
          percentUsed: 38,
          resetAt: new Date(2026, 8, 20, 8, 0).toISOString(),
        }),
      ]),
    );
  });

  it("doesNotBorrowResetFromAnExtraUsageCard", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<section><h2>Weekly limits</h2><div><h3>All models</h3><p>12% used</p></div>" +
        "<div><h3>Extra usage</h3><p>Resets in 4 days</p></div></section>",
      now: FIXED_NOW,
    });
    const rows = payload?.ok ? payload.rows : [];
    expect(rows[0]).toMatchObject({
      windowKind: "weekly",
      percentUsed: 12,
      resetLabel: null,
      resetAt: null,
    });
  });

  it("readsNestedFableMeasurementAfterItsCapDescription", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<section><h2>Weekly limits</h2><div><h3>Fable</h3>" +
        "<p>Up to 50% of your weekly allowance</p>" +
        "<div><div><span>18% used</span></div></div><p>Resets in 4 days</p></div>" +
        "<div><h3>All models</h3><p>12% used</p><p>Resets in 2 days</p></div></section>",
      now: FIXED_NOW,
    });
    const rows = payload?.ok ? payload.rows : [];
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.windowKind === "weekly-fable")).toMatchObject(
      {
        percentUsed: 18,
        resetLabel: "4 days",
        resetAt: new Date(FIXED_NOW.getTime() + 4 * 86400_000).toISOString(),
      },
    );
  });

  it("keepsOuterResetAndSiblingRemainingWithinEachCard", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<section><h2>Weekly limits</h2>" +
        "<div><h3>Fable</h3><div><div><span>18%</span></div><p>remaining</p></div>" +
        "<p>Resets in 4 days</p></div>" +
        "<div><h3>All models</h3><div><div><span>12%</span></div><p>remaining</p></div>" +
        "<p>Resets in 2 days</p></div></section>",
      now: FIXED_NOW,
    });
    const rows = payload?.ok ? payload.rows : [];
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          windowKind: "weekly-fable",
          percentUsed: 82,
          resetLabel: "4 days",
        }),
        expect.objectContaining({
          windowKind: "weekly",
          percentUsed: 88,
          resetLabel: "2 days",
        }),
      ]),
    );
  });

  it.each([
    ["All models", "Fable can use up to 50% of your weekly limit."],
    ["すべてのモデル", "Fable は週間使用量の最大 50% まで利用できます。"],
  ])("ignoresFableCapDescriptionFor%s", async (allModels, description) => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        `<section><h2>Weekly limits</h2><p>${description}</p>` +
        `<div><h3>${allModels}</h3><p>12% used</p><p>Resets in 2 days</p></div>` +
        "<div><h3>Fable</h3><p>18% used</p><p>Resets in 4 days</p></div></section>",
      now: FIXED_NOW,
    });
    const rows = payload?.ok ? payload.rows : [];
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          windowKind: "weekly",
          percentUsed: 12,
          resetLabel: "2 days",
          resetAt: new Date(FIXED_NOW.getTime() + 2 * 86400_000).toISOString(),
        }),
        expect.objectContaining({
          windowKind: "weekly-fable",
          percentUsed: 18,
          resetLabel: "4 days",
          resetAt: new Date(FIXED_NOW.getTime() + 4 * 86400_000).toISOString(),
        }),
      ]),
    );
  });

  it.each(["All models", "Weekly usage", "すべてのモデル"])(
    "keepsWeeklyValueAndResetAfterFableFor%s",
    async (weeklyLabel) => {
      const payload = await runExtractor(CLAUDE_JS, {
        html:
          "<section><h2>Weekly limits</h2>" +
          "<div><h3>Fable</h3><p>18% used</p><p>Resets in 4 days</p></div>" +
          `<div><h3>${weeklyLabel}</h3><p>12% used</p><p>Resets in 2 days</p></div></section>`,
        now: FIXED_NOW,
      });
      const rows = payload?.ok ? payload.rows : [];
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.windowKind === "weekly")).toMatchObject({
        percentUsed: 12,
        resetLabel: "2 days",
        resetAt: new Date(FIXED_NOW.getTime() + 2 * 86400_000).toISOString(),
      });
    },
  );

  it("doesNotBorrowFableResetForWeeklyUnderSharedHeading", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<section><h2>Weekly limits</h2>" +
        "<div><h3>All models</h3><p>12% used</p></div>" +
        "<div><h3>Fable</h3><p>18% used</p><p>Resets in 4 days</p></div></section>",
      now: FIXED_NOW,
    });
    const rows = payload?.ok ? payload.rows : [];
    expect(rows.find((row) => row.windowKind === "weekly")).toMatchObject({
      percentUsed: 12,
      resetAt: null,
      resetLabel: null,
    });
  });

  it("ignoresSplitCapDescriptionInsideFableCard", async () => {
    const payload = await runExtractor(CLAUDE_JS, {
      html:
        "<section><h2>Fable rate limit</h2>" +
        "<p>You can use up to <strong>50%</strong> of your weekly limit.</p>" +
        "<p>18% used</p><p>Resets in 4 days</p></section>",
      now: FIXED_NOW,
    });
    const rows = payload?.ok ? payload.rows : [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      windowKind: "weekly-fable",
      percentUsed: 18,
      resetLabel: "4 days",
    });
  });

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
