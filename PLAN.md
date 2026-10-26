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

## Architecture
- **Binaries (built, M4):** two `[[bin]]` targets installed together by `cargo install mdown`.
  - `mdown` is a tiny console launcher (`src/launcher`). `mdown <files>` hands the files to the GUI binary and returns in ~20 ms; it also hosts `install`/`uninstall` and the setup menu. There is no shorter alias: `md` is deliberately not used because PowerShell's `md` alias and cmd's built-in `md` (both mkdir) shadow any `md.exe` on Windows, and `mdown` is already short.
  - `mdown-app` is the real viewer, built with `windows_subsystem = "windows"` so a double-click never flashes a console. File associations and the macOS bundle point at it directly. One process hosts any number of windows (internal `.md` links and macOS open-document events open more windows in the same process); Windows double-clicks still start one process each.
  - `cargo install` cannot prompt (no post-install hook, `build.rs` has no terminal and must not touch the system), so the setup menu appears on the first interactive terminal run (once, remembered in `setup-asked`), or any time via `mdown install`.
- **CLI:** `mdown <file.md>...` opens each file in its own window. Subcommands: `mdown install` and `mdown uninstall` (see "File association").
- **Reading and writing files:** Rust reads and writes the file through custom protocol handlers or IPC commands exposed to the page. Keep the surface minimal (read file, write file, resolve asset).
- **Local assets:** images, models and linked files resolve relative to the .md file's folder. Serve them through a custom protocol registered on the webview (for example `asset://`) that maps to the file's directory and refuses to escape it with `..`. Remote `http(s)` images should work too.
- **Live reload:** watch the open file with the `notify` crate. On change, re-render and keep the scroll position. Debounce about 100 ms.
- **Links:** external links open in the default browser (`open` crate). Relative links to other `.md` files open in a new window (spawn a new process). `#anchor` links scroll in place.
- **Theme (built):** `system` (default, follows the OS), `light` or `dark`. Cycle with Ctrl/Cmd+Shift+L (saved globally and pushed to every open window), set with `mdown theme [system|light|dark]`, or edit `settings.json` (`%APPDATA%\mdown\` on Windows, `~/Library/Application Support/mdown/` on macOS; `{ "theme": "dark" }`). The saved theme is stamped on `<html data-theme>` when the page is served, so there is no flash; the title bar follows via tao's `set_theme`. Mermaid, Chart.js, code highlighting, the editor and the 3D viewer follow it; print is always light.
- **Settings (built):** `settings.json` holds `theme`, `width` (`normal` | `wide`, the reading column) and `zoom` (0.5 to 3.0, in 0.1 steps). Invalid or missing values fall back to defaults and unknown keys survive a save. The page sends one generic IPC message (`{t:"setting", key, value}`); Rust validates and saves it, then evaluates `__applySettings(settings, changedKey)` in every window (the window that asked also shows a toast). Text size is the webview's native zoom (`WebView::zoom`), with wry's built-in hotkey zoom turned off so the page owns the shortcuts. Theme, width and zoom are stamped on `<html>` at serve time.
- **Context menu (built):** a right-click menu drawn in the page (same look on both OSes, no extra crates). Top section depends on the target: Copy / Select all in the preview, plus Copy link address on links and Copy code on code blocks; Cut / Copy / Paste / Select all in the editor. Then Edit mode or View mode, Save (enabled while there are unsaved edits), Print / Save as PDF, flyouts for Theme, Text size and Page width, Show in File Explorer / Reveal in Finder, and Copy file path. Mouse presses on the menu are swallowed so the selection survives; arrow keys, Enter and Escape work. WebView2 needs `with_clipboard(true)` or Paste raises a permission prompt.
- **Shortcuts:** Ctrl/Cmd+E edit, +S save, +P print/PDF, +Shift+L cycle theme, +`+` / +`-` / +0 text size (Ctrl+wheel and trackpad pinch too); Cmd+C/V/X/A/Z/W/Q on macOS come from the menu bar.
- **Window:** sensible default size, remember last size globally (a small config file), title shows the file name, plus a dirty marker in edit mode.

### Open-file handling
- **Windows:** the path arrives as a CLI argument. Nothing else is needed.
- **macOS:** when a `.md` file is double-clicked, LaunchServices launches the app (if not running) or sends the file to the running instance as an "open document" event. It does not start a second process. `tao` should expose this as an event on macOS (verify the exact name and version). Handle it by opening a new window in the same process. Also handle the plain CLI argument path (used when running from a terminal).
- If the event route proves awkward, the fallback is: on receiving an open-file event, spawn a fresh `mdown <path>` child process and let the receiving process exit if it has no windows.

## File association (`mdown install` / `mdown uninstall`)
`cargo install` only puts a binary on PATH, so a one-time setup command registers `.md`:
- **Windows:** write the ProgId and "Open with" registration under `HKCU\Software\Classes` (no admin needed). Windows protects the default-app choice, so the user picks mdown as the default once through "Open with → Choose another app → Always". Do not attempt to forge that choice.
- **macOS:** a bare binary cannot be a default app. Generate `~/Applications/mdown.app` locally, containing an `Info.plist` that declares the `.md`/`.markdown` document types and an executable that launches the installed binary (a small native stub or a script that execs it; verify that file-open events reach the real process, and if a script cannot receive them, make the stub the actual binary or a copy of it). Because it is created locally, it is not quarantined. The user then picks "Open with → Always" once.
- **`install` asks what to set up** (interactive prompt; flags `--default`, `--context-menu`, `--all`, `--yes` skip it for scripting):
  1. **Context menu only:** a right-click "Open with mdown" entry for `.md`/`.markdown`. Windows: `HKCU\Software\Classes\SystemFileAssociations\.md\shell\mdown` (no admin). macOS: the generated `mdown.app` shows up under "Open With" automatically.
  2. **Default app for Markdown:** do everything in (1), register the ProgId, then take the user to the OS's own default-app step: Windows opens `ms-settings:defaultapps` (the UserChoice hash means we must not write the choice ourselves); macOS can set the handler through the LaunchServices API (`LSSetDefaultRoleHandlerForContentType`) after the user confirms the prompt, which is a supported API, not a forgery.
  3. **Both** (default is to ask; context menu alone is the safe default if the user just presses Enter).
- `uninstall` reverses everything `install` registered.

## Rendering pipeline (all heavy parts lazy-loaded)
| Feature | Library | Load rule |
|---|---|---|
| Markdown core | `markdown-it` + footnote, task-lists, anchor, front-matter | always |
| Sanitization | `DOMPurify` (raw HTML in markdown is allowed, but sanitized) | always |
| Code highlighting | `highlight.js` (core + languages on demand) or Shiki | only if code fences exist |
| Math | `KaTeX` (`$..$`, `$$..$$`) | only if math present |
| Diagrams | `mermaid` (```` ```mermaid ````) | only if a mermaid block exists |
| Charts | `Chart.js`, fenced ```` ```chart ```` block with JSON config | only if a chart block exists |
| 3D | `three` + `GLTFLoader` + `STLLoader` (or `<model-viewer>` for GLB) | only if a model is referenced |
| Images | native `<img>`, click to zoom | always |

- **3D syntax:** `![alt](part.glb)` or `![alt](part.stl)`. Detect by extension and replace with an interactive viewer (orbit controls, auto-fit camera, lighting).
- **Chart syntax:** fenced block with language `chart` containing Chart.js JSON. Invalid JSON shows a readable inline error.
- **Errors:** any single block that fails (bad mermaid, bad chart JSON, missing model) shows an inline error in place and does not break the rest of the page.
- **Speed rule:** render the markdown core and paint first, then hydrate heavy blocks asynchronously.
- **Reuse:** the user has a working Markdown-to-PDF tool at https://patriciobunt.com/#/tools/markdown-pdf (source: github.com/PatricioBunt/PatricioBunt.github.io, vanilla JS). Read it first and reuse its CSS and rendering choices where sensible.

### Crate size constraint (check this early)
crates.io limits a published crate to 10 MB compressed. The embedded frontend (markdown-it, Mermaid, Chart.js, KaTeX with fonts, three.js plus loaders) is several MB combined. **Milestone 1 must include measuring the packaged crate size** (`cargo package --list` and the `.crate` file size). If it is too large:
1. Minify and gzip-friendly bundle; keep only needed KaTeX fonts (woff2) and highlight.js languages.
2. Split the heaviest libraries out and fetch them from a CDN on first use, with a clear offline error.
3. Last resort: ship a minimal crate and have the first run download the heavy assets to a cache folder.

## Editor mode
- Ctrl/Cmd+E toggles view and edit. Edit mode is a split view: CodeMirror 6 on the left, live preview on the right (or editor-only with a preview toggle).
- Lazy-load CodeMirror the first time edit mode is entered, so view mode stays fast.
- Ctrl/Cmd+S saves. Show an unsaved-changes marker in the title and prompt on close if dirty.
- If the file changes on disk while the buffer is dirty, show a non-blocking banner ("reload / keep mine"). Never overwrite silently.
- Keep features minimal: markdown highlighting, soft wrap, undo/redo, find. No toolbar.

## PDF export
- **v1:** a print stylesheet (`@media print`) with sensible page breaks, no UI chrome, light theme forced, and charts/mermaid/3D shown as static output (the 3D viewer should print as a snapshot image). Trigger the webview's print function and let the user choose "Save as PDF."
- **Risk to verify on macOS:** printing from WKWebView can be unreliable. Test wry's print API first. If it fails on macOS, fall back to a native `createPDF` call.
- **v2 (optional):** one-click export with a save dialog (WebView2 `PrintToPdf` on Windows, WKWebView `createPDF` on macOS).
- Shortcut: Ctrl/Cmd+P.

## Development setup
- **Windows (dev machine):** Rust via rustup (MSVC toolchain), Visual Studio Build Tools (C++ workload), Node. WebView2 ships with Windows 11 and recent Windows 10.
- **Mac (test machine over SSH):** Xcode command line tools, Rust, Node. Build over SSH with `cargo build --release`. A GUI app launched from an SSH session needs a logged-in graphical session on the Mac. Launch with `./target/release/mdown file.md`, then test the association with `mdown install` and `open sample.md`.
- **Project layout:** Cargo workspace or single crate with `frontend/` (source + bundle script) and `src/` (Rust). The bundled output is committed or built by a `build.rs`/publish step so that `cargo install` from crates.io works without Node on the user's machine. **The published crate must contain the already-built frontend bundle.**
- **CI (optional):** GitHub Actions on Windows and macOS runs `cargo build`, `cargo test`, and (on tags) builds prebuilt binaries for `cargo binstall`, attached to a GitHub Release.

## Test checklist (put sample files in a `samples/` folder)
1. Plain markdown: headings, lists, tables, task lists, footnotes, blockquotes, inline HTML.
2. Code blocks in several languages.
3. Math (inline and block).
4. A mermaid flowchart, a sequence diagram, and one deliberately broken block.
5. Chart.js bar and line charts, plus one with invalid JSON.
6. Local images with relative paths, nested folders, spaces in names, and a remote image.
7. A `.glb` and an `.stl` model (small free samples).
8. Opening two files gives two separate windows (Windows: two processes; macOS: two windows).
9. Double-click from Explorer/Finder after `mdown install` works on both OSes.
10. Live reload on external edit, with scroll position preserved.
11. Edit toggle, save, dirty-close prompt, and the external-change-while-dirty banner.
12. PDF export looks right for each of the above, in light theme.
13. OS dark/light switch updates the view live.
14. Large file (about 2 MB markdown) scrolls smoothly.
15. Path traversal: a markdown file referencing `../../something` or an absolute path outside its folder must not be served by the asset protocol.
16. `cargo install --path .` from a clean checkout works with no Node installed.
17. Performance: record cold start to first paint on both machines.

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

## Release polish (before M6 publish)
- **Icon (built):** `frontend/mkicon.mjs` draws `assets/icon.svg` and writes every format into `assets/`, all committed so a build never needs Node: `icon.ico`, `icon.icns`, `icon.png`, `icon-64.rgba` (window icon) and `mdown.res`, a precompiled Windows resource that `build.rs` links into both exes (MSVC only; no `rc.exe` needed). Windows shows it in the exe, Explorer, the title bar and the registry entries; `mdown install` on macOS writes the `.icns` into `mdown.app` (validated with `iconutil`). The design is a simple placeholder-quality mark and is easy to replace: edit the SVG in `mkicon.mjs` and rerun it.
- **README (built):** `README.md` with light/dark/edit/menu screenshots in `docs/` (captured from `docs/showcase.md` through the WebView2 debug port).
- **Crate metadata (built):** description, MIT license (`LICENSE`), keywords, categories, `rust-version = "1.90"` (set by the macOS-only `muda`), binstall metadata, `.github/workflows/ci.yml` (tests and a release build on Windows and macOS for pushes to `main` and PRs) and `release.yml`. Repository: https://github.com/RAZKOM/mdown.
- **Releasing:** bump `version` in `Cargo.toml`, commit, then `git tag v<version> && git push origin v<version>`. The tag triggers `release.yml`: `check` (the tag must equal the Cargo.toml version), `build` (Windows x64 and macOS arm64/x64 archives), `publish` (`cargo publish` from a Windows runner, using the repository secret `CARGO_REGISTRY_TOKEN`), then `release` (GitHub release with the archives, which `cargo binstall` downloads). The first publish of a new crate name needs a crates.io API token; trusted publishing can replace the token once the crate exists.
- **Dev hooks:** `MDOWN_DEBUG_JS` and the startup timing marks exist only with `--features debug-hooks`; `window.__editor` / `window.__print` stay in the page as test hooks.
- **Package check:** `cargo publish --dry-run` packages 201 files, 7.6 MiB (2.5 MiB compressed, limit 10 MiB) and builds from the tarball.

## Performance (measured, release build, warm disk cache)
- **macOS (M-series):** first contentful paint about 270 ms after the process starts. Meets the 300 ms target.
- **Windows 11:** about 400 ms until the content is painted (first-contentful-paint 420 to 470 ms). Breakdown: window created at ~35 ms, `WebViewBuilder::build` (WebView2 runtime start) finished at ~280 ms, page ready ~35 ms later, first frame ~100 ms after that because Chromium's GPU/compositor process starts on the first paint. The page itself is done within ~55 ms of navigation; module preloading and embedding the document in the HTML made no measurable difference. The first launch after (re)building or installing the exe takes 1 s or more because Defender scans it.
- **What would help, and why it isn't on:** `--in-process-gpu` (pass via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` to try it) saves ~50 ms by skipping the GPU process but gives up its sandbox and crash isolation, so a GPU driver fault would take the whole app down with unsaved edits. `--disable-gpu` saves ~65 ms but makes the 3D viewer software-rendered. Other flags tried (occlusion, background networking, shader cache, GPU compositing) did nothing. A resident background process would beat 300 ms but contradicts "lightweight".
