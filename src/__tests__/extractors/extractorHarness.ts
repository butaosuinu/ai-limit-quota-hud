import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

type Options = {
  html: string;
  path?: string;
  now?: Date;
  /**
   * Upper bound for the fake-timer advance budget. The harness exits early
   * once `document.title` carries a terminal payload (`ok:true`,
   * `cloudflare-challenge`, `logged-out`, `emit-failed`); only `no-rows`
   * (which the extractor retries internally up to 15 × 700 ms ≈ 10.5 s)
   * actually consumes the full budget.
   */
  advanceMs?: number;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const PREFIX = "QHJSON:";

export const CLAUDE_JS = resolve(
  REPO_ROOT,
  "src-tauri/src/providers/webview/extractors/claude.js",
);
export const CODEX_JS = resolve(
  REPO_ROOT,
  "src-tauri/src/providers/webview/extractors/codex.js",
);

export type Payload =
  | { ok: true; rows: Array<Record<string, unknown>> }
  | { ok: false; kind: string; message?: string };

// jsdom 25 omits HTMLElement.innerText (https://github.com/jsdom/jsdom/issues/1245);
// the extractors read body.innerText directly to detect Cloudflare / login
// banners, so without a shim those branches never fire. We install once at
// module load; subsequent runs are no-ops because the property check below
// is idempotent.
{
  const proto = (
    globalThis as unknown as { HTMLElement?: { prototype: object } }
  ).HTMLElement?.prototype;
  if (proto !== undefined && !Object.hasOwn(proto, "innerText")) {
    Object.defineProperty(proto, "innerText", {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent ?? "";
      },
    });
  }
}

const SOURCE_CACHE = new Map<string, string>();
function loadExtractorSource(jsPath: string): string {
  const cached = SOURCE_CACHE.get(jsPath);
  if (cached !== undefined) return cached;
  const src = readFileSync(jsPath, "utf8");
  SOURCE_CACHE.set(jsPath, src);
  return src;
}

/**
 * Run an extractor IIFE against a freshly-prepared JSDOM body. Returns the
 * `QHJSON:`-prefixed payload that the script writes into `document.title`.
 */
export async function runExtractor(
  jsPath: string,
  opts: Options,
): Promise<Payload | null> {
  const { html, path = "/settings/usage", now, advanceMs = 11_000 } = opts;

  vi.useFakeTimers();
  if (now !== undefined) {
    vi.setSystemTime(now);
  }
  document.title = "loading";
  document.body.innerHTML = html;
  window.history.replaceState({}, "", path);

  const source = loadExtractorSource(jsPath);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(source)();

  // Poll the title; bail as soon as a terminal payload appears so
  // cloudflare/login/ok tests don't pay the full 11 s retry budget.
  const STEP = 100;
  let elapsed = 0;
  while (elapsed < advanceMs) {
    await vi.advanceTimersByTimeAsync(STEP);
    elapsed += STEP;
    const title = document.title;
    if (title.startsWith(PREFIX)) {
      const rest = title.slice(PREFIX.length);
      // `no-rows` is the only payload the extractor retries on; everything
      // else is terminal.
      if (!rest.includes('"no-rows"')) break;
    }
  }

  vi.useRealTimers();

  return parseTitle(document.title);
}

export function parseTitle(title: string): Payload | null {
  if (!title.startsWith(PREFIX)) return null;
  const body = title.slice(PREFIX.length);
  try {
    return JSON.parse(body) as Payload;
  } catch {
    return null;
  }
}

/** Reset DOM + timers + mocks after each extractor test. */
export function resetExtractorEnv(): void {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.title = "";
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
}
