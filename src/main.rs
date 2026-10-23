// The real viewer. `mdown` (src/launcher) is a thin console front-end that starts this;
// file associations point here directly so a double-click never flashes a console window.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod assets;
mod config;
#[cfg(target_os = "macos")]
mod menu;
mod settings;
mod watch;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use tao::event_loop::EventLoopProxy;
use tao::window::{Window, WindowId};
use wry::WebView;

#[cfg(windows)]
const ORIGIN: &str = "http://mdown.localhost";
#[cfg(not(windows))]
const ORIGIN: &str = "mdown://localhost";

/// Messages sent to the event loop from other threads and webview callbacks.
enum Ev {
    Reload(WindowId),
    Open(PathBuf),
    /// Run a script in a window's page.
    Eval(WindowId, String),
    /// A window changed a setting (already saved); bring every window in line with the file.
    /// The window that made the change also confirms it with a toast.
    Settings(WindowId, String),
    /// The page's unsaved-changes state changed.
    Dirty(WindowId, bool),
    Print(WindowId),
    /// Close now, no questions (the page already asked, or couldn't).
    Close(WindowId),
    #[cfg(feature = "debug-hooks")]
    Debug(String),
    #[cfg(target_os = "macos")]
    Menu(menu::Action),
}

/// One open document. Dropping it closes the window and stops its file watch.
struct Viewer {
    window: Window,
    webview: WebView,
    name: String,
    dirty: bool,
    _watcher: Option<notify::RecommendedWatcher>,
}

/// Startup timing, only in `debug-hooks` builds: prints "timing: <what> +<ms>" to stderr.
#[cfg(feature = "debug-hooks")]
static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

#[cfg(feature = "debug-hooks")]
fn mark(what: &str) {
    if let Some(start) = START.get() {
        eprintln!("timing: {what} +{} ms", start.elapsed().as_millis());
    }
}

/// Reports when the page reaches DOM-ready, first paint, and the first painted content.
#[cfg(feature = "debug-hooks")]
const TIMING_SCRIPT: &str = r##"(() => {
  const t = (text) => window.ipc.postMessage(JSON.stringify({ t: "timing", text }));
  document.addEventListener("DOMContentLoaded", () => t("page: dom ready"));
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.name === "first-contentful-paint") t("page: first paint");
  }).observe({ type: "paint", buffered: true });
  const watch = new MutationObserver(() => {
    if (!document.querySelector("#content h1, #content p")) return;
    watch.disconnect();
    requestAnimationFrame(() => requestAnimationFrame(() => t("page: content painted")));
  });
  watch.observe(document, { childList: true, subtree: true });
})();"##;

/// Windows canonicalize yields `\\?\C:\...`, which looks ugly and trips up child processes.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    match p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

/// The title bar and window chrome follow the chosen theme; `None` means follow the OS.
fn window_theme(mode: &str) -> Option<tao::window::Theme> {
    match mode {
        "light" => Some(tao::window::Theme::Light),
        "dark" => Some(tao::window::Theme::Dark),
        _ => None,
    }
}

/// The page's own background colour, so a new window is already the right shade (not white in
/// the dark theme) while the page loads. Matches `--bg` in frontend/src/style.css.
fn page_background(mode: &str, window: &Window) -> (u8, u8, u8, u8) {
    let dark = match mode {
        "dark" => true,
        "light" => false,
        _ => window.theme() == tao::window::Theme::Dark,
    };
    if dark { (13, 17, 23, 255) } else { (255, 255, 255, 255) }
}

/// The title-bar and taskbar icon (macOS takes its icon from the app bundle instead).
fn window_icon() -> Option<tao::window::Icon> {
    tao::window::Icon::from_rgba(include_bytes!("../assets/icon-64.rgba").to_vec(), 64, 64).ok()
}

/// What the page's IPC handler needs to act for its own window.
struct Ipc {
    id: WindowId,
    file: PathBuf,
    base: PathBuf,
    proxy: EventLoopProxy<Ev>,
}

fn eval(viewers: &HashMap<WindowId, Viewer>, id: WindowId, js: &str) {
    if let Some(v) = viewers.get(&id) {
        let _ = v.webview.evaluate_script(js);
    }
}

/// Clean windows close at once; one with unsaved edits asks the page to show its
/// save/discard/cancel dialog. If the page can't (still loading, crashed), close anyway
/// rather than leave a window nobody can dismiss.
fn request_close(viewers: &HashMap<WindowId, Viewer>, proxy: &EventLoopProxy<Ev>, id: WindowId) {
    let Some(v) = viewers.get(&id) else { return };
    if !v.dirty {
        let _ = proxy.send_event(Ev::Close(id));
        return;
    }
    let fallback = proxy.clone();
    let asked = v.webview.evaluate_script_with_callback(
        "window.__askClose ? (window.__askClose(), true) : false",
        move |answer| {
            if answer != "true" {
                let _ = fallback.send_event(Ev::Close(id));
            }
        },
    );
    if asked.is_err() {
        let _ = proxy.send_event(Ev::Close(id));
    }
}

#[derive(serde::Deserialize)]
struct Msg {
    t: String,
    href: Option<String>,
    text: Option<String>,
    v: Option<bool>,
    key: Option<String>,
    value: Option<serde_json::Value>,
}

/// Shows the file selected in the system file manager.
fn reveal(file: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // explorer wants `/select,"path"` as one argument, quotes included.
        let _ = std::process::Command::new("explorer").raw_arg(format!("/select,\"{}\"", file.display())).spawn();
    }
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg("-R").arg(file).spawn();
    #[cfg(not(any(windows, target_os = "macos")))]
    if let Some(dir) = file.parent() {
        let _ = open::that(dir);
    }
}

fn open_link(base: &Path, proxy: &EventLoopProxy<Ev>, href: &str) {
    if href.starts_with("http://") || href.starts_with("https://") || href.starts_with("mailto:") {
        let _ = open::that(href);
        return;
    }
    // Relative link: a markdown file opens in its own window, anything else is left alone.
    let rel = href.split('#').next().unwrap_or("");
    if let Ok(target) = assets::resolve(base, rel) {
        let md = target
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"));
        if md {
            let _ = proxy.send_event(Ev::Open(target));
        }
    }
}

fn main() {
    println!("Hello, world!");
}
