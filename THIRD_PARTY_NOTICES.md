# THIRD_PARTY_NOTICES

This file collects upstream attributions for third-party software that
QuotaHUD draws design inspiration from or that it bundles at build time. It is
maintained separately from `LICENSE`, which covers QuotaHUD's own source code.

## ai-gauge

QuotaHUD's planned WebView-backed providers (see `docs/PROJECT_SPEC.md` §8.7)
are inspired by the architecture of [`ai-gauge`](https://github.com/jpajak/ai-gauge),
which uses an embedded headless browser to read the public usage settings
page of Claude and ChatGPT.

QuotaHUD does not vendor any source code from `ai-gauge`. The DOM extraction
JavaScript under `src-tauri/src/providers/webview/extractors/` is a clean-room
re-implementation written in this repository. This notice is included for
attribution because the high-level approach (per-provider WebView profile,
DOM-driven extractor, retry-via-sentinel, login-state detection) follows the
shape established by `ai-gauge`.

`ai-gauge` is distributed under the MIT License. Its license text is included
below for reference.

```
MIT License

Copyright (c) 2026 AI Gauge contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
