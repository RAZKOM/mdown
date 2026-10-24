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
use std::time::{Duration, Instant};

use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};
use tao::window::{Window, WindowBuilder, WindowId};
use wry::{WebContext, WebView, WebViewBuilder};

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

fn main() {
    #[cfg(feature = "debug-hooks")]
    let _ = START.set(Instant::now());
    // LaunchServices may append `-psn_...`; real paths never start with a dash.
    let files: Vec<PathBuf> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter_map(|a| std::fs::canonicalize(a).ok())
        .map(strip_verbatim)
        .collect();
    run(files);
}

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

fn open_viewer(
    target: &EventLoopWindowTarget<Ev>,
    proxy: &EventLoopProxy<Ev>,
    context: &mut WebContext,
    file: PathBuf,
) -> Option<Viewer> {
    let base = file.parent()?.to_path_buf();
    let name = file.file_name()?.to_string_lossy().into_owned();
    let (w, h) = config::load_size();
    let prefs = settings::load();
    let window = WindowBuilder::new()
        .with_title(&name)
        .with_inner_size(LogicalSize::new(w, h))
        .with_theme(window_theme(&prefs.theme))
        .with_window_icon(window_icon())
        .build(target)
        .map_err(|e| eprintln!("mdown: window: {e}"))
        .ok()?;
    let id = window.id();
    #[cfg(feature = "debug-hooks")]
    mark("window created");

    let doc = file.clone();
    let doc_base = base.clone();
    let ipc = Ipc { id, file: file.clone(), base, proxy: proxy.clone() };
    let builder = WebViewBuilder::new_with_web_context(context);
    #[cfg(feature = "debug-hooks")]
    let builder = builder.with_initialization_script(TIMING_SCRIPT);
    let webview = builder
        .with_custom_protocol("mdown".into(), move |_, req| assets::respond(&doc, &doc_base, req))
        .with_ipc_handler(move |req| handle_ipc(&ipc, req.body()))
        // The page owns Ctrl/Cmd +, -, 0 and Ctrl+wheel so the level is a saved setting.
        .with_background_color(page_background(&prefs.theme, &window))
        .with_hotkeys_zoom(false)
        // The menu's Paste reads the clipboard; this stops WebView2 asking permission for it.
        .with_clipboard(true)
        .with_url(format!("{ORIGIN}/index.html"))
        .build(&window)
        .map_err(|e| eprintln!("mdown: webview: {e}"))
        .ok()?;
    #[cfg(feature = "debug-hooks")]
    mark("webview created");
    if prefs.zoom != 1.0 {
        let _ = webview.zoom(prefs.zoom);
    }

    let watch_proxy = proxy.clone();
    let _watcher = watch::watch(&file, move || {
        let _ = watch_proxy.send_event(Ev::Reload(id));
    });
    Some(Viewer { window, webview, name, dirty: false, _watcher })
}

fn run(files: Vec<PathBuf>) {
    let event_loop: EventLoop<Ev> = EventLoopBuilder::with_user_event().build();
    let proxy = event_loop.create_proxy();
    // Keep the webview profile out of the install directory (~/.cargo/bin for `cargo install`).
    let mut context = WebContext::new(config::webview_dir());

    #[cfg(target_os = "macos")]
    let _menu = menu::install(proxy.clone());

    let mut viewers: HashMap<WindowId, Viewer> = HashMap::new();
    for file in files {
        if let Some(v) = open_viewer(&event_loop, &proxy, &mut context, file) {
            viewers.insert(v.window.id(), v);
        }
    }
    #[cfg(target_os = "macos")]
    let mut focused: Option<WindowId> = None; // target of Cmd+W

    // macOS launches the app with no arguments and delivers the double-clicked file as an
    // "open document" event just after startup, so an empty app waits briefly for one.
    let mut grace = (viewers.is_empty() && cfg!(target_os = "macos")).then(|| Instant::now() + Duration::from_secs(2));

    // Dev aid, only in builds with `--features debug-hooks`: MDOWN_DEBUG_JS="<expr>[@@<expr>...]"
    // runs each expression in the page (the first after 6 s, then one every 3 s) and prints its
    // value to stderr. Platform webviews can't be attached to over SSH, so this is how a headless
    // Mac gets inspected and driven.
    #[cfg(feature = "debug-hooks")]
    if let Ok(exprs) = std::env::var("MDOWN_DEBUG_JS") {
        let debug_proxy = proxy.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            for expr in exprs.split("@@") {
                std::thread::sleep(Duration::from_secs(3));
                let _ = debug_proxy.send_event(Ev::Debug(expr.to_string()));
            }
        });
    }

    event_loop.run(move |event, target, flow| {
        match event {
            Event::UserEvent(Ev::Reload(id)) => eval(&viewers, id, "window.__reload && window.__reload()"),
            Event::UserEvent(Ev::Eval(id, js)) => eval(&viewers, id, &js),
            Event::UserEvent(Ev::Settings(origin, key)) => {
                let prefs = settings::load();
                let json = serde_json::json!({ "theme": prefs.theme, "width": prefs.width, "zoom": prefs.zoom });
                for (id, v) in &viewers {
                    v.window.set_theme(window_theme(&prefs.theme));
                    let _ = v.webview.set_background_color(page_background(&prefs.theme, &v.window));
                    let _ = v.webview.zoom(prefs.zoom);
                    // The page restyles itself; only the window that asked announces the change.
                    let changed = if *id == origin { serde_json::Value::from(key.as_str()) } else { serde_json::Value::Null };
                    let _ = v.webview.evaluate_script(&format!("window.__applySettings && window.__applySettings({json}, {changed})"));
                }
            }
            Event::UserEvent(Ev::Open(path)) => open_path(target, &proxy, &mut context, &mut viewers, path),
            Event::UserEvent(Ev::Dirty(id, dirty)) => {
                if let Some(v) = viewers.get_mut(&id) {
                    v.dirty = dirty;
                    v.window.set_title(&if dirty { format!("● {}", v.name) } else { v.name.clone() });
                }
            }
            Event::UserEvent(Ev::Print(id)) => {
                if let Some(v) = viewers.get(&id) {
                    let _ = v.webview.print();
                }
            }
            Event::UserEvent(Ev::Close(id)) => close_viewer(&mut viewers, id),
            #[cfg(feature = "debug-hooks")]
            Event::UserEvent(Ev::Debug(expr)) => {
                for v in viewers.values() {
                    let _ = v.webview.evaluate_script_with_callback(&expr, |r| eprintln!("debug: {r}"));
                }
            }
            #[cfg(target_os = "macos")]
            Event::UserEvent(Ev::Menu(action)) => match action {
                menu::Action::CloseWindow => {
                    if let Some(id) = focused.filter(|id| viewers.contains_key(id)) {
                        request_close(&viewers, &proxy, id);
                    }
                }
                menu::Action::QuitAll => {
                    // Windows with unsaved edits ask first; the rest simply close.
                    let ids: Vec<_> = viewers.keys().copied().collect();
                    for id in ids {
                        request_close(&viewers, &proxy, id);
                    }
                }
            },
            #[cfg(target_os = "macos")]
            Event::Opened { urls } => {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        open_path(target, &proxy, &mut context, &mut viewers, path);
                    }
                }
            }
            Event::WindowEvent { window_id, event: WindowEvent::CloseRequested, .. } => {
                request_close(&viewers, &proxy, window_id);
            }
            #[cfg(target_os = "macos")]
            Event::WindowEvent { window_id, event: WindowEvent::Focused(true), .. } => focused = Some(window_id),
            _ => {}
        }

        if !viewers.is_empty() {
            grace = None;
            *flow = ControlFlow::Wait;
        } else {
            match grace {
                Some(deadline) if Instant::now() < deadline => *flow = ControlFlow::WaitUntil(deadline),
                _ => *flow = ControlFlow::Exit,
            }
        }
    });
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

fn close_viewer(viewers: &mut HashMap<WindowId, Viewer>, id: WindowId) {
    if let Some(v) = viewers.remove(&id) {
        // A maximized window's size is the screen's, not a size worth restoring.
        if !v.window.is_maximized() {
            let s = v.window.inner_size().to_logical::<f64>(v.window.scale_factor());
            config::save_size(s.width, s.height);
        }
    }
}

fn open_path(
    target: &EventLoopWindowTarget<Ev>,
    proxy: &EventLoopProxy<Ev>,
    context: &mut WebContext,
    viewers: &mut HashMap<WindowId, Viewer>,
    path: PathBuf,
) {
    let Ok(file) = std::fs::canonicalize(path) else { return };
    if let Some(v) = open_viewer(target, proxy, context, strip_verbatim(file)) {
        viewers.insert(v.window.id(), v);
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

fn handle_ipc(ipc: &Ipc, body: &str) {
    let Ok(msg) = serde_json::from_str::<Msg>(body) else { return };
    let send = |ev| {
        let _ = ipc.proxy.send_event(ev);
    };
    match msg.t.as_str() {
        "link" => {
            if let Some(href) = msg.href {
                open_link(&ipc.base, &ipc.proxy, &href);
            }
        }
        "save" => {
            let Some(text) = msg.text else { return };
            let js = match std::fs::write(&ipc.file, text) {
                Ok(()) => "window.__saved && window.__saved()".to_string(),
                Err(e) => {
                    let reason = serde_json::to_string(&e.to_string()).unwrap_or_else(|_| "\"error\"".into());
                    format!("window.__saveFailed && window.__saveFailed({reason})")
                }
            };
            send(Ev::Eval(ipc.id, js));
        }
        "dirty" => send(Ev::Dirty(ipc.id, msg.v.unwrap_or(false))),
        "print" => send(Ev::Print(ipc.id)),
        "close" => send(Ev::Close(ipc.id)),
        "setting" => {
            let (Some(key), Some(value)) = (msg.key, msg.value) else { return };
            match settings::set(&key, &value) {
                Ok(()) => send(Ev::Settings(ipc.id, key)),
                Err(e) => eprintln!("mdown: setting {key}: {e}"),
            }
        }
        "reveal" => reveal(&ipc.file),
        #[cfg(feature = "debug-hooks")]
        "timing" => mark(&msg.text.unwrap_or_default()),
        _ => {}
    }
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
