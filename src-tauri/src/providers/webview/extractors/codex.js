// Codex (chatgpt.com) usage page extractor.
//
// This script runs inside an isolated WebView pointed at
// https://chatgpt.com/codex/cloud/settings/analytics. It must not assume any
// specific class / data-* attribute on the page — chatgpt.com's DOM is not a
// stable interface, so we read whatever visible text exists, pattern-match
// defensively, and surface the result via `document.title` (the Rust side
// polls / observes title changes; see `WebviewScraper`).
//
// Output protocol (identical to extractors/claude.js so the same
// `parse_title_payload` decodes both):
//   document.title = "QHJSON:" + JSON.stringify(payload)
//
// Where `payload` is:
//   { ok: false, kind: "cloudflare-challenge" | "logged-out" | "no-rows" | "no-rows-final", message?: string }
//   { ok: true, rows: [{ windowKind, percentUsed, resetAt, resetLabel, raw }] }
//
// `windowKind` is one of "five-hours" | "weekly" | "unknown".
// `percentUsed` is 0-100 (number).
// `resetAt` is an ISO-8601 string when we can derive it from the visible
// reset label, otherwise null.
// `resetLabel` is the raw reset text we picked up, for debugging.
// `raw` is the matched text fragment (for diagnostics).
//
// We intentionally avoid throwing — any failure is funneled through the title
// channel with `ok: false` so the Rust side can surface a `SnapshotStatus`
// rather than a crash.

(function () {
  "use strict";

  var PREFIX = "QHJSON:";

  // Labels we look for on each usage "card" — case-insensitive substrings,
  // because chatgpt.com mixes "5h session", "weekly", and friendly variants.
  var SESSION_LABEL_PATTERNS = [
    /5\s*h\s*session/i,
    /5-?hour\s*session/i,
    /session\s+limit/i,
    /5\s*hour/i,
  ];
  var WEEKLY_LABEL_PATTERNS = [
    /weekly/i,
    /per\s+week/i,
    /this\s+week/i,
  ];

  function emit(payload) {
    try {
      document.title = PREFIX + JSON.stringify(payload);
    } catch (e) {
      // Last-ditch fallback: emit a minimal error payload that doesn't
      // depend on JSON.stringify of the original payload.
      document.title = PREFIX + '{"ok":false,"kind":"emit-failed"}';
    }
  }

  function bodyText() {
    try {
      return (document.body && document.body.innerText) || "";
    } catch (e) {
      return "";
    }
  }

  function detectCloudflareChallenge(text) {
    var lower = text.toLowerCase();
    // Cloudflare's "verify you are human" interstitial contains these
    // phrases regardless of locale variants we've seen. We also check for
    // the explicit `#challenge-running` element that Cloudflare injects.
    if (
      lower.indexOf("verify you are human") !== -1 ||
      lower.indexOf("verifying you are human") !== -1 ||
      lower.indexOf("checking your browser") !== -1 ||
      (lower.indexOf("just a moment") !== -1 &&
        lower.indexOf("cloudflare") !== -1)
    ) {
      return true;
    }
    try {
      if (document.querySelector("#challenge-running")) return true;
    } catch (e) {
      // ignore
    }
    return false;
  }

  function detectLoggedOut() {
    // chatgpt.com's unauthenticated handling for `/codex/cloud/settings/analytics`
    // isn't a clean redirect to `/auth/login` — the server frequently lands
    // the user on the root `/` with a login modal instead. We treat any of
    // the following as "logged out so the user must re-authenticate":
    //
    // 1. URL pathname is `/auth/login` or `/login` (explicit redirect).
    // 2. URL pathname is not the analytics target (i.e. the navigation was
    //    silently bounced — the page should be `/codex/cloud/settings/...`).
    // 3. A `/auth/login` anchor is visible in the rendered page (the inline
    //    login CTA the marketing root renders).
    if (location && typeof location.pathname === "string") {
      var pathname = location.pathname;
      if (pathname.indexOf("/auth/login") === 0) return true;
      if (pathname.indexOf("/login") === 0) return true;
      // Anything that isn't the analytics route is considered an unauth
      // redirect. The target path begins with `/codex/cloud/settings/`; the
      // ChatGPT root `/`, marketing pages, and any other landing fall
      // through to this branch and signal a logged-out state.
      if (pathname.indexOf("/codex/cloud/settings/") !== 0) return true;
    }
    var anchors = document.querySelectorAll('a[href*="/auth/login"]');
    if (anchors && anchors.length > 0) return true;
    return false;
  }

  // Find the smallest DOM container that mentions one of `patterns`
  // (case-insensitive). The narrowest ancestor whose text still satisfies
  // the label match is preferred — chatgpt.com often nests label + value
  // inside the same `<section>` / `<article>` block, so the smallest one is
  // typically the actual usage card.
  function findCardByLabel(patterns) {
    var bodyEl = document.body;
    if (!bodyEl) return null;
    var walker;
    try {
      walker = document.createTreeWalker(
        bodyEl,
        NodeFilter.SHOW_ELEMENT,
        null,
      );
    } catch (e) {
      return null;
    }
    var current = walker.currentNode;
    var best = null;
    while (current) {
      var text = current.textContent || "";
      if (text.length > 0 && text.length < 1200) {
        var matched = false;
        for (var i = 0; i < patterns.length; i += 1) {
          if (patterns[i].test(text)) {
            matched = true;
            break;
          }
        }
        if (matched) {
          if (!best || text.length < (best.textContent || "").length) {
            best = current;
          }
        }
      }
      current = walker.nextNode();
    }
    return best;
  }

  // Extract a percent value from a string. Returns `null` if no plausible
  // percent is present. We accept both "85%" and "85 percent" forms.
  function parsePercent(text) {
    if (!text) return null;
    var m = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    if (m) {
      var pct = parseFloat(m[1]);
      if (isFinite(pct) && pct >= 0 && pct <= 100) return pct;
    }
    var m2 = text.match(/(\d{1,3}(?:\.\d+)?)\s*percent/i);
    if (m2) {
      var pct2 = parseFloat(m2[1]);
      if (isFinite(pct2) && pct2 >= 0 && pct2 <= 100) return pct2;
    }
    return null;
  }

  // Pull a percent out of a card. The chatgpt.com analytics page sometimes
  // renders the *used* half of the progress bar instead of the *remaining*
  // half. We never invert — we always emit `percentUsed` because that is
  // what the Rust side expects, and chatgpt.com primarily displays used %.
  // If the surrounding text mentions "remaining" / "left" rather than
  // "used" / "consumed", we flip so we return percent-used.
  function extractPercentFromCard(card) {
    if (!card) return null;
    var text = card.textContent || "";
    var pct = parsePercent(text);
    if (pct === null) return null;
    // If the card explicitly says "remaining" / "left" (and not "used" /
    // "consumed"), the number is the remaining %, so invert.
    if (/remaining|left/i.test(text) && !/used|consumed/i.test(text)) {
      var inverted = 100 - pct;
      if (inverted >= 0 && inverted <= 100) return inverted;
    }
    return pct;
  }

  // Reset-time extraction tolerates ISO 8601 ("2026-05-16T17:00:00Z"),
  // "in 3h 12m", "Resets in 3 hours", and "Renews May 20" style. We never
  // invent a value — `null` is fine and surfaces sensibly as "no reset
  // info" in the overlay.
  function pickResetLabel(card) {
    if (!card) return null;
    var text = card.textContent || "";
    // Prefer an explicit ISO timestamp if present.
    var iso = text.match(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?/,
    );
    if (iso) return iso[0];
    // Match "Resets in 3 hours", "Renews May 20", etc.
    var m = text.match(/(?:resets?|renews?|refreshes?)\s+(?:in|at|on)?\s*([^.\n|]+)/i);
    if (!m) return null;
    var label = m[1].replace(/\s+/g, " ").trim();
    if (label.length === 0 || label.length > 80) return null;
    return label;
  }

  function deriveResetAt(label) {
    if (!label) return null;
    // If the label already looks like an ISO-8601 timestamp, surface it
    // verbatim — the Rust side stores the string and the UI renders it.
    var iso = label.match(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?/,
    );
    if (iso) return iso[0];
    // Match "in <n> <unit>(s)" or just "<n> <unit>(s)".
    var m = label.match(/(\d+)\s*(minute|hour|day|week)s?/i);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    if (!isFinite(n) || n < 0) return null;
    var unit = m[2].toLowerCase();
    var ms = 0;
    if (unit === "minute") ms = n * 60 * 1000;
    else if (unit === "hour") ms = n * 60 * 60 * 1000;
    else if (unit === "day") ms = n * 24 * 60 * 60 * 1000;
    else if (unit === "week") ms = n * 7 * 24 * 60 * 60 * 1000;
    else return null;
    return new Date(Date.now() + ms).toISOString();
  }

  function rowForWindow(windowKind, patterns, sharedResetCard) {
    var card = findCardByLabel(patterns);
    var pct = extractPercentFromCard(card);
    if (pct === null) return null;
    var resetCard = card || sharedResetCard;
    var label = pickResetLabel(resetCard);
    var raw = (card && card.textContent) || "";
    return {
      windowKind: windowKind,
      percentUsed: pct,
      resetAt: deriveResetAt(label),
      resetLabel: label,
      raw: raw.slice(0, 200),
    };
  }

  function extract() {
    var text = bodyText();
    if (detectCloudflareChallenge(text)) {
      emit({ ok: false, kind: "cloudflare-challenge" });
      return;
    }
    if (detectLoggedOut()) {
      emit({ ok: false, kind: "logged-out" });
      return;
    }
    var rows = [];
    var sessionRow = rowForWindow("five-hours", SESSION_LABEL_PATTERNS, null);
    if (sessionRow) rows.push(sessionRow);
    var weeklyRow = rowForWindow("weekly", WEEKLY_LABEL_PATTERNS, null);
    if (weeklyRow) rows.push(weeklyRow);
    if (rows.length === 0) {
      // The page may still be hydrating. Caller polls again on a delay.
      emit({
        ok: false,
        kind: "no-rows",
        message: "no codex usage cards visible yet",
      });
      return;
    }
    emit({ ok: true, rows: rows });
  }

  // Try a few times while the SPA hydrates. The Rust side has its own
  // overall timeout — these retries just paper over the gap between
  // `DOMContentLoaded` and React rendering the usage card.
  var attempts = 0;
  var MAX_ATTEMPTS = 15;
  function tick() {
    attempts += 1;
    extract();
    if ((document.title || "").indexOf(PREFIX) === 0) {
      // If the emitted payload is a "no-rows" we want to keep retrying.
      var rest = document.title.slice(PREFIX.length);
      if (rest.indexOf('"ok":true') !== -1) return;
      if (rest.indexOf("cloudflare-challenge") !== -1) return;
      if (rest.indexOf("logged-out") !== -1) return;
    }
    if (attempts < MAX_ATTEMPTS) {
      setTimeout(tick, 700);
    } else {
      // Retry budget exhausted without ever finding usage rows. Emit a
      // terminal variant so the Rust side can surface a deterministic
      // error snapshot instead of timing out at 25 s — the Rust callback
      // treats plain `no-rows` as transient (SPA hydration race) and only
      // forwards `no-rows-final` to the awaiter.
      emit({
        ok: false,
        kind: "no-rows-final",
        message:
          "chatgpt.com codex usage rows did not render within " +
          MAX_ATTEMPTS +
          " attempts",
      });
    }
  }

  // Kick off as soon as the script is injected. If the document is still
  // loading, wait — we'd otherwise scrape an empty body.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tick, { once: true });
  } else {
    tick();
  }
})();
