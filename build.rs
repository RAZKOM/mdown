// Embeds every file under dist/ (the prebuilt frontend) into the binary. The bundle contains
// content-hashed chunks, so the list is generated rather than hand-maintained.
use std::fmt::Write;
use std::path::Path;

fn walk(dir: &Path, root: &Path, out: &mut String) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).expect("dist/ is missing; run `npm run build` in frontend/").flatten().collect();
    entries.sort_by_key(|e| e.path());
    for e in entries {
        let p = e.path();
        if p.is_dir() {
            walk(&p, root, out);
        } else {
            let url = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            let abs = p.to_string_lossy().replace('\\', "/");
            writeln!(out, "    (\"/{url}\", include_bytes!(\"{abs}\")),").unwrap();
        }
    }
}

/// Windows: the app icon is a precompiled resource (assets/mdown.res, made by
/// frontend/mkicon.mjs), so building needs no resource compiler. link.exe accepts .res files;
/// the GNU toolchain doesn't, and just goes without an icon.
fn link_windows_icon(manifest: &Path) {
    let var = |name| std::env::var(name).unwrap_or_default();
    if var("CARGO_CFG_TARGET_OS") == "windows" && var("CARGO_CFG_TARGET_ENV") == "msvc" {
        println!("cargo:rerun-if-changed=assets/mdown.res");
        println!("cargo:rustc-link-arg-bins={}", manifest.join("assets").join("mdown.res").display());
    }
}

fn main() {
    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    link_windows_icon(&manifest);
    let root = manifest.join("dist");
    println!("cargo:rerun-if-changed=dist");
    let mut body = String::new();
    walk(&root, &root, &mut body);
    let src = format!("pub static FILES: &[(&str, &[u8])] = &[\n{body}];\n");
    std::fs::write(Path::new(&std::env::var("OUT_DIR").unwrap()).join("embedded.rs"), src).unwrap();
}
