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
  // The auto-formatter has historically dropped Japanese regex literals
  // when collapsing these arrays to one line — keep each pattern on its
  // own line so a future reformat can't silently lose them.
  var SESSION_LABEL_PATTERNS = [
    /5\s*h\s*session/i,
    /5-?hour\s*session/i,
    /session\s+limit/i,
    /5\s*hour/i,
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
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?/,
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
      if (!isNaN(ymd.getTime())) return ymd.toISOString();
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

  // Walk every visible percent text node and gather a few ancestors' worth
  // of text as context for label classification. We don't need a single
  // container that holds both label and percent — a label keyword anywhere
  // in the climbed text is enough.
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
      var nodeText = (node.nodeValue || "").trim();
      if (nodeText.length === 0) continue;
      var pm = nodeText.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
      if (!pm) continue;
      var pct = parseFloat(pm[1]);
      if (!isFinite(pct) || pct < 0 || pct > 100) continue;
      // Climbing past depth=3 starts capturing both 5時間 and 週あたり
      // cards in the same context, collapsing classifyContext to "unknown"
      // — reset-time text is recovered later by `findResetForWindow`.
      // `textContent` (not `innerText`) keeps this cheap by avoiding
      // layout reflow inside the polling loop.
      var ctxNode = node.parentNode;
      var ctxLines = [];
      var depth = 0;
      while (ctxNode && depth < 3) {
        var ctxText = (ctxNode.textContent || "").trim();
        if (ctxText && ctxText.length < 400) {
          ctxLines.push(ctxText);
        }
        ctxNode = ctxNode.parentNode;
        depth += 1;
      }
      samples.push({ pct: pct, context: ctxLines.join(" | ") });
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
      /remaining|left/i.test(context) || /残り|残量/.test(context);
    var saysUsed =
      /used|consumed/i.test(context) || /使用済|消費/.test(context);
    if (saysRemaining && !saysUsed) {
      var inverted = 100 - pct;
      if (inverted >= 0 && inverted <= 100) return inverted;
    }
    return pct;
  }

  // Locate the reset label belonging to a specific usage card by anchoring
  // on its header text and scanning a short region forward. The percent and
  // the reset text live in sibling subtrees whose only common ancestor is
  // the analytics section — at that scope `classifyContext` would see both
  // 5時間 and 週あたり cards at once and return "unknown" for every sample,
  // so this lookup deliberately runs at the page level instead of expanding
  // `collectPercentSamples`'s ancestor walk.
  function findResetForWindow(bodyTxt, windowKind) {
    if (!bodyTxt) return null;
    var anchor = windowKind === "weekly" ? "週あたり" : "5時間";
    var idx = bodyTxt.indexOf(anchor);
    if (idx === -1) return null;
    // 240 chars covers "<label> NN% 残り リセット：…" including a long
    // YYYY/MM/DD HH:MM stamp without drifting into the next card.
    var region = bodyTxt.slice(idx, idx + 240);
    // Take the FIRST リセット in the region via a single alternation — a
    // two-pass "prefer YYYY/MM/DD" version skipped past the closer 5h
    // HH:MM and grabbed the weekly card's longer stamp instead.
    var m = region.match(
      /リセット[：:]\s*(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}|\d{1,2}:\d{2})/,
    );
    if (m) return m[1].replace(/\s+/g, " ").trim();
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
    var bestIsMain = {};
    var classCounts = { five: 0, weekly: 0, unknown: 0 };
    for (var i = 0; i < samples.length; i += 1) {
      var s = samples[i];
      var kind = classifyContext(s.context);
      if (kind === "five-hours") classCounts.five += 1;
      else if (kind === "weekly") classCounts.weekly += 1;
      else classCounts.unknown += 1;
      if (kind === "unknown") continue;
      // Per-model breakdown rows ("GPT-5.3-Codex-Spark 5時間の…0%") also
      // classify as five-hours; prefer a sample whose context names the
      // high-level "使用制限" / "limit" header so we don't surface a
      // per-model 0%.
      var isMain =
        /使用制限|limit/i.test(s.context) || /per\s+week/i.test(s.context);
      if (perWindow[kind] && (!isMain || bestIsMain[kind])) continue;
      perWindow[kind] = {
        windowKind: kind,
        percentUsed: flipIfRemaining(s.pct, s.context),
        resetAt: null,
        resetLabel: null,
        raw: s.context.slice(0, 200),
      };
      bestIsMain[kind] = isMain;
    }
    ["five-hours", "weekly"].forEach(function (kind) {
      var row = perWindow[kind];
      if (!row) return;
      var label = findResetForWindow(text, kind);
      if (label) {
        row.resetLabel = label;
        row.resetAt = deriveResetAt(label);
      }
    });
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
