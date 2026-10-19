# mdown: native Markdown viewer/editor, installed with `cargo install` (Windows + macOS)

The project and crate are named `mdown` (it started out as `markpane` and was renamed before anything was published). `mdown` and `mdown-app` were confirmed free on crates.io on 2026-10-26, but the name is not reserved until the first publish.

## Goal
Double-click a `.md` file and it opens in its own small window, fully rendered, and nothing else. No file explorer, no tabs, no history. Every file gets its own window. Press Ctrl/Cmd+E to toggle an editor. Export to PDF.

**Priorities: lightweight and instant.** Target under 300 ms from launch to first paint for a plain-text file. Keep the binary small and the compile time reasonable.

## Decisions already made
- **Distribution is `cargo install <crate>`** (like the user's existing log-reader tool, hem), with optional `cargo binstall` prebuilt binaries. It works on all three of the user's machines (Windows, personal Mac, work computer). Because the binary is compiled locally, there is no code signing, no SmartScreen warning, and no Gatekeeper quarantine. Signing is not part of this plan.
- **Stack:** Rust with `wry` (system webview: WebView2 on Windows, WKWebView on macOS) and `tao` (windowing). **Do not use the Tauri CLI or bundler.** They add installers, a big dependency tree, and compile time that `cargo install` users do not need.
- **Frontend:** vanilla JS/TS bundled with a tool such as esbuild or Vite, then **embedded in the binary** (`include_str!` or `rust-embed`) so it works offline. No UI framework.
- **Viewer by default, with a toggleable editor.**
- **No single-instance logic.** Multiple files means multiple windows. On Windows each double-click starts its own process with the path as an argument. On macOS, see "Open-file handling".

## Development setup
- **Windows (dev machine):** Rust via rustup (MSVC toolchain), Visual Studio Build Tools (C++ workload), Node. WebView2 ships with Windows 11 and recent Windows 10.
- **Mac (test machine over SSH):** Xcode command line tools, Rust, Node. Build over SSH with `cargo build --release`. A GUI app launched from an SSH session needs a logged-in graphical session on the Mac. Launch with `./target/release/mdown file.md`, then test the association with `mdown install` and `open sample.md`.
- **Project layout:** Cargo workspace or single crate with `frontend/` (source + bundle script) and `src/` (Rust). The bundled output is committed or built by a `build.rs`/publish step so that `cargo install` from crates.io works without Node on the user's machine. **The published crate must contain the already-built frontend bundle.**
- **CI (optional):** GitHub Actions on Windows and macOS runs `cargo build`, `cargo test`, and (on tags) builds prebuilt binaries for `cargo binstall`, attached to a GitHub Release.

## Milestones
1. **M1: Shell.** wry/tao window, CLI arg, one window per file, plain markdown render, theming, asset protocol. **Measure packaged crate size.** Verify on both OSes.
2. **M2: Rich content.** Code, math, mermaid, charts, images, per-block error handling, lazy loading.
3. **M3: 3D, live reload, links.** GLB and STL viewers, file watching, relative link handling.
4. **M4: Install command.** `mdown install`/`uninstall` for Windows registry and the macOS app wrapper, plus macOS open-document event handling.
5. **M5: Edit mode + PDF.** CodeMirror toggle, save and dirty handling, print stylesheet, verify print on both OSes.
6. **M6: Publish.** Name check on crates.io, README (install steps, the one-time "Open with → Always" step on each OS), `cargo publish`, optional binstall metadata and release workflow.

## Open decisions
- **Name: `mdown`** (decided; renamed from `markpane`, which was never published). Not reserved on crates.io until the first publish. Domains are optional, since there is no download site, only a README or GitHub page.
- Behavior when launched with no file (print usage, or show an empty window with a drop target).
- Whether to add OBJ support to the 3D viewer later.
- Split view versus editor-only with a preview toggle.
- Whether to also publish prebuilt binaries for `cargo binstall`.

