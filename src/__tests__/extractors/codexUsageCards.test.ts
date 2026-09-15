import { afterEach, describe, expect, it } from "vitest";

import { CODEX_JS, resetExtractorEnv, runExtractor } from "./extractorHarness";

const FIXED_NOW = new Date("2026-05-13T12:00:00.000Z");

afterEach(resetExtractorEnv);

describe("codex.js — independent usage cards", () => {
  it("readsTheCurrentWeeklyArticleWithSplitRemainingAndReset", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `<main><article><header><p>週間利用上限</p>
        <div><span>63%</span><span> 残り </span></div></header>
        <div><div></div><div style="width:63%"></div></div>
        <div><span>リセット：2026/09/19 17:09</span><span aria-hidden="true"></span></div>
        </article><h4>利用制限のリセット</h4>
        <p>リセットを使って、5時間の上限、週ごとの上限、またはその両方を復元できます。</p>
        <article>クレジットの自動チャージ 最大40%お得</article>
        <h2>使用状況の内訳</h2><div>0% 100%</div></main>`,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({
      ok: true,
      rows: [
        {
          windowKind: "weekly",
          percentUsed: 37,
          resetAt: new Date(2026, 8, 19, 17, 9).toISOString(),
        },
      ],
    });
  });

  it("readsDirectionNextToThePercentageInsteadOfExplanatoryProse", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `<section><h2>Weekly usage</h2><p>80% remaining</p>
        <p>Used across all models</p><p>Resets in 2 days</p></section>`,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ ok: true, rows: [{ percentUsed: 20 }] });
  });

  it("includesRemainingInAnAdjacentInlineElement", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `<section><span>Weekly limit</span><span>80%</span><span>remaining</span></section>`,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({
      ok: true,
      rows: [{ windowKind: "weekly", percentUsed: 20 }],
    });
  });

  it.each(["Remaining 80%", "Remaining: 80%", "残り 80%", "残り：80%"])(
    "normalizesLocalRemainingMeasurementFor%s",
    async (measurement) => {
      const payload = await runExtractor(CODEX_JS, {
        html: `<main><section><h2>5-hour limit</h2><p>${measurement}</p></section>
          <section><h2>Weekly limit</h2><p>${measurement}</p></section></main>`,
        now: FIXED_NOW,
      });
      expect(payload).toMatchObject({
        ok: true,
        rows: [
          { windowKind: "five-hours", percentUsed: 20 },
          { windowKind: "weekly", percentUsed: 20 },
        ],
      });
    },
  );

  it("excludesLimitsNestedUnderAModelHeading", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `<section><h2>GPT-5.3-Codex-Spark</h2><div><h3>5-hour limit</h3>
        <p>100% remaining</p></div></section>
        <section><h2>Weekly limit</h2><p>80% remaining</p></section>`,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({
      ok: true,
      rows: [{ windowKind: "weekly", percentUsed: 20 }],
    });
  });

  it.each(
    [
      {
        locale: "English",
        fiveHours: "5-hour limit",
        weekly: "Weekly limit",
        remaining: "remaining",
      },
      {
        locale: "Japanese",
        fiveHours: "5時間使用制限",
        weekly: "週間利用上限",
        remaining: "残り",
      },
    ].flatMap((labels) =>
      [false, true].map((reverse) => ({ ...labels, reverse })),
    ),
  )(
    "excludesBothModelWindows $locale reverse=$reverse",
    async ({ fiveHours, weekly, remaining, reverse }) => {
      const modelFiveHours = `<div><h3>${fiveHours}</h3><p>90% ${remaining}</p></div>`;
      const modelWeekly = `<div><h3>${weekly}</h3><p>100% ${remaining}</p></div>`;
      const modelCards = reverse
        ? modelWeekly + modelFiveHours
        : modelFiveHours + modelWeekly;
      const payload = await runExtractor(CODEX_JS, {
        html: `<main><section><h2>GPT-5.3-Codex-Spark</h2>${modelCards}</section>
        <section><h2>${weekly}</h2><p>80% ${remaining}</p></section></main>`,
        now: FIXED_NOW,
      });
      expect(payload).toMatchObject({
        ok: true,
        rows: [{ windowKind: "weekly", percentUsed: 20 }],
      });
    },
  );

  it.each(["div", "section"])(
    "keepsGeneralQuotaWhenModelAndGeneralCardsShareA%sAncestor",
    async (tag) => {
      const payload = await runExtractor(CODEX_JS, {
        html: `<main><${tag}><section><h2>GPT-5.3-Codex-Spark</h2>
        <div><h3>5-hour limit</h3><p>90% remaining</p></div>
        <div><h3>Weekly limit</h3><p>100% remaining</p></div></section>
        <section><h2>Weekly limit</h2><p>80% remaining</p></section></${tag}></main>`,
        now: FIXED_NOW,
      });
      expect(payload).toMatchObject({
        ok: true,
        rows: [{ windowKind: "weekly", percentUsed: 20 }],
      });
    },
  );

  it("readsResetOutsideTheHeaderAndValueWrapper", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `<section><div><h2>Weekly limit</h2><p>80% remaining</p></div>
        <p>Resets in 2 days</p></section>`,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({
      ok: true,
      rows: [
        {
          percentUsed: 20,
          resetAt: new Date(FIXED_NOW.getTime() + 172_800_000).toISOString(),
        },
      ],
    });
  });

  it("doesNotBorrowResetFromTheNextSameKindCard", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `<main><p>Weekly limit 80% remaining</p>
        <section><h2>Weekly limit</h2><p>Resets in 4 days</p></section></main>`,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({
      ok: true,
      rows: [{ percentUsed: 20, resetAt: null }],
    });
  });

  it("acceptsWeeklyOnlyWithoutInventingFiveHours", async () => {
    const payload = await runExtractor(CODEX_JS, {
      path: "/codex/settings/usage",
      html: `<main><section><h2>週間利用上限</h2><p>残り 80%</p>
        <p>リセット：2026/09/18 18:00</p></section></main>`,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({
      ok: true,
      rows: [
        {
          windowKind: "weekly",
          percentUsed: 20,
          resetAt: new Date(2026, 8, 18, 18, 0).toISOString(),
        },
      ],
    });
  });

  it("keepsReturnedFiveHoursAndWeeklyCardsSeparate", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `<main><section><h2>5-hour limit</h2><p>70% remaining</p>
        <p>Resets in 3h 30m</p></section>
        <section><h2>Weekly limit</h2><p>20% used</p>
        <p>Resets in 2 days</p></section></main>`,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({
      ok: true,
      rows: [
        {
          windowKind: "five-hours",
          percentUsed: 30,
          resetAt: new Date(FIXED_NOW.getTime() + 12_600_000).toISOString(),
        },
        {
          windowKind: "weekly",
          percentUsed: 20,
          resetAt: new Date(FIXED_NOW.getTime() + 172_800_000).toISOString(),
        },
      ],
    });
  });

  it.each(["5-hour", "weekly"])(
    "excludesSpark%sLimitsFromGeneralQuota",
    async (windowLabel) => {
      const payload = await runExtractor(CODEX_JS, {
        html: `<main><section><h2>GPT-5.3-Codex-Spark ${windowLabel} limit</h2>
        <p>100% remaining</p><p>Resets in 4 hours</p></section>
        <section><h2>Weekly limit</h2><p>80% remaining</p>
        <p>Resets in 2 days</p></section></main>`,
        now: FIXED_NOW,
      });
      expect(payload).toMatchObject({
        ok: true,
        rows: [
          {
            windowKind: "weekly",
            percentUsed: 20,
            resetLabel: "2 days",
          },
        ],
      });
    },
  );

  it("doesNotBorrowResetFromAnotherCard", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `<main><section><h2>5時間使用制限</h2><p>残り 80%</p></section>
        <section><h2>週間利用上限</h2><p>残り 60%</p>
        <p>リセット：2026/09/18 18:00</p></section></main>`,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({
      ok: true,
      rows: [
        {
          windowKind: "five-hours",
          percentUsed: 20,
          resetAt: null,
          resetLabel: null,
        },
        {
          windowKind: "weekly",
          percentUsed: 40,
          resetLabel: "2026/09/18 18:00",
        },
      ],
    });
  });

  it("readsResetInAnAdjacentLabeledSubtreeWithoutCrossingCards", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `<main><div>5時間使用制限 80% 残り</div>
        <div>5時間使用制限 リセット：2026/09/16 05:00</div>
        <div>週間利用上限 60% 残り</div>
        <div>週間利用上限 リセット：2026/09/18 18:00</div></main>`,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({
      ok: true,
      rows: [
        {
          windowKind: "five-hours",
          percentUsed: 20,
          resetLabel: "2026/09/16 05:00",
        },
        {
          windowKind: "weekly",
          percentUsed: 40,
          resetLabel: "2026/09/18 18:00",
        },
      ],
    });
  });

  it("ignoresHiddenQuotaAndExplanatoryPercentages", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `<main><section hidden><h2>5-hour limit</h2><p>0% remaining</p></section>
        <p>Save up to 50% of your weekly limit.</p>
        <section><h2>Weekly limit</h2><p>80% remaining</p></section></main>`,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({
      ok: true,
      rows: [
        {
          windowKind: "weekly",
          percentUsed: 20,
        },
      ],
    });
  });

  it("leavesUnrecognizedOrConflictingCardsUnavailable", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `<section><h2>5-hour / weekly limit</h2><p>80% remaining</p></section>`,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ ok: false, kind: "no-rows-final" });
  });

  it.each(["-10%", "−10%", "150%", "1000%"])(
    "rejectsInvalidPercentage%s",
    async (value) => {
      const payload = await runExtractor(CODEX_JS, {
        html: `<section><h2>Weekly limit</h2><p>${value} remaining</p></section>`,
        now: FIXED_NOW,
      });
      expect(payload).toMatchObject({ ok: false, kind: "no-rows-final" });
    },
  );

  it("parsesJapaneseCompoundResetTime", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `<section><h2>週間利用上限</h2><p>残り 80%</p><p>2日4時間17分後にリセット</p></section>`,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({
      ok: true,
      rows: [
        {
          windowKind: "weekly",
          percentUsed: 20,
          resetAt: new Date(FIXED_NOW.getTime() + 188_220_000).toISOString(),
        },
      ],
    });
  });

  it("preservesIsoOffsetAndFractionalSeconds", async () => {
    const resetAt = "2026-09-18T18:00:00.123+09:00";
    const payload = await runExtractor(CODEX_JS, {
      html: `<section><h2>Weekly limit</h2><p>80% remaining</p><p>Resets at ${resetAt}</p></section>`,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({ ok: true, rows: [{ resetAt }] });
  });

  it("doesNotRollInvalidCalendarDatesIntoAnotherMonth", async () => {
    const payload = await runExtractor(CODEX_JS, {
      html: `<section><h2>週間利用上限</h2><p>残り 80%</p><p>リセット：2026/02/31 18:00</p></section>`,
      now: FIXED_NOW,
    });
    expect(payload).toMatchObject({
      ok: true,
      rows: [{ percentUsed: 20, resetAt: null }],
    });
  });
});
