//! Local HTML preview (`agentero-html://`).
//!
//! Vault `.html` files render in a sandboxed iframe. The frame's URL is
//! `agentero-html://localhost/t/<token>/<name>` (Windows WebView2:
//! `http://agentero-html.localhost/t/<token>/<name>`). The token is minted
//! when the viewer opens one file and names that file's directory. Relative
//! images stay under the token; a page cannot mint a token for another
//! directory, and `..` never leaves it.
//!
//! The response carries its own CSP. Unlike `srcdoc`, it does not inherit the
//! app webview's policy. `script-src` is inline-only. `connect-src 'none'`
//! blocks `fetch`. The iframe sandbox is `allow-scripts` with no
//! `allow-same-origin`, so the page origin stays opaque.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::core::error::AppError;
use tauri::http::{header, Response, StatusCode};
use tauri::{AppHandle, Manager};

/// Largest preview body. Diagrams are single files; this rejects accidental
/// multi-megabyte dumps before they are copied into the webview.
const MAX_BYTES: u64 = 16 * 1024 * 1024;

/// Policy delivered with every preview response. `'self'` is useless here:
/// the sandboxed frame has an opaque origin, so subresources must name the
/// preview scheme explicitly.
pub const PREVIEW_CSP: &str = "\
default-src 'none'; \
script-src 'unsafe-inline'; \
style-src 'unsafe-inline' agentero-html: http://agentero-html.localhost https://fonts.googleapis.com; \
font-src data: agentero-html: http://agentero-html.localhost https://fonts.gstatic.com; \
img-src data: blob: agentero-html: http://agentero-html.localhost; \
connect-src 'none'; \
base-uri 'none'; \
form-action 'none'; \
frame-src 'none'; \
object-src 'none'";

/// One open preview directory, keyed by an unguessable token.
#[derive(Default)]
pub struct HtmlPreviewGrants {
    inner: Mutex<HashMap<String, PathBuf>>,
}

impl HtmlPreviewGrants {
    pub fn insert(&self, dir: PathBuf) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.lock().insert(token.clone(), dir);
        token
    }

    fn dir_for(&self, token: &str) -> Option<PathBuf> {
        self.lock().get(token).cloned()
    }

    /// Drop grants whose directory lives under `vault` (canonical holder key).
    pub fn revoke_vault(&self, vault: &Path) {
        self.lock().retain(|_, dir| !dir.starts_with(vault));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, PathBuf>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A file the viewer is allowed to open: an `.html` / `.htm` inside a held vault.
pub struct PreparedPreview {
    pub dir: PathBuf,
    pub name: String,
}

/// Resolve `path` to a preview grant. `vault_roots` are canonical holder keys.
pub fn prepare(vault_roots: &[String], path: &str) -> Result<PreparedPreview, AppError> {
    let raw = PathBuf::from(path.trim());
    if !raw.is_file() {
        return Err(AppError::message("html preview file is missing"));
    }
    let canon = std::fs::canonicalize(&raw)
        .map_err(|_| AppError::message("html preview file is unreadable"))?;
    let name = canon
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty() && !n.contains('/') && !n.contains('\\'))
        .ok_or_else(|| AppError::message("html preview file name is invalid"))?
        .to_string();
    let ext = Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "html" && ext != "htm" {
        return Err(AppError::message("html preview requires an html file"));
    }
    let dir = canon
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::message("html preview file is unreadable"))?;
    let inside = vault_roots
        .iter()
        .any(|root| canon.starts_with(Path::new(root)));
    if !inside {
        return Err(AppError::message(
            "html preview is limited to an open vault",
        ));
    }
    Ok(PreparedPreview { dir, name })
}

pub fn handle(
    app: AppHandle,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    if request.method() != tauri::http::Method::GET {
        responder.respond(preview_response(
            StatusCode::METHOD_NOT_ALLOWED,
            "text/plain; charset=utf-8",
            b"method not allowed".to_vec(),
        ));
        return;
    }
    let Some((token, rel)) = parse_preview_path(request.uri()) else {
        responder.respond(preview_response(
            StatusCode::BAD_REQUEST,
            "text/plain; charset=utf-8",
            b"bad preview path".to_vec(),
        ));
        return;
    };
    let Some(dir) = app.state::<HtmlPreviewGrants>().dir_for(&token) else {
        responder.respond(preview_response(
            StatusCode::FORBIDDEN,
            "text/plain; charset=utf-8",
            b"preview grant missing".to_vec(),
        ));
        return;
    };

    tauri::async_runtime::spawn(async move {
        let read = tokio::task::spawn_blocking(move || read_jailed(&dir, &rel)).await;
        match read {
            Ok(Ok((content_type, body))) => {
                responder.respond(preview_response(StatusCode::OK, content_type, body));
            }
            Ok(Err(status)) => {
                responder.respond(preview_response(
                    status,
                    "text/plain; charset=utf-8",
                    b"preview unavailable".to_vec(),
                ));
            }
            Err(_) => {
                responder.respond(preview_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "text/plain; charset=utf-8",
                    b"preview unavailable".to_vec(),
                ));
            }
        }
    });
}

fn preview_response(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_SECURITY_POLICY, PREVIEW_CSP)
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .expect("valid html preview response")
}

/// `/t/<token>/<relative path>` on either platform host.
fn parse_preview_path(uri: &tauri::http::Uri) -> Option<(String, String)> {
    match uri.host() {
        Some("localhost" | "agentero-html.localhost") => {}
        _ => return None,
    }
    let path = uri.path().strip_prefix("/t/")?;
    let (token, rel) = path.split_once('/')?;
    let token = percent_decode(token)?;
    if token.len() < 16 || token.len() > 64 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let rel = decode_rel(rel)?;
    Some((token, rel))
}

fn decode_rel(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.ends_with('/') {
        return None;
    }
    let mut parts = Vec::new();
    for seg in raw.split('/') {
        if seg.is_empty() {
            return None;
        }
        let decoded = percent_decode(seg)?;
        if decoded.is_empty()
            || decoded == "."
            || decoded == ".."
            || decoded.contains('/')
            || decoded.contains('\\')
            || decoded.contains('\0')
        {
            return None;
        }
        parts.push(decoded);
    }
    Some(parts.join("/"))
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = from_hex(bytes[i + 1])?;
            let lo = from_hex(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn read_jailed(dir: &Path, rel: &str) -> Result<(&'static str, Vec<u8>), StatusCode> {
    let mut path = dir.to_path_buf();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(StatusCode::BAD_REQUEST);
        }
        path.push(seg);
    }
    let canon = std::fs::canonicalize(&path).map_err(|_| StatusCode::NOT_FOUND)?;
    if !canon.starts_with(dir) || !canon.is_file() {
        return Err(StatusCode::FORBIDDEN);
    }
    let len = std::fs::metadata(&canon)
        .map_err(|_| StatusCode::NOT_FOUND)?
        .len();
    if len > MAX_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let bytes = std::fs::read(&canon).map_err(|_| StatusCode::NOT_FOUND)?;
    let name = canon.file_name().and_then(|n| n.to_str()).unwrap_or(rel);
    Ok((content_type_for(name), bytes))
}

fn content_type_for(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "json" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri(value: &str) -> tauri::http::Uri {
        value.parse().expect("test uri parses")
    }

    #[test]
    fn csp_allows_inline_scripts_and_blocks_network_reads() {
        assert!(PREVIEW_CSP.contains("script-src 'unsafe-inline'"));
        assert!(PREVIEW_CSP.contains("connect-src 'none'"));
        assert!(!PREVIEW_CSP.contains("script-src 'unsafe-inline' https:"));
        assert!(!PREVIEW_CSP.contains("allow-same-origin"));
    }

    #[test]
    fn parses_both_platform_url_shapes() {
        let (token, rel) = parse_preview_path(&uri(
            "agentero-html://localhost/t/0123456789abcdef0123456789abcdef/logic.html?v=3",
        ))
        .expect("unix");
        assert_eq!(token, "0123456789abcdef0123456789abcdef");
        assert_eq!(rel, "logic.html");

        let (_, rel) = parse_preview_path(&uri(
            "http://agentero-html.localhost/t/0123456789abcdef0123456789abcdef/assets/fig.svg",
        ))
        .expect("windows");
        assert_eq!(rel, "assets/fig.svg");
    }

    #[test]
    fn rejects_traversal_and_foreign_hosts() {
        assert!(parse_preview_path(&uri(
            "agentero-html://localhost/t/0123456789abcdef0123456789abcdef/../secret.html"
        ))
        .is_none());
        assert!(parse_preview_path(&uri(
            "agentero-html://localhost/t/0123456789abcdef0123456789abcdef/%2E%2E/secret.html"
        ))
        .is_none());
        assert!(parse_preview_path(&uri(
            "agentero-html://evil.example/t/0123456789abcdef0123456789abcdef/logic.html"
        ))
        .is_none());
        assert!(parse_preview_path(&uri("agentero-html://localhost/logic.html")).is_none());
    }

    #[test]
    fn decodes_a_spaced_file_name() {
        let (_, rel) = parse_preview_path(&uri(
            "agentero-html://localhost/t/0123456789abcdef0123456789abcdef/my%20logic.html",
        ))
        .expect("spaced");
        assert_eq!(rel, "my logic.html");
    }

    #[test]
    fn jail_keeps_siblings_and_rejects_escape() {
        let root = std::env::temp_dir().join(format!(
            "agentero-html-preview-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let dir = root.join("notes");
        let outside = root.join("outside.txt");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("logic.html"), b"<p>ok</p>").unwrap();
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("assets").join("fig.svg"), b"<svg/>").unwrap();
        std::fs::write(&outside, b"nope").unwrap();
        let canon_dir = std::fs::canonicalize(&dir).unwrap();

        let (kind, body) = read_jailed(&canon_dir, "assets/fig.svg").expect("sibling");
        assert_eq!(kind, "image/svg+xml");
        assert_eq!(body, b"<svg/>");

        assert_eq!(
            read_jailed(&canon_dir, "../outside.txt").unwrap_err(),
            StatusCode::BAD_REQUEST
        );

        #[cfg(unix)]
        {
            let link = dir.join("leak.txt");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert_eq!(
                read_jailed(&canon_dir, "leak.txt").unwrap_err(),
                StatusCode::FORBIDDEN
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prepare_requires_a_held_vault_and_an_html_file() {
        let root = std::env::temp_dir().join(format!(
            "agentero-html-grant-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let notes = root.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        let html = notes.join("logic.html");
        std::fs::write(&html, b"<p>ok</p>").unwrap();
        std::fs::write(notes.join("notes.md"), b"# n").unwrap();
        let vault = std::fs::canonicalize(&root).unwrap();
        let roots = vec![vault.to_string_lossy().to_string()];

        let prepared = prepare(&roots, html.to_str().unwrap()).expect("grant");
        assert_eq!(prepared.name, "logic.html");
        assert!(prepared.dir.starts_with(&vault));

        assert!(prepare(&roots, notes.join("notes.md").to_str().unwrap()).is_err());
        assert!(prepare(&["/agentero-no-such-vault".into()], html.to_str().unwrap()).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }
}
