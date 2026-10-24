// Console front-end behind the `mdown` command. It stays tiny: it parses the
// command line, runs the setup menu, and hands files to the GUI binary (`mdown-app`),
// which is built without a console so file associations never flash a terminal window.

use std::io::{IsTerminal, Write};
use std::path::PathBuf;

#[path = "../settings.rs"]
mod settings;

#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod platform;
#[cfg(not(any(windows, target_os = "macos")))]
#[path = "other.rs"]
mod platform;

/// What `install` should set up. They are independent: a user can want the right-click entry
/// without mdown taking over double-click, or the reverse.
#[derive(Clone, Copy)]
pub struct Setup {
    pub context_menu: bool,
    pub default: bool,
}

const APP: &str = if cfg!(windows) { "mdown-app.exe" } else { "mdown-app" };

fn usage() {
    println!(
        "mdown {}: a small window for Markdown files\n\n\
         usage:\n  \
         mdown <file.md>...      open each file in its own window\n  \
         mdown install [options] set up right-click menu and/or default app\n  \
         mdown uninstall         remove what install set up\n  \
         mdown theme [mode]      show or set the theme: system, light or dark\n\n\
         install options:\n  \
         --context-menu   add \"Open with mdown\" for .md files\n  \
         --default        make mdown the default app for .md files\n  \
         --all            both of the above\n  \
         --yes            don't ask; with no other option, same as --context-menu\n  \
         --no-open        don't open the system's default-apps settings",
        env!("CARGO_PKG_VERSION")
    );
}

fn fail(msg: &str) -> ! {
    eprintln!("mdown: {msg}");
    std::process::exit(1);
}

// ---- setup menu -------------------------------------------------------------------------

fn marker() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("mdown").join("setup-asked"))
}

fn theme(args: &[String]) {
    match args.first() {
        None => {
            let file = settings::file().map(|f| f.display().to_string()).unwrap_or_default();
            println!("{}   (settings file: {file})", settings::theme());
        }
        Some(mode) => match settings::set_theme(mode) {
            Ok(()) => println!("Theme set to {mode}. New windows use it; in an open window use the right-click menu or Ctrl/Cmd+Shift+L."),
            Err(e) => fail(&e),
        },
    }
}

/// The GUI binary, which registrations must point at.
fn app_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let app = exe.with_file_name(APP);
    let full = std::fs::canonicalize(&app).map_err(|_| format!("{} not found next to the mdown command", app.display()))?;
    // Windows canonicalize yields `\\?\C:\...`, which shell commands in the registry shouldn't contain.
    Ok(match full.to_str().and_then(|p| p.strip_prefix(r"\\?\")) {
        Some(plain) => PathBuf::from(plain),
        None => full,
    })
}
