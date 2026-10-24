// Everything lives under HKCU\Software\Classes, so no admin rights are needed. Windows guards
// the user's default-app choice with a hashed UserChoice value that must not be forged, so
// "default" here means: register as a candidate, then send the user to Settings to pick it.

use std::io;
use std::path::Path;

use winreg::RegKey;
use winreg::enums::HKEY_CURRENT_USER;

use super::{Setup, app_path};

const EXTS: [&str; 2] = [".md", ".markdown"];
const PROG_ID: &str = "mdown.md";

fn hkcu() -> RegKey {
    RegKey::predef(HKEY_CURRENT_USER)
}

fn set(path: &str, name: &str, value: &str) -> io::Result<()> {
    hkcu().create_subkey(path)?.0.set_value(name, &value)
}

fn command(app: &Path) -> String {
    format!("\"{}\" \"%1\"", app.display())
}

pub fn is_installed() -> bool {
    hkcu().open_subkey(format!("Software\\Classes\\{PROG_ID}")).is_ok()
        || hkcu().open_subkey("Software\\Classes\\SystemFileAssociations\\.md\\shell\\mdown").is_ok()
}

pub fn install(setup: Setup, open_settings: bool) -> Result<String, String> {
    let app = app_path()?;
    do_install(setup, &app, open_settings).map_err(|e| e.to_string())?;
    notify_shell();

    let mut out = Vec::new();
    if setup.context_menu {
        out.push("Added \"Open with mdown\" to the right-click menu for .md files (on Windows 11 it is under \"Show more options\").");
    }
    if setup.default {
        out.push(if open_settings {
            "Registered mdown as an app for .md files. Windows only lets you pick the default yourself, so Settings is opening: choose mdown for .md (and .markdown) there."
        } else {
            "Registered mdown as an app for .md files. Pick it as the default in Settings > Apps > Default apps."
        });
    }
    Ok(out.join("\n"))
}

fn do_install(setup: Setup, app: &Path, open_settings: bool) -> io::Result<()> {
    let cmd = command(app);
    let icon = format!("\"{}\",0", app.display());

    if setup.context_menu {
        for ext in EXTS {
            let key = format!("Software\\Classes\\SystemFileAssociations\\{ext}\\shell\\mdown");
            set(&key, "", "Open with mdown")?;
            set(&key, "Icon", &icon)?;
            set(&format!("{key}\\command"), "", &cmd)?;
        }
    }

    if setup.default {
        let prog = format!("Software\\Classes\\{PROG_ID}");
        set(&prog, "", "Markdown document")?;
        set(&format!("{prog}\\DefaultIcon"), "", &icon)?;
        set(&format!("{prog}\\shell\\open\\command"), "", &cmd)?;

        let exe_key = "Software\\Classes\\Applications\\mdown-app.exe";
        set(exe_key, "FriendlyAppName", "mdown")?;
        set(&format!("{exe_key}\\shell\\open\\command"), "", &cmd)?;

        for ext in EXTS {
            set(&format!("Software\\Classes\\{ext}\\OpenWithProgids"), PROG_ID, "")?;
        }

        let caps = "Software\\mdown\\Capabilities";
        set(caps, "ApplicationName", "mdown")?;
        set(caps, "ApplicationDescription", "Lightweight Markdown viewer and editor")?;
        for ext in EXTS {
            set(&format!("{caps}\\FileAssociations"), ext, PROG_ID)?;
        }
        set("Software\\RegisteredApplications", "mdown", caps)?;

        if open_settings {
            let _ = open::that("ms-settings:defaultapps?registeredAppUser=mdown");
        }
    }
    Ok(())
}

pub fn uninstall() -> Result<String, String> {
    let root = hkcu();
    let mut keys = vec![
        format!("Software\\Classes\\{PROG_ID}"),
        "Software\\Classes\\Applications\\mdown-app.exe".to_string(),
        "Software\\mdown".to_string(),
    ];
    for ext in EXTS {
        keys.push(format!("Software\\Classes\\SystemFileAssociations\\{ext}\\shell\\mdown"));
    }
    for key in keys {
        ignore_missing(root.delete_subkey_all(&key))?;
    }
    for ext in EXTS {
        if let Ok(k) = root.open_subkey_with_flags(format!("Software\\Classes\\{ext}\\OpenWithProgids"), winreg::enums::KEY_SET_VALUE) {
            ignore_missing(k.delete_value(PROG_ID))?;
        }
    }
    if let Ok(k) = root.open_subkey_with_flags("Software\\RegisteredApplications", winreg::enums::KEY_SET_VALUE) {
        ignore_missing(k.delete_value("mdown"))?;
    }
    notify_shell();
    Ok("Removed mdown's file registrations. If you had picked it as the default app, Windows will ask which app to use next time.".into())
}

fn ignore_missing(r: io::Result<()>) -> Result<(), String> {
    match r {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Tells Explorer that file associations changed so menus refresh without a restart.
fn notify_shell() {
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHChangeNotify(event: i32, flags: u32, a: *const std::ffi::c_void, b: *const std::ffi::c_void);
    }
    const SHCNE_ASSOCCHANGED: i32 = 0x0800_0000;
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, 0, std::ptr::null(), std::ptr::null()) };
}
