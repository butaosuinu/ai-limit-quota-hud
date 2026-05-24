# QuotaHUD アプリアイコン 生成プロンプト

このファイルは `tools/icon/master.png`(1024×1024 PNG マスター)を再生成するための仕様書です。Codex CLI の image generation ツール、または同等の text-to-image モデルに以下のプロンプトを渡すと、設定画面・Overlay とビジュアルが揃ったアイコンが得られます。

実生成後は次のコマンドで全プラットフォーム用アイコンに展開してください:

```bash
pnpm tauri icon tools/icon/master.png --ios-color "#18181b"
```

---

## 仕様(英語、image-gen モデル向け)

A 1024×1024 PNG application icon with a fully transparent background.

**Base shape**:

- A perfectly symmetrical squircle (rounded square) centered in the canvas.
- Outer size: 880×880 px, centered (so there is ~72 px transparent padding on every side).
- Corner radius: ~200 px (about 22% of the squircle's edge), smooth iOS-style continuous curvature.
- Fill: a linear gradient at 135° (top-left to bottom-right) from `#4f8bff` (top-left) to `#2c5fcc` (bottom-right). The gradient must be smooth, no banding.
- A subtle top-down white sheen overlay: linear from `rgba(255, 255, 255, 0.12)` at the top edge of the squircle to `rgba(255, 255, 255, 0)` at the vertical midpoint. Keep it understated — flat-modern, not glossy/skeuomorphic.
- A 1.5 px inner stroke of `rgba(255, 255, 255, 0.18)` hugging the inside of the squircle.

**Central motif — three horizontal pill-shaped progress bars**:

- All three bars are white. No additional colors anywhere in the icon other than the blue gradient and white.
- Bar dimensions: each bar is 540 px wide × 56 px tall (pill, fully rounded ends, radius = 28 px).
- Vertical spacing: 72 px center-to-center between adjacent bars.
- The three bars are vertically centered as a group on the canvas.
- Each bar is a track + fill, both pill-shaped:
  - Track: `rgba(255, 255, 255, 0.22)` over the full 540 px width.
  - Fill: pure white `#ffffff` (opacity 1.0), left-aligned, on top of the track.
- Fill percentages, top to bottom: 80%, 55%, 25%. So:
  - Top bar: 432 px white fill (80% of 540).
  - Middle bar: 297 px white fill (55%).
  - Bottom bar: 135 px white fill (25%).
- Fill edges remain pill-rounded on the left (the bar's left end) and have a clean vertical edge where the fill stops.

**Style constraints**:

- Absolutely flat, modern, minimal. Think Raycast / Linear / Arc system icon language.
- No text, no letters, no logotype, no "Q" mark.
- No 3D rendering, no realistic photographic textures, no heavy glow, no glitter, no skeuomorphism.
- No jellyfish, no lightbulbs, no chips, no cartoon mascots.
- No shadow underneath the squircle (the OS adds drop shadows). Keep the canvas fully transparent outside the squircle.
- Pixel-sharp edges; the icon must remain readable down to 16×16 px.

**Output**:

- 1024 × 1024 px, PNG with alpha channel, sRGB color space.
- Save to: `tools/icon/master.png`.

---

## 色トークン対応(設定画面の `src/app.css` から引用)

| 用途            | 値                                       |
| --------------- | ---------------------------------------- |
| アプリベース    | `#18181b` (iOS のフォールバック色に使用) |
| アクセント青    | `#4f8bff`                                |
| アクセント青暗  | `#2c5fcc` (グラデーション終点)           |
| バッジ inset    | `rgba(255, 255, 255, 0.18)`              |
| バー (フィル)   | `#ffffff`                                |
| バー (トラック) | `rgba(255, 255, 255, 0.22)`              |

## 再生成手順

1. このプロンプト全文を codex / image-gen モデルに渡す。
2. 出力 PNG を `tools/icon/master.png` に保存(1024×1024、透過 PNG)。
3. `pnpm tauri icon tools/icon/master.png --ios-color "#18181b"` で `src-tauri/icons/` 配下を再生成。
4. `Read` で `src-tauri/icons/icon.png` などを目視確認、`pnpm tauri dev` で Dock / ウィンドウ表示を確認。
