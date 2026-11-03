// Console front-end behind the `mdown` command. It stays tiny: it parses the
// command line, runs the setup menu, and hands files to the GUI binary (`mdown-app`),
// which is built without a console so file associations never flash a terminal window.

use std::io::{BufRead, IsTerminal, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[path = "../fsutil.rs"]
mod fsutil;
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

pub fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("install") => install(&args[1..]),
        Some("uninstall") => uninstall(),
        Some("theme") => theme(&args[1..]),
        Some("-h" | "--help" | "help") => usage(),
        Some("-V" | "--version" | "version") => println!("mdown {}", env!("CARGO_PKG_VERSION")),
        None => {
            first_run_prompt();
            usage();
            std::process::exit(2);
        }
        Some(_) => view(&args),
    }
}

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

fn view(files: &[String]) {
    let mut missing = false;
    for f in files {
        if !std::path::Path::new(f).is_file() {
            eprintln!("mdown: no such file: {f}");
            missing = true;
        }
    }
    if missing {
        std::process::exit(1);
    }
    first_run_prompt();

    let app = match std::env::current_exe() {
        Ok(exe) => exe.with_file_name(APP),
        Err(e) => fail(&format!("cannot locate itself: {e}")),
    };
    if !app.exists() {
        fail(&format!("{} is missing next to this command; reinstall with `cargo install mdown`", app.display()));
    }
    let mut cmd = Command::new(app);
    cmd.args(files).stdin(Stdio::null()).stdout(Stdio::null());
    // Builds with the `debug-hooks` feature keep stderr reachable (see MDOWN_DEBUG_JS in the app).
    if !cfg!(feature = "debug-hooks") {
        cmd.stderr(Stdio::null());
    }
    if let Err(e) = cmd.spawn() {
        fail(&format!("could not start the viewer: {e}"));
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("mdown: {msg}");
    std::process::exit(1);
}

// ---- setup menu -------------------------------------------------------------------------

fn marker() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("mdown").join("setup-asked"))
}

/// `cargo install` can't ask anything, so the first interactive run offers setup once.
/// Never fires for double-clicks (no terminal) or once the user has answered or installed.
fn first_run_prompt() {
    let interactive = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    let asked = marker().is_none_or(|m| m.exists());
    if !interactive || asked || platform::is_installed() {
        return;
    }
    if let Some(m) = marker() {
        if let Some(dir) = m.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(m, "");
    }
    println!("Welcome to mdown. Want to open .md files with it from the file manager?");
    if let Some(setup) = ask_setup(&mut std::io::stdin().lock(), None) {
        run_install(setup, true);
    } else {
        println!("No problem. Run `mdown install` whenever you like.\n");
    }
}

/// Returns `None` for "not now". `enter` is what a bare Enter selects.
fn ask_setup(input: &mut impl BufRead, enter: Option<u8>) -> Option<Setup> {
    println!(
        "\n  1) Right-click menu only   adds \"Open with mdown\" for .md files\n  \
         2) Default app             double-clicking a .md file opens it in mdown\n  \
         3) Both\n  \
         4) Not now\n"
    );
    let hint = match enter {
        Some(n) => format!("Enter = {n}"),
        None => "Enter = 4".into(),
    };
    loop {
        print!("Choose 1-4 ({hint}): ");
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        if input.read_line(&mut line).unwrap_or(0) == 0 {
            return None;
        }
        let choice = match line.trim() {
            "" => enter.unwrap_or(4),
            s => s.parse().unwrap_or(0),
        };
        match choice {
            1 => return Some(Setup { context_menu: true, default: false }),
            2 => return Some(Setup { context_menu: false, default: true }),
            3 => return Some(Setup { context_menu: true, default: true }),
            4 => return None,
            _ => println!("Please enter 1, 2, 3 or 4."),
        }
    }
}

fn run_install(setup: Setup, open_settings: bool) {
    match platform::install(setup, open_settings) {
        Ok(msg) => println!("{msg}"),
        Err(e) => fail(&format!("install failed: {e}")),
    }
}

fn install(flags: &[String]) {
    let has = |f: &str| flags.iter().any(|a| a == f);
    if let Some(bad) = flags.iter().find(|a| !["--context-menu", "--default", "--all", "--yes", "--no-open"].contains(&a.as_str())) {
        fail(&format!("unknown install option: {bad}"));
    }
    let explicit = has("--context-menu") || has("--default") || has("--all");
    let setup = if explicit {
        Setup { context_menu: has("--context-menu") || has("--all"), default: has("--default") || has("--all") }
    } else if has("--yes") || !std::io::stdin().is_terminal() {
        Setup { context_menu: true, default: false }
    } else {
        match ask_setup(&mut std::io::stdin().lock(), Some(1)) {
            Some(s) => s,
            None => return println!("Nothing changed."),
        }
    };
    if let Some(m) = marker() {
        if let Some(dir) = m.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(m, "");
    }
    run_install(setup, !has("--no-open"));
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

fn uninstall() {
    match platform::uninstall() {
        Ok(msg) => println!("{msg}"),
        Err(e) => fail(&format!("uninstall failed: {e}")),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(input: &str, enter: Option<u8>) -> Option<(bool, bool)> {
        ask_setup(&mut input.as_bytes(), enter).map(|s| (s.context_menu, s.default))
    }

    #[test]
    fn menu_choices() {
        assert_eq!(pick("1\n", None), Some((true, false)));
        assert_eq!(pick("2\n", None), Some((false, true)));
        assert_eq!(pick("3\n", None), Some((true, true)));
        assert_eq!(pick("4\n", None), None);
    }

    #[test]
    fn enter_uses_the_given_default() {
        assert_eq!(pick("\n", None), None); // first run: Enter = not now
        assert_eq!(pick("\n", Some(1)), Some((true, false))); // explicit install: Enter = context menu
    }

    #[test]
    fn bad_input_reprompts_and_eof_means_not_now() {
        assert_eq!(pick("x\n9\n3\n", None), Some((true, true)));
        assert_eq!(pick("", Some(1)), None);
    }
}
