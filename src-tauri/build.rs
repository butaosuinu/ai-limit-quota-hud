fn main() {
    println!("cargo:rustc-check-cfg=cfg(coverage_nightly)");
    // Force a rebuild whenever any extractor JS changes. `include_str!` is
    // expected to track its sources, but `tauri dev`'s incremental cycle
    // sometimes misses edits to these files, leaving stale extractor JS
    // embedded in the next binary. The explicit `rerun-if-changed` makes
    // the dependency unambiguous.
    println!("cargo:rerun-if-changed=src/providers/webview/extractors/claude.js");
    println!("cargo:rerun-if-changed=src/providers/webview/extractors/codex.js");
    tauri_build::build();
}
