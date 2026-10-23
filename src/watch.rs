use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};

/// Calls `on_change` once per burst of writes to `file`. Editors often save by writing a temp
/// file and renaming it over the original, which a watch on the file itself would lose, so the
/// parent directory is watched and events are filtered by name.
pub fn watch(file: &Path, on_change: impl Fn() + Send + 'static) -> Option<notify::RecommendedWatcher> {
    let name = file.file_name()?.to_owned();
    let dir = file.parent()?;
    let (tx, rx) = mpsc::channel::<()>();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            let relevant = !ev.kind.is_access() && ev.paths.iter().any(|p| p.file_name() == Some(&name));
            if relevant {
                let _ = tx.send(());
            }
        }
    })
    .ok()?;
    watcher.watch(dir, RecursiveMode::NonRecursive).ok()?;

    std::thread::spawn(move || {
        // Wait for the first event, then swallow follow-ups until things go quiet for 100 ms.
        while rx.recv().is_ok() {
            while rx.recv_timeout(Duration::from_millis(100)).is_ok() {}
            on_change();
        }
    });
    Some(watcher)
}
