// QuotaHUD Codex (chatgpt.com) usage extractor.
//
// Runs inside the hidden WebView window that PR #30 will navigate to
// `https://chatgpt.com/codex/cloud/settings/analytics`. The Rust side then
// polls `document.title` for the `QHJSON:` prefix; this script never talks
// to `__TAURI__` (which is intentionally not exposed on this origin, see
// PROJECT_SPEC §8.7) and never modifies the DOM beyond the title bar.
//
// The script is loaded via `include_str!` from `codex_web.rs` and injected
// once per scrape cycle. The DOM contract here is an *external, unstable*
// interface: the heuristics are written defensively, with a body-wide regex
// fallback, so a small layout tweak does not silently produce wrong data.
//
// All selectors and traversal logic in this file are written from scratch
// against the chatgpt.com analytics page; nothing is copied from any other
// project. When the page layout changes the appropriate response is to
// surface "layout may have changed" — never to invent a number.

(function () {
  "use strict";

  var TITLE_PREFIX = "QHJSON:";
  var LOGIN_HREF_FRAGMENT = "/auth/login";
  var CLOUDFLARE_PHRASES = ["verify you are human", "checking your browser"];
  var LAYOUT_SENTINEL = "layout may have changed";

  // Labels we look for on each usage "card" — case-insensitive substrings,
  // because the page mixes "5h session", "weekly", and friendly variants.
  var SESSION_LABEL_PATTERNS = [/5\s*h\s*session/i, /5-?hour\s*session/i, /session\s+limit/i];
  var WEEKLY_LABEL_PATTERNS = [/weekly/i, /per\s+week/i, /this\s+week/i];
  var RESET_LABEL_PATTERNS = [/resets?/i, /renews?/i, /refreshes?/i];

  // Model labels we recognise on the analytics page (for `account_label`).
  // Defensive: if none match we fall back to a generic "Codex (ChatGPT)".
  var MODEL_LABEL_PATTERNS = [
    /gpt-5-codex/i,
    /gpt-?5/i,
    /codex/i,
    /\bo1\b/i,
    /\bo3\b/i,
  ];

  function publish(payload) {
    // The title channel is shared with the host page, so we always overwrite
    // it; the Rust poller clears the title after consuming it.
    try {
      document.title = TITLE_PREFIX + JSON.stringify(payload);
    } catch (err) {
      // `JSON.stringify` should never throw for our shapes, but if the page
      // shadowed `JSON` we still need to surface *something* so the poller
      // sees an error rather than hanging.
      document.title = TITLE_PREFIX + '{"error":"stringify failed"}';
    }
  }

  function bodyText() {
    var body = document.body;
    if (!body) return "";
    var text = body.innerText || body.textContent || "";
    return typeof text === "string" ? text : "";
  }

  function detectCloudflare(text) {
    var lower = text.toLowerCase();
    for (var i = 0; i < CLOUDFLARE_PHRASES.length; i += 1) {
      if (lower.indexOf(CLOUDFLARE_PHRASES[i]) !== -1) return true;
    }
    return false;
  }

  function detectLogout() {
    // The chatgpt.com login redirect always renders an anchor pointing at
    // `/auth/login` somewhere on the page; if the script ran before redirect
    // completed we still want to surface "logged out" rather than scrape
    // partial junk.
    if (window.location && typeof window.location.pathname === "string") {
      if (window.location.pathname.indexOf(LOGIN_HREF_FRAGMENT) !== -1) {
        return true;
      }
    }
    var anchors = document.querySelectorAll('a[href*="' + LOGIN_HREF_FRAGMENT + '"]');
    return anchors.length > 0;
  }

  // Find the smallest DOM container that mentions `label` (case-insensitive),
  // then walk up a couple of levels so we get the whole "card". We pick the
  // narrowest ancestor whose text still satisfies the label match because
  // chatgpt.com often nests label + value inside the same `<section>`.
  function findCardByLabel(patterns) {
    var bodyEl = document.body;
    if (!bodyEl) return null;
    var walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_ELEMENT, null);
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
      if (!isNaN(pct) && pct >= 0 && pct <= 100) return pct;
    }
    var m2 = text.match(/(\d{1,3}(?:\.\d+)?)\s*percent/i);
    if (m2) {
      var pct2 = parseFloat(m2[1]);
      if (!isNaN(pct2) && pct2 >= 0 && pct2 <= 100) return pct2;
    }
    return null;
  }

  // Pull a "remaining %" out of a card by:
  // 1. trying the smallest container whose text matches the label,
  // 2. extracting a percent from the surrounding text,
  // 3. converting "used X%" → "remaining (100 - X)%" because chatgpt.com
  //    sometimes shows the consumed half of the bar instead of the remaining.
  // The "used vs remaining" inference is purely textual: we look for the
  // word "used" within the same card and flip the sign accordingly.
  function extractPercentFromCard(card) {
    if (!card) return null;
    var text = card.textContent || "";
    var pct = parsePercent(text);
    if (pct === null) return null;
    if (/used|consumed/i.test(text) && !/remaining|left/i.test(text)) {
      var inverted = 100 - pct;
      if (inverted >= 0 && inverted <= 100) return inverted;
    }
    return pct;
  }

  // Reset-time extraction tolerates ISO 8601, "in 3h 12m", and "May 20" style.
  // The Rust side stores the string verbatim; UI rendering decides how to
  // display it. We never invent a value — `null` is fine and surfaces
  // sensibly as "no reset info" in the overlay.
  function extractResetText(card) {
    if (!card) return null;
    var text = card.textContent || "";
    // Prefer an explicit ISO timestamp if present.
    var iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?/);
    if (iso) return iso[0];
    // Otherwise the friendly form ("Resets in 3h 12m", "Renews May 20").
    var friendly = text.match(/(?:resets?|renews?|refreshes?)[^.\n]{0,80}/i);
    if (friendly) {
      var trimmed = friendly[0].replace(/\s+/g, " ").trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    return null;
  }

  // Body-wide fallback: when card detection fails entirely we run a single
  // regex over the whole page text. This is intentionally less precise than
  // the card path but matches the spec: "if extractor returns null /
  // 'layout may have changed' → Error". Body-fallback gives us one more
  // chance to find *any* percent on the page before we admit failure.
  function bodyFallbackPercent(text, labelPatterns) {
    var lines = text.split(/\n+/);
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      for (var j = 0; j < labelPatterns.length; j += 1) {
        if (labelPatterns[j].test(line)) {
          var pct = parsePercent(line);
          if (pct !== null) {
            if (/used|consumed/i.test(line) && !/remaining|left/i.test(line)) {
              var inverted = 100 - pct;
              if (inverted >= 0 && inverted <= 100) return inverted;
            }
            return pct;
          }
        }
      }
    }
    return null;
  }

  function detectModelLabels(text) {
    var found = [];
    var seen = {};
    for (var i = 0; i < MODEL_LABEL_PATTERNS.length; i += 1) {
      var m = text.match(MODEL_LABEL_PATTERNS[i]);
      if (m) {
        var key = m[0].toLowerCase();
        if (!seen[key]) {
          seen[key] = true;
          found.push(m[0]);
        }
      }
    }
    return found;
  }

  function run() {
    var text = bodyText();

    if (detectCloudflare(text)) {
      publish({ status: "cloudflare" });
      return;
    }
    if (detectLogout()) {
      publish({ status: "logged-out" });
      return;
    }

    var sessionCard = findCardByLabel(SESSION_LABEL_PATTERNS);
    var weeklyCard = findCardByLabel(WEEKLY_LABEL_PATTERNS);
    var resetCard = findCardByLabel(RESET_LABEL_PATTERNS) || sessionCard || weeklyCard;

    var sessionPercent = extractPercentFromCard(sessionCard);
    if (sessionPercent === null) {
      sessionPercent = bodyFallbackPercent(text, SESSION_LABEL_PATTERNS);
    }
    var weeklyPercent = extractPercentFromCard(weeklyCard);
    if (weeklyPercent === null) {
      weeklyPercent = bodyFallbackPercent(text, WEEKLY_LABEL_PATTERNS);
    }

    var resetText = extractResetText(resetCard);

    var models = detectModelLabels(text);

    if (sessionPercent === null && weeklyPercent === null) {
      publish({
        status: "layout-changed",
        message: LAYOUT_SENTINEL,
      });
      return;
    }

    publish({
      status: "ok",
      sessionPercent: sessionPercent,
      weeklyPercent: weeklyPercent,
      resetText: resetText,
      models: models,
    });
  }

  run();
})();
