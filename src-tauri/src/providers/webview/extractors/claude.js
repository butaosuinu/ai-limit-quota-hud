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
//   { ok: false, kind: "cloudflare-challenge" | "logged-out" | "no-rows" | "no-rows-final", message?: string }
//   { ok: true, rows: [{ windowKind, percentUsed, resetAt, resetLabel, raw }] }
//
// `windowKind` is one of "five-hours" | "weekly" | "weekly-opus" |
// "weekly-fable" | "unknown".
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

  function readRefreshGeneration() {
    try {
      var marker =
        String((location && location.search) || "") +
        "&" +
        String((location && location.hash) || "");
      var match = marker.match(/[?#&]qhgen=(\d+)/);
      if (!match) return null;
      var generation = parseInt(match[1], 10);
      if (!isFinite(generation)) return null;
      return generation;
    } catch (e) {
      return null;
    }
  }
  var REFRESH_GENERATION = readRefreshGeneration();

  function emit(payload) {
    var generation = REFRESH_GENERATION;
    try {
      if (generation !== null) payload.generation = generation;
      document.title = PREFIX + JSON.stringify(payload);
    } catch (e) {
      // Last-ditch fallback: emit a minimal error payload that doesn't
      // depend on JSON.stringify of the original payload.
      var suffix = generation === null ? "" : ',"generation":' + generation;
      document.title =
        PREFIX + '{"ok":false,"kind":"emit-failed"' + suffix + "}";
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
      var nearestContext = "";
      var singleModelContext = "";
      var modelQuotaAnchor = "";
      var depth = 0;
      while (ctxNode && depth < 6) {
        var candidates = contextCandidatesFor(ctxNode, depth);
        for (var ci = 0; ci < candidates.length; ci++) {
          var ctxText = candidates[ci];
          if (ci === 0) ctxLines.push(ctxText);
          if (
            singleModelContext.length === 0 &&
            isLocalSingleModelContext(ctxText)
          ) {
            singleModelContext = ctxText;
          }
          if (
            singleModelContext.length > 0 &&
            modelQuotaAnchor.length === 0 &&
            !hasSessionContext(ctxText)
          ) {
            modelQuotaAnchor = modelQuotaAnchorFor(ctxText);
          }
          if (
            nearestContext.length === 0 &&
            isUsableDirectWindowContext(ctxText)
          ) {
            nearestContext = ctxText;
          }
        }
        ctxNode = ctxNode.parentNode;
        depth += 1;
      }
      samples.push({
        pct: pct,
        context:
          nearestContext.length > 0
            ? nearestContext
            : singleModelContext.length > 0 && modelQuotaAnchor.length > 0
              ? singleModelContext + " " + modelQuotaAnchor
              : ctxLines.join(" | "),
      });
    }
    return samples;
  }

  function readNodeText(node) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.nodeValue || "").trim();
    }
    var children = node.childNodes || [];
    var parts = [];
    for (var i = 0; i < children.length; i++) {
      var text = readNodeText(children[i]);
      if (text.length > 0) parts.push(text);
    }
    if (parts.length > 0) {
      return parts.join(" ").replace(/\s+/g, " ").trim();
    }
    if (typeof node.innerText === "string") return node.innerText.trim();
    return ((node && node.textContent) || "").trim();
  }

  function previousSiblingTexts(node, maxCount) {
    var out = [];
    var sibling = node.previousSibling;
    while (sibling && out.length < maxCount) {
      var text = readNodeText(sibling);
      if (text.length > 0) out.unshift(text);
      sibling = sibling.previousSibling;
    }
    return out;
  }

  function nextSiblingTexts(node, maxCount) {
    var out = [];
    var sibling = node.nextSibling;
    while (sibling && out.length < maxCount) {
      var text = readNodeText(sibling);
      if (text.length > 0) out.push(text);
      sibling = sibling.nextSibling;
    }
    return out;
  }

  function localContextFor(node, ownText) {
    var parts = previousSiblingTexts(node, 2);
    parts.push(ownText);
    var text = parts.join(" ").trim();
    if (text === ownText || text.length >= 600) return "";
    return text;
  }

  function contextCandidatesFor(node, depth) {
    var ownText = readNodeText(node);
    if (ownText.length === 0 || ownText.length >= 600) return [];
    var localText = depth <= 1 ? localContextFor(node, ownText) : "";
    if (localText.length === 0) return [ownText];
    return [localText, ownText];
  }

  function percentValueCount(context) {
    var matches = context.match(/\d{1,3}(?:\.\d+)?\s*%/g);
    return matches ? matches.length : 0;
  }

  function hasFableContext(context) {
    return context.toLowerCase().indexOf("fable") !== -1;
  }

  function hasOpusContext(context) {
    return context.toLowerCase().indexOf("opus") !== -1;
  }

  function hasExactlyOneModel(context) {
    var isFable = hasFableContext(context);
    var isOpus = hasOpusContext(context);
    return (isFable && !isOpus) || (isOpus && !isFable);
  }

  function hasStrongRateLimitContext(context) {
    return (
      /\brate[\s-]+limits?\b|\blimits?\b/i.test(context) ||
      context.indexOf("制限") !== -1 ||
      context.indexOf("上限") !== -1
    );
  }

  function hasWeeklyContext(context) {
    var lower = context.toLowerCase();
    return (
      lower.indexOf("week") !== -1 ||
      context.indexOf("週間") !== -1 ||
      context.indexOf("毎週") !== -1
    );
  }

  function hasSessionContext(context) {
    var lower = context.toLowerCase();
    return (
      lower.indexOf("5-hour") !== -1 ||
      lower.indexOf("5 hour") !== -1 ||
      lower.indexOf("five-hour") !== -1 ||
      lower.indexOf("session") !== -1 ||
      context.indexOf("セッション") !== -1
    );
  }

  function modelQuotaAnchorFor(context) {
    if (hasStrongRateLimitContext(context)) return "rate limit";
    if (hasWeeklyContext(context)) return "weekly";
    return "";
  }

  function isModelWindowKind(kind) {
    return kind === "weekly-fable" || kind === "weekly-opus";
  }

  function isLocalSingleModelContext(context) {
    return (
      hasExactlyOneModel(context) &&
      !hasSessionContext(context) &&
      percentValueCount(context) <= 1
    );
  }

  function isUsableDirectWindowContext(context) {
    var kind = classifyWindow(context);
    if (kind === "unknown") return false;
    if (!isModelWindowKind(kind)) return true;
    return isLocalSingleModelContext(context);
  }

  function classifyWindow(context) {
    var isFable = hasFableContext(context);
    var isOpus = hasOpusContext(context);
    var isRateLimit = hasStrongRateLimitContext(context);
    var isWeekly = hasWeeklyContext(context);
    var isSession = hasSessionContext(context);
    // Ambiguity comes first — when the ancestor walk captures both cards
    // (5h + weekly siblings sharing a parent, including the Opus weekly
    // variant) classification is unsafe in every direction: returning
    // `five-hours` would hide the weekly row, returning `weekly-opus`
    // when only Opus happens to be present in the joined context would
    // mislabel a 5h sample. Drop the sample and retry instead.
    if (isWeekly && isSession) return "unknown";
    if (isSession && (isFable || isOpus)) return "unknown";
    if (isFable && isOpus) return "unknown";
    if (isFable && (isWeekly || isRateLimit)) return "weekly-fable";
    if (isOpus && (isWeekly || isRateLimit)) return "weekly-opus";
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
      if (
        label.length > 0 &&
        label.length <= 80 &&
        !/^(?:in|at|on)$/i.test(label)
      ) {
        return label;
      }
    }
    // Japanese absolute weekly form: "8:00 (日)にリセット" — a clock time plus
    // a parenthesised weekday. claude.ai renders the weekly window this way
    // while the 5h window uses the relative "N時間後" form handled below.
    var jpWeekday = context.match(
      /(\d{1,2}:\d{2})\s*[（(]\s*([日月火水木金土])\s*[)）]/,
    );
    if (jpWeekday) {
      return jpWeekday[1] + " (" + jpWeekday[2] + ")";
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

  function resetSiblingContextFor(node, ownText) {
    var parts = previousSiblingTexts(node, 2);
    parts.push(ownText);
    parts = parts.concat(nextSiblingTexts(node, 2));
    var text = parts.join(" ").trim();
    if (text === ownText || text.length >= 600) return "";
    return text;
  }

  function resetLabelCandidatesFor(node, text) {
    var candidates = [];
    if (node) {
      var ownText = readNodeText(node);
      var siblingText = resetSiblingContextFor(node, ownText);
      if (siblingText.length > 0) candidates.push(siblingText);
      if (ownText.length > 0 && ownText.length < 600) candidates.push(ownText);
      if (node.parentNode) {
        var parentText = readNodeText(node.parentNode);
        if (parentText.length > 0 && parentText.length < 600) {
          candidates.push(parentText);
        }
      }
    }
    candidates.push(text);
    return candidates;
  }

  function mentionsResetHint(text) {
    return (
      /resets?|renews?|refreshes?/i.test(text) ||
      text.indexOf("リセット") !== -1 ||
      text.indexOf("更新") !== -1
    );
  }

  function collectResetSamples() {
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
      var ctxNode = node.parentNode;
      var label = null;
      var resetCandidates = resetLabelCandidatesFor(ctxNode, text);
      for (var ri = 0; ri < resetCandidates.length; ri++) {
        var resetText = resetCandidates[ri];
        if (!mentionsResetHint(resetText)) continue;
        label = pickResetLabel(resetText);
        if (label) break;
      }
      if (!label) continue;
      var depth = 0;
      var resolved = false;
      var singleModelContext = "";
      var modelQuotaAnchor = "";
      while (ctxNode && depth < 5) {
        var candidates = contextCandidatesFor(ctxNode, depth);
        for (var ci = 0; ci < candidates.length; ci++) {
          var ctxText = candidates[ci];
          if (
            singleModelContext.length === 0 &&
            isLocalSingleModelContext(ctxText)
          ) {
            singleModelContext = ctxText;
          }
          if (
            singleModelContext.length > 0 &&
            modelQuotaAnchor.length === 0 &&
            !hasSessionContext(ctxText)
          ) {
            modelQuotaAnchor = modelQuotaAnchorFor(ctxText);
          }
          var kind = classifyWindow(ctxText);
          if (kind !== "unknown" && isUsableDirectWindowContext(ctxText)) {
            samples.push({
              windowKind: kind,
              label: label,
              context: ctxText.slice(0, 200),
            });
            resolved = true;
            break;
          }
        }
        if (resolved) break;
        ctxNode = ctxNode.parentNode;
        depth += 1;
      }
      if (
        !resolved &&
        singleModelContext.length > 0 &&
        modelQuotaAnchor.length > 0
      ) {
        var syntheticContext = singleModelContext + " " + modelQuotaAnchor;
        var syntheticKind = classifyWindow(syntheticContext);
        if (syntheticKind !== "unknown") {
          samples.push({
            windowKind: syntheticKind,
            label: label,
            context: syntheticContext.slice(0, 200),
          });
        }
      }
    }
    return samples;
  }

  function pickResetLabelForWindow(resetSamples, windowKind) {
    for (var i = 0; i < resetSamples.length; i++) {
      var sample = resetSamples[i];
      if (sample.windowKind === windowKind) return sample.label;
    }
    return null;
  }

  // Map a label's weekday token to a 0-6 index (Sunday = 0), or -1 when the
  // label names no weekday. Japanese weekdays are only honoured inside
  // parentheses — bare 日 / 月 also mean "day" / "month" in the relative
  // forms, so the paren guard keeps "N日後" from being read as a weekday.
  function resolveWeekday(label) {
    var jp = label.match(/[（(]\s*([日月火水木金土])\s*[)）]/);
    if (jp) return "日月火水木金土".indexOf(jp[1]);
    // Whole-token match (full name or 3-letter abbreviation) so a weekday
    // prefix can't be read out of an unrelated word — e.g. "mon" in "month".
    var en = label
      .toLowerCase()
      .match(
        /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/,
      );
    if (en) {
      return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(
        en[1].slice(0, 3),
      );
    }
    return -1;
  }

  function deriveResetAt(label) {
    if (!label) return null;
    // Absolute weekday + clock-time form used by claude.ai's weekly window:
    // "8:00 (日)" (Japanese) or "8:00 AM Sun" (English). Resolve to the next
    // occurrence of that weekday/time strictly after now in local time, then
    // serialise to UTC ISO like the relative branches below (mirrors the
    // local-time HH:MM handling in extractors/codex.js).
    var dow = resolveWeekday(label);
    var tod = label.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (dow >= 0 && tod) {
      var hh = parseInt(tod[1], 10);
      var mm = parseInt(tod[2], 10);
      var ap = tod[3] ? tod[3].toLowerCase() : "";
      if (ap === "pm" && hh < 12) hh += 12;
      else if (ap === "am" && hh === 12) hh = 0;
      if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60) {
        var now = new Date();
        var dt = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          hh,
          mm,
        );
        dt.setDate(dt.getDate() + ((dow - now.getDay() + 7) % 7));
        if (dt.getTime() <= now.getTime()) dt.setDate(dt.getDate() + 7);
        return dt.toISOString();
      }
    }
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
    var resetSamples = collectResetSamples();
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      var kind = classifyWindow(s.context);
      // Drop "unknown" samples — without a window-kind keyword nearby
      // (5-hour / weekly / opus), the percent value is almost certainly a
      // false positive (sidebar chat titles like "100%キーボードの代替"
      // showed up as `unknown` rows in the wild). The Rust side then
      // treats an empty rows array as `no-rows` and retries.
      if (kind === "unknown") continue;
      var label = pickResetLabelForWindow(resetSamples, kind);
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
