// A bare binary can't be a default app on macOS, so install builds ~/Applications/mdown.app
// locally. Being created on this machine it is never quarantined, so Gatekeeper stays quiet.
// The bundle's executable is a copy of the real GUI binary so LaunchServices open-file events
// reach it. Re-run `mdown install` after upgrading to refresh the copy.

use std::path::{Path, PathBuf};
use std::process::Command;

use core_foundation::base::TCFType;
use core_foundation::string::{CFString, CFStringRef};

use super::{Setup, app_path};

const ICON: &[u8] = include_bytes!("../../assets/icon.icns");
const BUNDLE_ID: &str = "com.patriciobunt.mdown";
const MARKDOWN_UTI: &str = "net.daringfireball.markdown";
const LSREGISTER: &str =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn LSSetDefaultRoleHandlerForContentType(content_type: CFStringRef, role: u32, handler: CFStringRef) -> i32;
}
const LS_ROLES_ALL: u32 = 0xFFFF_FFFF;

fn bundle() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join("Applications").join("mdown.app"))
}

pub fn is_installed() -> bool {
    bundle().is_some_and(|b| b.exists())
}

fn plist(default: bool) -> String {
    let rank = if default { "Default" } else { "Alternate" };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>{BUNDLE_ID}</string>
  <key>CFBundleName</key><string>mdown</string>
  <key>CFBundleDisplayName</key><string>mdown</string>
  <key>CFBundleExecutable</key><string>mdown-app</string>
  <key>CFBundleIconFile</key><string>mdown</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>{version}</string>
  <key>CFBundleVersion</key><string>{version}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Markdown document</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>{rank}</string>
      <key>LSItemContentTypes</key><array><string>{MARKDOWN_UTI}</string></array>
    </dict>
  </array>
  <key>UTImportedTypeDeclarations</key>
  <array>
    <dict>
      <key>UTTypeIdentifier</key><string>{MARKDOWN_UTI}</string>
      <key>UTTypeDescription</key><string>Markdown document</string>
      <key>UTTypeConformsTo</key><array><string>public.plain-text</string></array>
      <key>UTTypeTagSpecification</key>
      <dict>
        <key>public.filename-extension</key><array><string>md</string><string>markdown</string></array>
        <key>public.mime-type</key><array><string>text/markdown</string></array>
      </dict>
    </dict>
  </array>
</dict>
</plist>
"#,
        version = env!("CARGO_PKG_VERSION"),
    )
}

fn run_quiet(program: &str, args: &[&Path]) {
    let _ = Command::new(program).args(args).output();
}

pub fn install(setup: Setup, _open_settings: bool) -> Result<String, String> {
    let exe = app_path()?;
    let app = bundle().ok_or("cannot find your home folder")?;
    let macos_dir = app.join("Contents").join("MacOS");
    std::fs::create_dir_all(&macos_dir).map_err(|e| e.to_string())?;

    let target = macos_dir.join("mdown-app");
    let _ = std::fs::remove_file(&target);
    std::fs::copy(&exe, &target).map_err(|e| format!("copying the app into the bundle: {e}"))?;
    std::fs::write(app.join("Contents").join("Info.plist"), plist(setup.default)).map_err(|e| e.to_string())?;
    let resources = app.join("Contents").join("Resources");
    std::fs::create_dir_all(&resources).map_err(|e| e.to_string())?;
    std::fs::write(resources.join("mdown.icns"), ICON).map_err(|e| e.to_string())?;

    // A local ad-hoc signature ties the bundle's Info.plist to the binary; harmless if it fails.
    let _ = Command::new("codesign").args(["--force", "--deep", "--sign", "-"]).arg(&app).output();
    run_quiet(LSREGISTER, &[Path::new("-f"), &app]);

    let mut out = vec![format!("Created {}.", app.display())];
    if setup.context_menu || !setup.default {
        out.push("mdown now appears under Open With when you right-click a .md file in Finder.".into());
    }
    if setup.default {
        let (uti, id) = (CFString::new(MARKDOWN_UTI), CFString::new(BUNDLE_ID));
        // SAFETY: both arguments are live CFStrings for the duration of the call.
        let status = unsafe { LSSetDefaultRoleHandlerForContentType(uti.as_concrete_TypeRef(), LS_ROLES_ALL, id.as_concrete_TypeRef()) };
        if status == 0 {
            out.push("mdown is now the default app for Markdown files.".into());
        } else {
            out.push(format!(
                "macOS refused to change the default (status {status}). In Finder: right-click a .md file > Get Info > Open with > mdown > Change All."
            ));
        }
    }
    Ok(out.join("\n"))
}

pub fn uninstall() -> Result<String, String> {
    let app = bundle().ok_or("cannot find your home folder")?;
    if !app.exists() {
        return Ok("mdown.app was not installed.".into());
    }
    run_quiet(LSREGISTER, &[Path::new("-u"), &app]);
    std::fs::remove_dir_all(&app).map_err(|e| e.to_string())?;
    Ok(format!("Removed {}. macOS falls back to another app for .md files.", app.display()))
}
