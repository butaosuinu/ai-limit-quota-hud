// Codex (chatgpt.com) usage page extractor.
//
// This script runs inside an isolated WebView pointed at
// https://chatgpt.com/codex/settings/usage. It must not assume any
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

  // Labels we look for on each usage "card" — case-insensitive substrings,
  // because chatgpt.com mixes "5h session", "weekly", and friendly variants.
  // The auto-formatter has historically dropped Japanese regex literals
  // when collapsing these arrays to one line — keep each pattern on its
  // own line so a future reformat can't silently lose them.
  var SESSION_LABEL_PATTERNS = [
    /5\s*h\s*session/i,
    /5-?hour\s*session/i,
    /session\s+limit/i,
    /5[\s-]*hour/i,
    /5時間.*使用制限/,
    /5時間.*制限/,
    /5時間/,
    /セッション/,
  ];
  var WEEKLY_LABEL_PATTERNS = [
    /weekly/i,
    /per\s+week/i,
    /this\s+week/i,
    /週あたり.*使用制限/,
    /週あたり.*制限/,
    /週あたり/,
    /週間/,
  ];

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
    // Layered signals for "session expired / user must re-authenticate":
    //
    // 1. Explicit redirect to a login route (`/auth/login`, `/login`).
    // 2. ChatGPT root bounce: unauth requests to the analytics page often
    //    don't redirect cleanly — they land on `/` with the marketing /
    //    login modal page. Only treat the *root* pathname as logged-out
    //    (and only when the marketing-side login CTA is visible) so we
    //    don't misclassify other authenticated routes — e.g. a future
    //    `/codex/settings/...` move would be a route change, not a logout.
    // 3. A `/auth/login` anchor is visible (the marketing root renders it).
    if (location && typeof location.pathname === "string") {
      var pathname = location.pathname;
      if (pathname.indexOf("/auth/login") === 0) return true;
      if (pathname.indexOf("/login") === 0) return true;
      if (pathname === "/" || pathname === "") {
        // chatgpt.com renders the marketing root in the user's locale; the
        // login CTA is therefore translated. Match the English forms
        // (lower-cased body) and the most common non-English ones in their
        // native script — toLowerCase is a no-op on those characters, so
        // they survive the lowering step intact.
        var rootBody = bodyText();
        var rootText = rootBody.toLowerCase();
        if (
          rootText.indexOf("log in") !== -1 ||
          rootText.indexOf("sign up") !== -1 ||
          rootText.indexOf("get started") !== -1 ||
          rootBody.indexOf("ログイン") !== -1 ||
          rootBody.indexOf("サインアップ") !== -1 ||
          rootBody.indexOf("無料で始める") !== -1 ||
          rootBody.indexOf("アカウントを作成") !== -1
        ) {
          return true;
        }
      }
    }
    var anchors = document.querySelectorAll('a[href*="/auth/login"]');
    if (anchors && anchors.length > 0) return true;
    return false;
  }

  function deriveResetAt(label) {
    if (!label) return null;
    // If the label already looks like an ISO-8601 timestamp, surface it
    // verbatim — the Rust side stores the string and the UI renders it.
    var iso = label.match(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/,
    );
    if (iso) return iso[0];
    // chatgpt.com's Codex Analytics card uses two locale-formatted absolute
    // shapes: `YYYY/MM/DD HH:MM` for resets more than 24h away (the weekly
    // window), and bare `HH:MM` for resets later today (the 5h window).
    // Both are local-time and need to be converted to a UTC ISO string so
    // the overlay's `formatResetCountdown` can render them consistently.
    var ymdhm = label.match(
      /(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/,
    );
    if (ymdhm) {
      var ymd = new Date(
        parseInt(ymdhm[1], 10),
        parseInt(ymdhm[2], 10) - 1,
        parseInt(ymdhm[3], 10),
        parseInt(ymdhm[4], 10),
        parseInt(ymdhm[5], 10),
      );
      if (
        ymd.getFullYear() === Number(ymdhm[1]) &&
        ymd.getMonth() === Number(ymdhm[2]) - 1 &&
        ymd.getDate() === Number(ymdhm[3]) &&
        ymd.getHours() === Number(ymdhm[4]) &&
        ymd.getMinutes() === Number(ymdhm[5])
      )
        return ymd.toISOString();
      return null;
    }
    var hm = label.match(/^\s*(\d{1,2}):(\d{2})\s*$/);
    if (hm) {
      var hh = parseInt(hm[1], 10);
      var mm = parseInt(hm[2], 10);
      if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60) {
        var now = new Date();
        var dt = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          hh,
          mm,
        );
        // If the wall-clock time already passed today, assume it's the
        // *next* occurrence (chatgpt.com only shows the short HH:MM form
        // when reset is within ~24h, so this is the right default).
        if (dt.getTime() < Date.now()) {
          dt.setDate(dt.getDate() + 1);
        }
        return dt.toISOString();
      }
    }
    var jpPattern = /(\d+)\s*(週間?|日|時間|分|秒)/g;
    var jpMs = 0;
    var jp;
    while ((jp = jpPattern.exec(label)) !== null) {
      var multiplier = {
        週: 604800000,
        週間: 604800000,
        日: 86400000,
        時間: 3600000,
        分: 60000,
        秒: 1000,
      }[jp[2]];
      jpMs += Number(jp[1]) * multiplier;
    }
    if (jpMs > 0) return new Date(Date.now() + jpMs).toISOString();
    // Walk every duration component in the label and sum them. This handles
    // both the long form (`3 hours`, `12 minutes`, `2 days`) and the compact
    // form chatgpt.com tends to render (`in 3h 12m`, `2d 4h`, `45m`). Using
    // a single global regex lets us add up mixed labels — `1h 30m` becomes
    // 5400_000 ms — instead of taking only the first component the previous
    // single-match version captured.
    var pattern =
      /(\d+)\s*(weeks?|w|days?|d|hours?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
    var totalMs = 0;
    var matched = false;
    var match;
    while ((match = pattern.exec(label)) !== null) {
      var n = parseInt(match[1], 10);
      if (!isFinite(n) || n < 0) continue;
      var unit = match[2].toLowerCase();
      if (unit === "w" || unit.indexOf("week") === 0) {
        totalMs += n * 7 * 24 * 60 * 60 * 1000;
      } else if (unit === "d" || unit.indexOf("day") === 0) {
        totalMs += n * 24 * 60 * 60 * 1000;
      } else if (unit === "h" || unit.indexOf("hour") === 0) {
        totalMs += n * 60 * 60 * 1000;
      } else if (
        unit === "m" ||
        unit === "min" ||
        unit === "mins" ||
        unit.indexOf("minute") === 0
      ) {
        totalMs += n * 60 * 1000;
      } else if (
        unit === "s" ||
        unit === "sec" ||
        unit === "secs" ||
        unit.indexOf("second") === 0
      ) {
        totalMs += n * 1000;
      } else {
        continue;
      }
      matched = true;
    }
    if (!matched) return null;
    return new Date(Date.now() + totalMs).toISOString();
  }

  function diagSnippet(text) {
    return (text || "").slice(0, 600).replace(/\s+/g, " ").trim();
  }

  function diagPath() {
    try {
      return (location && location.pathname) || "";
    } catch (e) {
      return "";
    }
  }

  function isHidden(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.hidden || node.getAttribute("aria-hidden") === "true") return true;
    var style = window.getComputedStyle(node);
    return style.display === "none" || style.visibility === "hidden";
  }

  function readVisibleText(node) {
    if (!node || isHidden(node)) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    var parts = [];
    for (var i = 0; i < node.childNodes.length; i += 1) {
      parts.push(readVisibleText(node.childNodes[i]));
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function percentCount(text) {
    return (text.match(/\d+(?:\.\d+)?\s*%/g) || []).length;
  }

  function isBreakdown(text) {
    return /\bgpt[\s-]?\d|\bspark\b|code\s*review|コードレビュー/i.test(text);
  }

  function isExplanation(text) {
    return /up\s+to|maximum|at\s+most|最大|まで利用|節約/i.test(text);
  }

  function hasBreakdownHeading(node, sampleNode) {
    var child = node.firstElementChild;
    while (child && !child.contains(sampleNode)) {
      var text = readVisibleText(child);
      if (percentCount(text) > 0) break;
      if (isBreakdown(text)) return true;
      child = child.nextElementSibling;
    }
    return false;
  }

  function collectPercentSamples() {
    var samples = [];
    var walker = document.createTreeWalker(
      document.body || document.documentElement,
      NodeFilter.SHOW_TEXT,
      null,
    );
    var node;
    while ((node = walker.nextNode())) {
      var text = (node.nodeValue || "").trim();
      var match = text.match(/(^|[^\d.+−-])(\d+(?:\.\d+)?)\s*%/);
      if (!match || isExplanation(text)) continue;
      var pct = parseFloat(match[2]);
      if (!isFinite(pct) || pct < 0 || pct > 100) continue;
      var cursor = node.parentElement;
      var hidden = false;
      while (cursor) {
        if (isHidden(cursor)) {
          hidden = true;
          break;
        }
        cursor = cursor.parentElement;
      }
      if (hidden) continue;
      cursor = node.parentElement;
      var sample = null;
      for (var depth = 0; cursor && depth < 6; depth += 1) {
        if (cursor.matches("body,html,main")) break;
        var own = readVisibleText(cursor);
        var heading = cursor.previousElementSibling;
        if (
          hasBreakdownHeading(cursor, node) ||
          (heading &&
            percentCount(readVisibleText(heading)) === 0 &&
            isBreakdown(readVisibleText(heading)))
        ) {
          sample = null;
          break;
        }
        if (percentCount(own) !== 1 || own.length > 600) break;
        if (isBreakdown(own) || isExplanation(own)) {
          sample = null;
          break;
        }
        var cards = cursor.querySelectorAll("section,article,tr");
        var crossesCard = false;
        for (var c = 0; c < cards.length; c += 1) {
          if (!cards[c].contains(node) && readVisibleText(cards[c]))
            crossesCard = true;
        }
        if (crossesCard) break;
        var context = own;
        var previous = cursor.previousElementSibling;
        if (classifyContext(context) === "unknown" && previous) {
          var label = readVisibleText(previous);
          if (percentCount(label) === 0 && !pickResetLabel(label)) {
            context = label + " " + own;
          }
        }
        if (isBreakdown(context) || isExplanation(context)) break;
        if (classifyContext(context) !== "unknown") {
          sample = { pct: pct, context: context, node: cursor };
        }
        cursor = cursor.parentElement;
      }
      if (sample) samples.push(sample);
    }
    return samples;
  }

  function classifyContext(context) {
    var i;
    var matchesSession = false;
    var matchesWeekly = false;
    for (i = 0; i < SESSION_LABEL_PATTERNS.length; i += 1) {
      if (SESSION_LABEL_PATTERNS[i].test(context)) {
        matchesSession = true;
        break;
      }
    }
    for (i = 0; i < WEEKLY_LABEL_PATTERNS.length; i += 1) {
      if (WEEKLY_LABEL_PATTERNS[i].test(context)) {
        matchesWeekly = true;
        break;
      }
    }
    // Ambiguous: context mentions both window kinds — we can't tell which
    // percent the sample belongs to, so drop it. This typically happens
    // when the ancestor walk climbed too high and captured the whole
    // analytics section. The caller will simply skip it.
    if (matchesSession && matchesWeekly) return "unknown";
    if (matchesSession) return "five-hours";
    if (matchesWeekly) return "weekly";
    return "unknown";
  }

  function flipIfRemaining(pct, context) {
    var saysRemaining =
      /%\s*(?:remaining|left|残り|残量)|(?:remaining|left|残り|残量)\s*[:：]?\s*\d+(?:\.\d+)?\s*%/i.test(
        context,
      );
    var saysUsed =
      /%\s*(?:used|consumed|使用済|消費)|(?:used|consumed|使用済み?|消費)\s*[:：]?\s*\d+(?:\.\d+)?\s*%/i.test(
        context,
      );
    if (saysRemaining && !saysUsed) {
      var inverted = 100 - pct;
      if (inverted >= 0 && inverted <= 100) return inverted;
    }
    return pct;
  }

  function pickResetLabel(text) {
    var jpRelative = text.match(
      /((?:\d+\s*(?:週間?|日|時間|分|秒)\s*)+)後に?リセット/,
    );
    if (jpRelative) return jpRelative[1].trim();
    var jp = text.match(/リセット[：:]\s*(.+)$/);
    if (jp) return jp[1].trim();
    var en = text.match(
      /(?:resets?|renews?|refreshes?)\s+(?:in|at|on)?\s*([^\n|]+)/i,
    );
    return en ? en[1].trim() : null;
  }

  function findResetForSample(sample, kind) {
    var label = pickResetLabel(readVisibleText(sample.node));
    if (label) return label;
    var sibling = sample.node.nextElementSibling;
    while (sibling) {
      if (sibling.matches("h1,h2,h3,h4,h5,h6,section,article,tr")) break;
      var text = readVisibleText(sibling);
      if (percentCount(text) > 0 || isBreakdown(text)) break;
      var siblingKind = classifyContext(text);
      if (siblingKind !== "unknown" && siblingKind !== kind) break;
      label = pickResetLabel(text);
      if (label) return label;
      sibling = sibling.nextElementSibling;
    }
    return null;
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
    var perWindow = {};
    var classCounts = { five: 0, weekly: 0, unknown: 0 };
    for (var i = 0; i < samples.length; i += 1) {
      var s = samples[i];
      var kind = classifyContext(s.context);
      if (kind === "five-hours") classCounts.five += 1;
      else if (kind === "weekly") classCounts.weekly += 1;
      else classCounts.unknown += 1;
      if (kind === "unknown") continue;
      if (perWindow[kind]) continue;
      var label = findResetForSample(s, kind);
      perWindow[kind] = {
        windowKind: kind,
        percentUsed: flipIfRemaining(s.pct, s.context),
        resetAt: deriveResetAt(label),
        resetLabel: label,
        raw: s.context.slice(0, 200),
      };
    }
    var rows = [];
    if (perWindow["five-hours"]) rows.push(perWindow["five-hours"]);
    if (perWindow["weekly"]) rows.push(perWindow["weekly"]);
    if (rows.length === 0) {
      // The page may still be hydrating. Caller polls again on a delay.
      var ctx0 =
        samples.length > 0 ? samples[0].context.slice(0, 120) : "(none)";
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
          " cls=5h:" +
          classCounts.five +
          "/wk:" +
          classCounts.weekly +
          "/?:" +
          classCounts.unknown +
          " pw=5h:" +
          (perWindow["five-hours"] ? "Y" : "N") +
          "/wk:" +
          (perWindow["weekly"] ? "Y" : "N") +
          " head=" +
          diagSnippet(text).slice(0, 160) +
          " ctx0=" +
          ctx0,
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
      var finalText = bodyText();
      emit({
        ok: false,
        kind: "no-rows-final",
        message:
          "chatgpt.com codex usage rows did not render within " +
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
