use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};

use percent_encoding::percent_decode_str;
use wry::http::{Request, Response, StatusCode, header::CONTENT_TYPE};

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/embedded.rs"));
}

type Resp = Response<Cow<'static, [u8]>>;

/// The placeholder attributes frontend/build.mjs writes on <html>; replaced with the saved settings.
const HTML_STAMP: &str = "data-theme=\"system\" data-width=\"normal\" data-zoom=\"1\"";
fn reply(status: StatusCode, mime: &str, body: impl Into<Cow<'static, [u8]>>) -> Resp {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, mime)
        .header("Cache-Control", "no-store")
        .body(body.into())
        .unwrap()
}

/// Serves the embedded app, the current document at `/doc`, and the document's images and
/// models: `/a/<path>` relative to `base` (the document's folder), and `/up/<n>/<path>` for paths
/// that start with `n` `../` segments, which can't stay in a URL because the browser folds them
/// away. Either way the file has to be inside `root` (see `asset_root`).
pub fn respond(doc: &Path, base: &Path, root: &Path, req: Request<Vec<u8>>) -> Resp {
    let path = req.uri().path();
    let path = if path == "/" { "/index.html" } else { path };
    if let Some((_, bytes)) = embedded::FILES.iter().find(|(p, _)| *p == path) {
        if path == "/index.html" {
            // Stamp the saved settings on <html> so the first paint already has the right colours and width.
            let s = crate::settings::load();
            let stamp = format!("data-theme=\"{}\" data-width=\"{}\" data-zoom=\"{}\"", s.theme, s.width, s.zoom);
            let html = String::from_utf8_lossy(bytes).replacen(HTML_STAMP, &stamp, 1);
            return reply(StatusCode::OK, "text/html; charset=utf-8", html.into_bytes());
        }
        let guess = mime_guess::from_path(path).first_or_octet_stream();
        let mime = match guess.essence_str() {
            "application/javascript" => "text/javascript",
            m => m,
        };
        return reply(StatusCode::OK, mime, *bytes);
    }
    match path {
        "/doc" => match std::fs::read(doc) {
            Ok(b) => reply(StatusCode::OK, "text/plain; charset=utf-8", b),
            Err(_) => reply(StatusCode::NOT_FOUND, "text/plain", &b"missing"[..]),
        },
        "/meta" => {
            let meta = serde_json::json!({ "path": doc.display().to_string() });
            reply(StatusCode::OK, "application/json", meta.to_string().into_bytes())
        }
        _ => {
            let rel = if let Some(rel) = path.strip_prefix("/a/") {
                Some(rel.to_string())
            } else {
                path.strip_prefix("/up/")
                    .and_then(|p| p.split_once('/'))
                    .and_then(|(n, rest)| Some((n.parse::<usize>().ok().filter(|n| *n <= 64)?, rest)))
                    .map(|(n, rest)| "../".repeat(n) + rest)
            };
            match rel {
                Some(rel) => serve_asset(root, base, &rel),
                None => reply(StatusCode::NOT_FOUND, "text/plain", &b"not found"[..]),
            }
        }
    }
}

fn serve_asset(root: &Path, base: &Path, rel: &str) -> Resp {
    let file = match resolve(root, base, rel) {
        Ok(f) => f,
        Err(status) => return reply(status, "text/plain", status.canonical_reason().unwrap_or("error").as_bytes().to_vec()),
    };
    match std::fs::read(&file) {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&file).first_or_octet_stream();
            reply(StatusCode::OK, mime.essence_str(), bytes)
        }
        Err(_) => reply(StatusCode::NOT_FOUND, "text/plain", &b"Not Found"[..]),
    }
}

/// The folder a document's images and models may come from: the git repository it lives in,
/// so `![](../images/x.png)` works from a `docs/` folder, or just the document's own folder when
/// it isn't in one. A repository at the home folder itself (a dotfiles repo) doesn't count, as
/// that would open up the whole home folder.
pub fn asset_root(base: &Path) -> PathBuf {
    let canonical = |p: &Path| std::fs::canonicalize(p).ok();
    let home = dirs::home_dir().and_then(|h| canonical(&h));
    base.ancestors()
        .find(|dir| dir.join(".git").exists())
        .filter(|repo| canonical(repo) != home)
        .unwrap_or(base)
        .to_path_buf()
}

/// Maps a (possibly percent-encoded) path, relative to `base`, onto a file inside `root`.
/// Absolute paths, anything that lands outside `root` (through `..` or a symlink) and anything
/// inside a `.git` folder are `FORBIDDEN`; a path that doesn't exist is `NOT_FOUND`.
pub fn resolve(root: &Path, base: &Path, rel: &str) -> Result<PathBuf, StatusCode> {
    let decoded = percent_decode_str(rel).decode_utf8().map_err(|_| StatusCode::BAD_REQUEST)?;
    let rel = Path::new(decoded.as_ref());
    if rel.components().any(|c| matches!(c, Component::RootDir | Component::Prefix(_))) {
        return Err(StatusCode::FORBIDDEN);
    }
    let root = std::fs::canonicalize(root).map_err(|_| StatusCode::NOT_FOUND)?;
    let full = std::fs::canonicalize(base.join(rel)).map_err(|_| StatusCode::NOT_FOUND)?;
    match full.strip_prefix(&root) {
        Ok(inside) if !inside.components().any(|c| c.as_os_str().eq_ignore_ascii_case(".git")) => Ok(full),
        _ => Err(StatusCode::FORBIDDEN),
    }
}

/// Where a relative link in the document points. Unlike images, a link only opens something
/// when the reader clicks it, so it may go anywhere relative to `base`, `..` included; only
/// absolute paths are ignored, as they rarely mean the same thing on another computer.
pub fn resolve_link(base: &Path, rel: &str) -> Option<PathBuf> {
    let decoded = percent_decode_str(rel).decode_utf8().ok()?;
    let rel = Path::new(decoded.as_ref());
    if rel.as_os_str().is_empty() || rel.components().any(|c| matches!(c, Component::RootDir | Component::Prefix(_))) {
        return None;
    }
    std::fs::canonicalize(base.join(rel)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confines_to_root() {
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap().join("mdown-resolve-test");
        let _ = std::fs::remove_dir_all(&dir);
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("a b.png"), b"x").unwrap();
        std::fs::write(dir.join("secret.txt"), b"x").unwrap();

        // Not in a repository: the root is the document's own folder.
        assert!(resolve(&sub, &sub, "a%20b.png").is_ok());
        assert_eq!(resolve(&sub, &sub, "nope.png"), Err(StatusCode::NOT_FOUND));
        let forbidden = Err(StatusCode::FORBIDDEN);
        assert_eq!(resolve(&sub, &sub, "../secret.txt"), forbidden);
        assert_eq!(resolve(&sub, &sub, "%2e%2e/secret.txt"), forbidden);
        assert_eq!(resolve(&sub, &sub, "..%2fsecret.txt"), forbidden);
        assert_eq!(resolve(&sub, &sub, "../sub/a%20b.png"), Ok(sub.join("a b.png")));
        assert_eq!(resolve(&dir, &sub, dir.join("secret.txt").to_str().unwrap()), forbidden);
        // A drive-qualified path is only absolute on Windows; elsewhere it's a plain missing file.
        #[cfg(windows)]
        assert_eq!(resolve(&sub, &sub, "C:/Windows/win.ini"), forbidden);
        #[cfg(not(windows))]
        assert_eq!(resolve(&sub, &sub, "C:/Windows/win.ini"), Err(StatusCode::NOT_FOUND));

        // A wider root lets `..` reach the rest of it, but nothing above it and nothing in .git.
        assert_eq!(resolve(&dir, &sub, "../secret.txt"), Ok(dir.join("secret.txt")));
        assert_eq!(resolve(&dir, &sub, "../../secret.txt"), Err(StatusCode::NOT_FOUND));
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git").join("config"), b"x").unwrap();
        assert_eq!(resolve(&dir, &sub, "../.git/config"), forbidden);
        assert_eq!(resolve(&dir, &sub, "../../mdown-resolve-test/secret.txt"), Ok(dir.join("secret.txt")));
    }

    #[test]
    fn asset_root_is_the_enclosing_repository() {
        let repo = std::fs::canonicalize(std::env::temp_dir()).unwrap().join("mdown-root-test");
        let _ = std::fs::remove_dir_all(&repo);
        let docs = repo.join("docs").join("guide");
        std::fs::create_dir_all(&docs).unwrap();
        assert_eq!(asset_root(&docs), docs);
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        assert_eq!(asset_root(&docs), repo);
        assert_eq!(asset_root(&repo), repo);
    }

    #[test]
    fn links_may_leave_the_folder() {
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap().join("mdown-link-test");
        let _ = std::fs::remove_dir_all(&dir);
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("README.md"), b"x").unwrap();
        assert_eq!(resolve_link(&sub, "../README.md"), Some(dir.join("README.md")));
        assert_eq!(resolve_link(&sub, "..%2FREADME.md"), Some(dir.join("README.md")));
        assert_eq!(resolve_link(&sub, "missing.md"), None);
        assert_eq!(resolve_link(&sub, dir.join("README.md").to_str().unwrap()), None);
        assert_eq!(resolve_link(&sub, ""), None);
    }
}
