// macOS only. A webview app with no menu bar has no Cmd+C / Cmd+V / Cmd+A / Cmd+Q, because
// those are menu key equivalents, not keystrokes the page sees. Close and Quit are custom
// items so they run through the unsaved-changes prompt instead of killing the process.

pub enum Action {
    CloseWindow,
    QuitAll,
}
