// Claude usage page extractor.
//
// This script runs inside an isolated WebView pointed at
// https://claude.ai/settings/usage. It must not assume any specific class /
// data-* attribute on the page — claude.ai's DOM is not a stable interface, so
// we read whatever visible text exists, pattern-match defensively, and surface
// the result via `document.title` (the Rust side polls / observes title
// changes; see `WebviewScraper`).
//
// Output protocol:
//   document.title = "QHJSON:" + JSON.stringify(payload)
//
// Where `payload` is:
//   { ok: false, kind: "cloudflare-challenge" | "logged-out" | "no-rows", message?: string }
//   { ok: true, rows: [{ windowKind, percentUsed, resetAt, resetLabel, raw }] }
//
// `windowKind` is one of "five-hours" | "weekly" | "weekly-opus" | "unknown".
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
    // Cloudflare's "verify you are human" interstitial contains this phrase
    // regardless of locale-localized variants we have seen.
    var lower = text.toLowerCase();
    return (
      lower.indexOf("verify you are human") !== -1 ||
      lower.indexOf("verifying you are human") !== -1 ||
      (lower.indexOf("just a moment") !== -1 &&
        lower.indexOf("cloudflare") !== -1)
    );
  }

  function detectLoggedOut() {
    // The /login redirect changes the URL; also a visible "Log in" CTA tends
    // to surface on the settings page when the session has expired.
    if (location && typeof location.pathname === "string") {
      if (location.pathname.indexOf("/login") === 0) return true;
    }
    var anchors = document.querySelectorAll('a[href*="/login"]');
    if (anchors && anchors.length > 0) return true;
    return false;
  }

  // Find all numeric "%" values on the page, paired with nearby labels.
  // We walk text nodes so we don't rely on any specific element structure.
  function collectPercentSamples() {
    var samples = [];
    var walker;
    try {
      walker = document.createTreeWalker(
        document.body || document.documentElement,
        NodeFilter.SHOW_TEXT,
        null,
      );
    } catch (e) {
      return samples;
    }
    var node;
    while ((node = walker.nextNode())) {
      var text = (node.nodeValue || "").trim();
      if (text.length === 0) continue;
      // Match "<digits>%" or "<digits>.<digits>%" with optional surrounding
      // whitespace. We intentionally don't anchor — text nodes can wrap a
      // single percent inline with the label.
      var m = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
      if (!m) continue;
      var pct = parseFloat(m[1]);
      if (!isFinite(pct) || pct < 0 || pct > 100) continue;
      // Climb up a few ancestors to grab context. Stop after ~6 levels so we
      // don't bring in the entire document.
      var ctxNode = node.parentNode;
      var ctxLines = [];
      var depth = 0;
      while (ctxNode && depth < 6) {
        var ctxText = (ctxNode.innerText || ctxNode.textContent || "").trim();
        if (ctxText && ctxText.length < 600) {
          ctxLines.push(ctxText);
        }
        ctxNode = ctxNode.parentNode;
        depth += 1;
      }
      samples.push({ pct: pct, context: ctxLines.join(" | ") });
    }
    return samples;
  }

  function classifyWindow(context) {
    var lower = context.toLowerCase();
    var isWeekly =
      lower.indexOf("week") !== -1 ||
      context.indexOf("週間") !== -1 ||
      context.indexOf("毎週") !== -1;
    var isSession =
      lower.indexOf("5-hour") !== -1 ||
      lower.indexOf("5 hour") !== -1 ||
      lower.indexOf("five-hour") !== -1 ||
      lower.indexOf("session") !== -1 ||
      context.indexOf("セッション") !== -1;
    // Ambiguity comes first — when the ancestor walk captures both cards
    // (5h + weekly siblings sharing a parent, including the Opus weekly
    // variant) classification is unsafe in every direction: returning
    // `five-hours` would hide the weekly row, returning `weekly-opus`
    // when only Opus happens to be present in the joined context would
    // mislabel a 5h sample. Drop the sample and retry instead.
    if (isWeekly && isSession) return "unknown";
    if (isWeekly && lower.indexOf("opus") !== -1) return "weekly-opus";
    if (isSession) return "five-hours";
    if (isWeekly) return "weekly";
    return "unknown";
  }

  // Try to pull a "Resets <relative>" or "Resets at <time>" hint from the
  // context block. We do not attempt to convert relative strings into ISO —
  // the Rust side knows the observation time and can compute a reset_at if
  // needed. We just return the raw label.
  function pickResetLabel(context) {
    // English: "Resets in 3 hours", "Resets at 5:00 PM", "Resets May 20" etc.
    var m = context.match(/Resets?\s+(?:in|at|on)?\s*([^|]+?)(?:\s*\||$)/i);
    if (m) {
      var label = m[1].trim();
      if (label.length > 0 && label.length <= 80) return label;
    }
    // Japanese: "4時間17分後にリセット" — at least one numeric component
    // is required so the optional-only group cannot match "後" alone.
    var jp = context.match(
      /((?:\d+\s*(?:週間?|日|時間|分)\s*)+)後(?:に|で)?(?:リセット|更新)?/,
    );
    if (jp && jp[1]) {
      var jpLabel = jp[1].replace(/\s+/g, "").trim();
      if (jpLabel.length > 0 && jpLabel.length <= 40) {
        return jpLabel + "後";
      }
    }
    return null;
  }

  function deriveResetAt(label) {
    if (!label) return null;
    // English form: a single "<n> <minute|hour|day|week>(s)" component is
    // enough for the page's relative labels.
    var m = label.match(/(\d+)\s*(minute|hour|day|week)s?/i);
    if (m) {
      var n = parseInt(m[1], 10);
      if (isFinite(n) && n >= 0) {
        var unit = m[2].toLowerCase();
        var ms = 0;
        if (unit === "minute") ms = n * 60 * 1000;
        else if (unit === "hour") ms = n * 60 * 60 * 1000;
        else if (unit === "day") ms = n * 24 * 60 * 60 * 1000;
        else if (unit === "week") ms = n * 7 * 24 * 60 * 60 * 1000;
        if (ms > 0) return new Date(Date.now() + ms).toISOString();
      }
    }
    // Japanese form: sum every "N(週|日|時間|分)" component so "4時間17分後"
    // resolves correctly (a single-match version would round to just 4h).
    var jpPattern = /(\d+)\s*(週間?|日|時間|分)/g;
    var totalMs = 0;
    var matched = false;
    var jp;
    while ((jp = jpPattern.exec(label)) !== null) {
      var jn = parseInt(jp[1], 10);
      if (!isFinite(jn) || jn < 0) continue;
      var jUnit = jp[2];
      if (jUnit.indexOf("週") === 0) totalMs += jn * 7 * 24 * 60 * 60 * 1000;
      else if (jUnit === "日") totalMs += jn * 24 * 60 * 60 * 1000;
      else if (jUnit === "時間") totalMs += jn * 60 * 60 * 1000;
      else if (jUnit === "分") totalMs += jn * 60 * 1000;
      else continue;
      matched = true;
    }
    if (matched) return new Date(Date.now() + totalMs).toISOString();
    return null;
  }

  function dedupeByWindow(rows) {
    var seen = {};
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var key = row.windowKind;
      if (seen[key]) continue;
      seen[key] = true;
      out.push(row);
    }
    return out;
  }

  function diagSnippet(text) {
    return (text || "").slice(0, 150).replace(/\s+/g, " ").trim();
  }

  function diagPath() {
    try {
      return (location && location.pathname) || "";
    } catch (e) {
      return "";
    }
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
    var samples = collectPercentSamples();
    if (samples.length === 0) {
      // The page may still be hydrating. Caller polls again on a delay.
      // Include diag info so the Rust-side log surfaces what the page
      // looked like at the time the extractor gave up on this attempt.
      emit({
        ok: false,
        kind: "no-rows",
        message:
          "path=" +
          diagPath() +
          " len=" +
          text.length +
          " head=" +
          diagSnippet(text),
      });
      return;
    }
    var rows = [];
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      var kind = classifyWindow(s.context);
      // Drop "unknown" samples — without a window-kind keyword nearby
      // (5-hour / weekly / opus), the percent value is almost certainly a
      // false positive (sidebar chat titles like "100%キーボードの代替"
      // showed up as `unknown` rows in the wild). The Rust side then
      // treats an empty rows array as `no-rows` and retries.
      if (kind === "unknown") continue;
      var label = pickResetLabel(s.context);
      rows.push({
        windowKind: kind,
        percentUsed: s.pct,
        resetAt: deriveResetAt(label),
        resetLabel: label,
        raw: s.context.slice(0, 200),
      });
    }
    rows = dedupeByWindow(rows);
    if (rows.length === 0) {
      // Surface the first sample's context so the Rust-side log can show
      // *what* the page presented as a percent (e.g. sidebar chat title vs
      // an actual usage card whose label we don't yet recognise). Keeps
      // the payload small enough to fit in document.title.
      var firstCtx = samples.length > 0 ? samples[0].context.slice(0, 150) : "";
      emit({
        ok: false,
        kind: "no-rows",
        message:
          "path=" +
          diagPath() +
          " len=" +
          text.length +
          " samples=" +
          samples.length +
          " head=" +
          diagSnippet(text) +
          " ctx0=" +
          firstCtx,
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
    // Once we've emitted a positive result, stop. The Rust side resets the
    // title after it reads it; if we land here again with a stale prefix
    // we'll fall through and re-extract.
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
      var finalText = bodyText();
      emit({
        ok: false,
        kind: "no-rows-final",
        message:
          "claude.ai usage rows did not render within " +
          MAX_ATTEMPTS +
          " attempts (path=" +
          diagPath() +
          " len=" +
          finalText.length +
          " head=" +
          diagSnippet(finalText) +
          ")",
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
