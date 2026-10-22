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

/// Serves the embedded app, the current document at `/doc`, and files under `/a/` from `base`.
pub fn respond(doc: &Path, base: &Path, req: Request<Vec<u8>>) -> Resp {
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
        _ => match path.strip_prefix("/a/") {
            Some(rel) => serve_asset(base, rel),
            None => reply(StatusCode::NOT_FOUND, "text/plain", &b"not found"[..]),
        },
    }
}

fn serve_asset(base: &Path, rel: &str) -> Resp {
    let file = match resolve(base, rel) {
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

/// Maps a (possibly percent-encoded) relative path onto `base`. Anything that would land
/// outside it (absolute paths, `..` segments, symlinks pointing elsewhere) is `FORBIDDEN`;
/// a path inside `base` that doesn't exist is `NOT_FOUND`.
pub fn resolve(base: &Path, rel: &str) -> Result<PathBuf, StatusCode> {
    let decoded = percent_decode_str(rel).decode_utf8().map_err(|_| StatusCode::BAD_REQUEST)?;
    let rel = Path::new(decoded.as_ref());
    if rel.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(StatusCode::FORBIDDEN);
    }
    let root = std::fs::canonicalize(base).map_err(|_| StatusCode::NOT_FOUND)?;
    let full = std::fs::canonicalize(root.join(rel)).map_err(|_| StatusCode::NOT_FOUND)?;
    if full.starts_with(&root) { Ok(full) } else { Err(StatusCode::FORBIDDEN) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confines_to_base() {
        let dir = std::env::temp_dir().join("mdown-resolve-test");
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("a b.png"), b"x").unwrap();
        std::fs::write(dir.join("secret.txt"), b"x").unwrap();

        assert!(resolve(&sub, "a%20b.png").is_ok());
        assert_eq!(resolve(&sub, "nope.png"), Err(StatusCode::NOT_FOUND));
        let forbidden = Err(StatusCode::FORBIDDEN);
        assert_eq!(resolve(&sub, "../secret.txt"), forbidden);
        assert_eq!(resolve(&sub, "%2e%2e/secret.txt"), forbidden);
        assert_eq!(resolve(&sub, "..%2fsecret.txt"), forbidden);
        assert_eq!(resolve(&sub, dir.join("secret.txt").to_str().unwrap()), forbidden);
        // A drive-qualified path is only absolute on Windows; elsewhere it's a plain missing file.
        #[cfg(windows)]
        assert_eq!(resolve(&sub, "C:/Windows/win.ini"), forbidden);
        #[cfg(not(windows))]
        assert_eq!(resolve(&sub, "C:/Windows/win.ini"), Err(StatusCode::NOT_FOUND));
    }
}
