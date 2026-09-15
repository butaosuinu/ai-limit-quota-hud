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
      if (isNodeHiddenInTree(node)) continue;
      var text = (node.nodeValue || "").trim();
      if (text.length === 0) continue;
      // Match "<digits>%" or "<digits>.<digits>%" with optional surrounding
      // whitespace. We intentionally don't anchor — text nodes can wrap a
      // single percent inline with the label.
      var m = text.match(/(?:^|[^\d.+\-−])(\d+(?:\.\d+)?)\s*%/);
      if (!m) continue;
      var pct = parseFloat(m[1]);
      if (!isFinite(pct) || pct < 0 || pct > 100) continue;
      if (isPercentDescription(node)) continue;
      // Climb up a few ancestors to grab context. Stop after ~6 levels so we
      // don't bring in the entire document.
      var ctxNode = node.parentNode;
      var nearestContext = "";
      var localQuotaContext = "";
      var modelQuotaAnchor = "";
      var depth = 0;
      while (ctxNode && depth < 6) {
        var candidates = contextCandidatesFor(ctxNode, depth);
        for (var ci = 0; ci < candidates.length; ci++) {
          var ctxText = candidates[ci];
          if (localQuotaContext.length === 0 && isLocalQuotaContext(ctxText)) {
            localQuotaContext = ctxText;
            modelQuotaAnchor = scopedModelQuotaAnchorFor(ctxNode);
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
        node: node,
        pct: pct,
        context:
          nearestContext.length > 0
            ? nearestContext
            : localQuotaContext.length > 0 && modelQuotaAnchor.length > 0
              ? localQuotaContext + " " + modelQuotaAnchor
              : "",
      });
    }
    return samples;
  }

  function isElementHidden(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.hidden) return true;
    if (node.getAttribute && node.getAttribute("aria-hidden") === "true") {
      return true;
    }
    var inlineStyle = node.getAttribute ? node.getAttribute("style") || "" : "";
    if (/display\s*:\s*none/i.test(inlineStyle)) return true;
    if (/visibility\s*:\s*hidden/i.test(inlineStyle)) return true;
    try {
      var style = window.getComputedStyle
        ? window.getComputedStyle(node)
        : null;
      if (style) {
        if (style.display === "none") return true;
        if (style.visibility === "hidden") return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  function isNodeHiddenInTree(node) {
    var cursor = node;
    while (cursor) {
      if (isElementHidden(cursor) || isExcludedSection(cursor)) return true;
      cursor = cursor.parentNode;
    }
    return false;
  }

  function isExcludedSection(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.getAttribute("role") === "status") return true;
    if (node.tagName !== "SECTION") return false;
    var heading = node.querySelector("h1, h2, h3, h4");
    return (
      !!heading &&
      /製品別|usage by product|product usage/i.test(heading.textContent || "")
    );
  }

  function readNodeText(node, includeDescriptions) {
    if (!node) return "";
    if (isElementHidden(node) || isExcludedSection(node)) return "";
    if (node.nodeType === Node.TEXT_NODE) {
      var value = (node.nodeValue || "").trim();
      return !includeDescriptions && isCapDescription(value) ? "" : value;
    }
    var children = node.childNodes || [];
    var parts = [];
    for (var i = 0; i < children.length; i++) {
      var text = readNodeText(children[i], includeDescriptions);
      if (text.length > 0) parts.push(text);
    }
    if (children.length > 0) {
      var joined = parts.join(" ").replace(/\s+/g, " ").trim();
      return !includeDescriptions &&
        percentValueCount(joined) === 1 &&
        isCapDescription(joined)
        ? ""
        : joined;
    }
    if (typeof node.innerText === "string") return node.innerText.trim();
    return ((node && node.textContent) || "").trim();
  }

  function previousSiblingTexts(node, maxCount) {
    var out = [];
    var sibling = node.previousSibling;
    while (sibling && out.length < maxCount) {
      var text = readNodeText(sibling);
      if (isCapDescription(text)) {
        sibling = sibling.previousSibling;
        continue;
      }
      if (percentValueCount(text) > 0) break;
      if (text.length > 0) out.unshift(text);
      sibling = sibling.previousSibling;
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
    return [ownText, localText];
  }

  function percentValueCount(context) {
    var matches = context.match(/\d+(?:\.\d+)?\s*%/g);
    return matches ? matches.length : 0;
  }

  function isCapDescription(text) {
    return (
      percentValueCount(text) > 0 &&
      (/\bup to\b|\bmaximum\b|最大/i.test(text) ||
        /%\s*(?:of (?:your |the )?weekly|まで)/i.test(text))
    );
  }

  function isPercentDescription(node) {
    var cursor = node;
    var depth = 0;
    while (cursor && depth < 6) {
      var text = readNodeText(cursor, true);
      if (percentValueCount(text) > 1) break;
      if (isCapDescription(text)) return true;
      cursor = cursor.parentNode;
      depth += 1;
    }
    return false;
  }

  function hasAllModelsContext(context) {
    return /\ball models\b|すべてのモデル|全モデル/i.test(context);
  }

  function hasFableContext(context) {
    return context.toLowerCase().indexOf("fable") !== -1;
  }

  function hasOpusContext(context) {
    return context.toLowerCase().indexOf("opus") !== -1;
  }

  function hasExactlyOneQuotaLabel(context) {
    var isFable = hasFableContext(context);
    var isOpus = hasOpusContext(context);
    var isAllModels = hasAllModelsContext(context);
    return Number(isFable) + Number(isOpus) + Number(isAllModels) === 1;
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
      context.indexOf("今週") !== -1 ||
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

  function scopedModelQuotaAnchorFor(node) {
    var cursor = node;
    var depth = 0;
    while (cursor && depth < 5) {
      var sibling = cursor.previousSibling;
      while (sibling) {
        var text = readNodeText(sibling);
        if (
          (hasStrongRateLimitContext(text) || hasWeeklyContext(text)) &&
          !hasSessionContext(text) &&
          percentValueCount(text) === 0
        ) {
          return "rate limit";
        }
        sibling = sibling.previousSibling;
      }
      cursor = cursor.parentNode;
      depth += 1;
    }
    return "";
  }

  function isModelWindowKind(kind) {
    return kind === "weekly-fable" || kind === "weekly-opus";
  }

  function isLocalQuotaContext(context) {
    return (
      hasExactlyOneQuotaLabel(context) &&
      !hasSessionContext(context) &&
      percentValueCount(context) <= 1
    );
  }

  function isUsableDirectWindowContext(context) {
    if (percentValueCount(context) > 1 || isCapDescription(context))
      return false;
    var kind = classifyWindow(context);
    if (kind === "unknown") return false;
    if (!isModelWindowKind(kind)) return true;
    return isLocalQuotaContext(context);
  }

  function classifyWindow(context) {
    var isFable = hasFableContext(context);
    var isOpus = hasOpusContext(context);
    var isAllModels = hasAllModelsContext(context);
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
    if (isAllModels && (isFable || isOpus)) return "unknown";
    if (isFable && (isWeekly || isRateLimit)) return "weekly-fable";
    if (isOpus && (isWeekly || isRateLimit)) return "weekly-opus";
    if (isSession) return "five-hours";
    if (isAllModels && (isWeekly || isRateLimit)) return "weekly";
    if (isWeekly) return "weekly";
    return "unknown";
  }

  // Pull the reset label from the same quota card as the measured percent.
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
      /(\d{1,2}:\d{2})\s*[（(]\s*([日月火水木金土](?:曜日)?)\s*[)）]/,
    );
    if (jpWeekday) {
      return jpWeekday[1] + " (" + jpWeekday[2] + ")";
    }
    var jpClock = context.match(/(?:^|[^\d:])(\d{1,2}:\d{2})\s*にリセット/);
    if (jpClock) return jpClock[1];
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

  function hasDifferentWindow(text, windowKind) {
    var heading = text.split(
      /resets?|renews?|refreshes?|(?:\d+\s*(?:週間?|日|時間|分)\s*)+後/i,
    )[0];
    var kind = classifyWindow(heading);
    if (kind === "unknown" && hasExactlyOneQuotaLabel(heading)) {
      kind = classifyWindow(heading + " rate limit");
    }
    return kind !== "unknown" && kind !== windowKind;
  }

  function pickResetLabelFromNode(node) {
    var text = readNodeText(node);
    if (text.length === 0) return null;
    var children = node.children || [];
    for (var i = 0; i < children.length; i++) {
      var label = pickResetLabelFromNode(children[i]);
      if (label) return label;
    }
    return pickResetLabel(text);
  }

  function pickResetLabelForSample(sample, windowKind) {
    var cursor = sample.node.parentNode;
    var depth = 0;
    while (cursor && depth < 6) {
      var text = readNodeText(cursor);
      if (
        percentValueCount(text) > 1 ||
        hasDifferentWindow(text, windowKind) ||
        containsOtherCard(cursor, sample.node, windowKind)
      )
        break;
      var label = pickResetLabelFromNode(cursor);
      if (label) return label;
      var adjacentLabel = pickAdjacentResetLabel(cursor);
      if (adjacentLabel) return adjacentLabel;
      cursor = cursor.parentNode;
      depth += 1;
    }
    return null;
  }

  function pickAdjacentResetLabel(node) {
    var sibling = node.nextSibling;
    while (sibling) {
      var text = readNodeText(sibling);
      if (text.length > 0) {
        if (text.length > 100 || percentValueCount(text) > 0) return null;
        if (sibling.querySelector && sibling.querySelector("h1, h2, h3, h4"))
          return null;
        if (
          !/^(?:resets?\b|\d{1,2}:\d{2}\b|\d+\s*(?:週間?|日|時間|分))/i.test(
            text,
          )
        )
          return null;
        return pickResetLabel(text);
      }
      sibling = sibling.nextSibling;
    }
    return null;
  }

  function containsOtherCard(node, sampleNode, windowKind) {
    var children = node.children || [];
    var passedSample = false;
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.contains(sampleNode)) {
        passedSample = true;
        continue;
      }
      var heading = child.matches("h1, h2, h3, h4")
        ? child
        : child.querySelector("h1, h2, h3, h4");
      if (!heading || isElementHidden(child)) continue;
      var headingText = readNodeText(heading);
      if (
        !passedSample &&
        !child.matches("section, article, tr") &&
        classifyWindow(headingText + " rate limit") === windowKind
      )
        continue;
      if (passedSample || readNodeText(child) !== headingText) return true;
    }
    return false;
  }

  function percentUsedForSample(sample) {
    var cursor = sample.node;
    var depth = 0;
    while (cursor && depth < 6) {
      var text = readNodeText(cursor);
      if (percentValueCount(text) > 1) break;
      var remaining =
        /%\s*(?:remaining|left|残り|残量)|(?:remaining|left|残り|残量)\s*\d+(?:\.\d+)?\s*%/i.test(
          text,
        );
      var used =
        /%\s*(?:used|consumed|使用済|消費)|(?:used|consumed|使用済み?|消費)\s*\d+(?:\.\d+)?\s*%/i.test(
          text,
        );
      if (remaining && used) return null;
      if (remaining) return 100 - sample.pct;
      if (used) return sample.pct;
      cursor = cursor.parentNode;
      depth += 1;
    }
    return sample.pct;
  }

  // Map a label's weekday token to a 0-6 index (Sunday = 0), or -1 when the
  // label names no weekday. Japanese weekdays are only honoured inside
  // parentheses — bare 日 / 月 also mean "day" / "month" in the relative
  // forms, so the paren guard keeps "N日後" from being read as a weekday.
  function resolveWeekday(label) {
    var jp = label.match(/[（(]\s*([日月火水木金土])(?:曜日)?\s*[)）]/);
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
    if (tod && (dow >= 0 || /^\d{1,2}:\d{2}\s*(?:am|pm)?$/i.test(label))) {
      var hh = parseInt(tod[1], 10);
      var mm = parseInt(tod[2], 10);
      var ap = tod[3] ? tod[3].toLowerCase() : "";
      if (ap && (hh < 1 || hh > 12)) return null;
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
        if (dow >= 0) dt.setDate(dt.getDate() + ((dow - now.getDay() + 7) % 7));
        if (dt.getTime() <= now.getTime())
          dt.setDate(dt.getDate() + (dow >= 0 ? 7 : 1));
        return dt.toISOString();
      }
    }
    var duration =
      /(\d+)\s*(weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?=\d|\b)/gi;
    var totalEnglishMs = 0;
    var remainder = label.replace(duration, function (_, value, unit) {
      var factors = {
        w: 604800000,
        d: 86400000,
        h: 3600000,
        m: 60000,
        s: 1000,
      };
      totalEnglishMs +=
        parseInt(value, 10) * factors[unit.charAt(0).toLowerCase()];
      return "";
    });
    if (remainder.trim().length === 0) {
      var reset = new Date(Date.now() + totalEnglishMs);
      if (!isNaN(reset.getTime())) return reset.toISOString();
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
      var percentUsed = percentUsedForSample(s);
      if (percentUsed === null) continue;
      var label = pickResetLabelForSample(s, kind);
      rows.push({
        windowKind: kind,
        percentUsed: percentUsed,
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
