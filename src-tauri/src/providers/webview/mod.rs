//! Shared scaffolding for WebView-backed providers (PROJECT_SPEC §8.7).
//!
//! Concrete providers live in sibling modules (`claude_web`, `codex_web` —
//! arriving in later PRs) and rely on this module for:
//!
//! - **Per-provider session isolation** (`SessionStorage`): platform-aware
//!   selection between a Wry `data_directory` on Windows/Linux and a
//!   deterministic `dataStoreIdentifier` on macOS.
//! - **Egress allowlist primitives** (`ProviderHostAllowlist`,
//!   `KNOWN_IDP_SUFFIXES`): the static and dynamic halves of the rule in
//!   §14, kept here so both Claude and Codex providers can share matching
//!   semantics instead of re-implementing host matching twice.
//!
//! Actual WebView window orchestration (window builder calls, JS injection,
//! result polling) lives in `WebviewScraper`, which is filled in by the
//! provider-specific PRs. This module deliberately stops at pure helpers
//! that are easy to unit-test without a Tauri runtime.

use std::path::{Path, PathBuf};

use crate::model::ProviderKind;

pub mod claude_web;
pub mod scraper;

/// Slug used as the provider identifier (matches the `ProviderKind` serde
/// kebab form) and as the on-disk directory / dataStoreIdentifier seed.
///
/// Returns `None` for kinds that are not WebView-backed so callers can fail
/// loudly if they ever pass the wrong kind in.
pub fn provider_slug(kind: ProviderKind) -> Option<&'static str> {
    match kind {
        ProviderKind::WebviewClaudeAi => Some("webview-claude-ai"),
        ProviderKind::WebviewChatgptCodex => Some("webview-chatgpt-codex"),
        _ => None,
    }
}

/// Platform-specific handle to a WebView's persistent session storage.
///
/// On Windows and Linux, Tauri 2 / Wry honor `WebviewWindowBuilder::data_directory`,
/// so each provider gets its own profile directory. On macOS, that builder
/// hook is a no-op against WKWebView; per-provider isolation requires a
/// `WKWebsiteDataStore` keyed by a stable `dataStoreIdentifier`. We derive
/// the identifier deterministically (UUIDv5 over the slug) so it survives
/// app restarts.
// The two variants are platform-exclusive: `DataDirectory` is only
// constructed on Windows / Linux, `DataStoreIdentifier` only on macOS. From
// the compiler's POV one of them is always dead on a given target — silence
// the warning rather than fragmenting the enum behind cfg flags (which
// would force every consumer to match on the wrong shape per platform).
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionStorage {
    /// Windows / Linux: dedicated on-disk profile directory.
    DataDirectory(PathBuf),
    /// macOS: deterministic `WKWebsiteDataStore` identifier.
    DataStoreIdentifier(uuid::Uuid),
}

impl SessionStorage {
    /// Pick the right isolation mechanism for the current target OS.
    ///
    /// `data_dir` is the app's data directory (typically
    /// `tauri::AppHandle::path().app_data_dir()`); on macOS the path is not
    /// used, but the parameter is kept in the signature so call sites stay
    /// platform-agnostic.
    pub fn for_provider(kind: ProviderKind, data_dir: &Path) -> Option<Self> {
        let slug = provider_slug(kind)?;
        Some(Self::for_slug(slug, data_dir))
    }

    pub(crate) fn for_slug(slug: &str, data_dir: &Path) -> Self {
        #[cfg(target_os = "macos")]
        {
            let _ = data_dir; // suppress unused warning on macOS builds
                              // Seed the identifier from the slug. UUIDv5 + the DNS namespace
                              // is just a stable hash; the namespace choice is arbitrary, but
                              // keeping the seed deterministic means the same provider always
                              // gets the same WKWebsiteDataStore across app restarts.
            let id = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_DNS, slug.as_bytes());
            SessionStorage::DataStoreIdentifier(id)
        }
        #[cfg(not(target_os = "macos"))]
        {
            SessionStorage::DataDirectory(data_dir.join(slug))
        }
    }
}

/// Static portion of a provider's egress allowlist (§14).
///
/// Patterns are matched against URL hosts and may be either an exact host
/// (`claude.ai`) or a wildcard suffix (`*.anthropic.com`). The wildcard form
/// matches any subdomain — `api.anthropic.com`, `static.anthropic.com` —
/// but **not** the bare suffix itself; add an exact entry if you want to
/// permit both `anthropic.com` and `*.anthropic.com`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderHostAllowlist {
    pub patterns: &'static [&'static str],
}

impl ProviderHostAllowlist {
    pub const fn new(patterns: &'static [&'static str]) -> Self {
        Self { patterns }
    }

    pub fn permits(&self, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        self.patterns
            .iter()
            .any(|pattern| match_host(pattern, &host))
    }
}

fn match_host(pattern: &str, host: &str) -> bool {
    let pattern = pattern.to_ascii_lowercase();
    if let Some(suffix) = pattern.strip_prefix("*.") {
        host.ends_with(&format!(".{suffix}"))
    } else {
        host == pattern
    }
}

/// Well-known identity provider host suffixes that may be visited during a
/// login redirect chain (§8.7 / §14). These are admitted only while the
/// dynamic login allowlist is active; concrete providers are expected to
/// reset that state once the chain returns to the target origin.
///
/// The list is intentionally conservative: every entry is a domain that
/// users routinely authenticate against in the wild. Add new entries
/// through code review when a real provider's login flow needs them.
pub const KNOWN_IDP_SUFFIXES: &[&str] = &[
    "accounts.google.com",
    "appleid.apple.com",
    "login.microsoftonline.com",
    "okta.com",
    "auth0.com",
    "cloudflareaccess.com",
    "github.com",
];

/// Returns `true` if `host` matches any entry in `KNOWN_IDP_SUFFIXES`.
/// Matching is case-insensitive and treats each entry as a suffix so that
/// tenant-specific subdomains (e.g. `acme.okta.com`) are accepted.
pub fn host_is_known_idp(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    KNOWN_IDP_SUFFIXES.iter().any(|suffix| {
        let suffix = suffix.to_ascii_lowercase();
        host == suffix || host.ends_with(&format!(".{suffix}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_slug_only_matches_webview_kinds() {
        assert_eq!(
            provider_slug(ProviderKind::WebviewClaudeAi),
            Some("webview-claude-ai")
        );
        assert_eq!(
            provider_slug(ProviderKind::WebviewChatgptCodex),
            Some("webview-chatgpt-codex")
        );
        assert_eq!(provider_slug(ProviderKind::Manual), None);
        assert_eq!(provider_slug(ProviderKind::OpenAiApi), None);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn session_storage_is_data_directory_on_nonmacos() {
        let storage =
            SessionStorage::for_provider(ProviderKind::WebviewClaudeAi, Path::new("/tmp/app"))
                .expect("known kind");
        match storage {
            SessionStorage::DataDirectory(path) => {
                assert!(path.ends_with("webview-claude-ai"), "got {path:?}");
            }
            other => panic!("expected DataDirectory, got {other:?}"),
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn session_storage_uuid_is_stable_across_calls_on_macos() {
        let a = SessionStorage::for_provider(ProviderKind::WebviewClaudeAi, Path::new("/tmp/app"))
            .expect("known kind");
        let b = SessionStorage::for_provider(ProviderKind::WebviewClaudeAi, Path::new("/another"))
            .expect("known kind");
        match (a, b) {
            (
                SessionStorage::DataStoreIdentifier(ida),
                SessionStorage::DataStoreIdentifier(idb),
            ) => assert_eq!(ida, idb, "identifier must be deterministic"),
            other => panic!("expected stable UUIDs on macOS, got {other:?}"),
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn session_storage_uuid_differs_between_providers_on_macos() {
        let claude =
            SessionStorage::for_provider(ProviderKind::WebviewClaudeAi, Path::new("/tmp/app"))
                .expect("known kind");
        let codex =
            SessionStorage::for_provider(ProviderKind::WebviewChatgptCodex, Path::new("/tmp/app"))
                .expect("known kind");
        match (claude, codex) {
            (SessionStorage::DataStoreIdentifier(a), SessionStorage::DataStoreIdentifier(b)) => {
                assert_ne!(a, b)
            }
            other => panic!("expected DataStoreIdentifier on macOS, got {other:?}"),
        }
    }

    #[test]
    fn host_allowlist_matches_exact_and_wildcard_suffix() {
        let list = ProviderHostAllowlist::new(&["claude.ai", "*.anthropic.com"]);
        assert!(list.permits("claude.ai"));
        assert!(
            list.permits("CLAUDE.AI"),
            "host matching is case-insensitive"
        );
        assert!(list.permits("api.anthropic.com"));
        assert!(list.permits("static.anthropic.com"));
        // The wildcard form intentionally does not match the bare suffix
        // (would otherwise widen the rule on a stray entry).
        assert!(!list.permits("anthropic.com"));
        assert!(!list.permits("evil.com"));
        assert!(!list.permits("notclaude.ai"));
    }

    #[test]
    fn known_idp_matches_tenant_subdomains() {
        assert!(host_is_known_idp("accounts.google.com"));
        assert!(host_is_known_idp("acme.okta.com"));
        assert!(host_is_known_idp("login.microsoftonline.com"));
        assert!(host_is_known_idp("github.com"));
        assert!(!host_is_known_idp("example.com"));
        // The bare suffix `okta.com` matches; subdomains do too.
        assert!(host_is_known_idp("okta.com"));
    }
}
