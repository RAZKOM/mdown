// File writing shared by the viewer and the `mdown` launcher (which includes it by path).

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Replaces `path` with `bytes` without ever leaving it half-written: the data goes to a
/// temporary file in the same folder, which is then renamed over the original. A crash or a
/// full disk mid-save leaves the old file intact.
///
/// Falls back to writing in place where a rename would change more than the contents (the file
/// has other hard links) or isn't possible (Windows refuses to replace a file some other program
/// holds open). A read-only file is refused, as a plain write would be.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    // Write through a symlink to its target rather than replacing the link with a file.
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let existing = fs::metadata(&target).ok();
    if let Some(meta) = &existing {
        if meta.permissions().readonly() {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "the file is read-only"));
        }
        #[cfg(unix)]
        if std::os::unix::fs::MetadataExt::nlink(meta) > 1 {
            return fs::write(&target, bytes);
        }
    }

    let tmp = temp_name(&target);
    let staged = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        if let Some(meta) = &existing {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, &target)
    })();
    if staged.is_err() {
        let _ = fs::remove_file(&tmp);
        // Could be a folder we may not create files in, or a locked target on Windows; a plain
        // write is what mdown always did, so it is the floor, not a new risk.
        return fs::write(&target, bytes);
    }
    Ok(())
}

/// `notes.md` becomes `.notes.md.mdown-<pid>.tmp` next to it: hidden on macOS and Linux, and a
/// different name, so the file watcher (which filters by name) ignores it.
fn temp_name(target: &Path) -> PathBuf {
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    target.with_file_name(format!(".{name}.mdown-{}.tmp", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_contents_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("mdown-fsutil-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("doc.md");
        fs::write(&file, "old contents that are longer").unwrap();
        write_atomic(&file, b"new").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"new");
        // A file that doesn't exist yet is created.
        write_atomic(&dir.join("fresh.md"), b"x").unwrap();
        let mut names: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        names.sort();
        assert_eq!(names, ["doc.md", "fresh.md"]);

        let mut perms = fs::metadata(&file).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&file, perms.clone()).unwrap();
        assert_eq!(write_atomic(&file, b"nope").unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&file).unwrap(), b"new");
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&file, perms).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn keeps_symlinks_and_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("mdown-fsutil-link-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let real = dir.join("real.md");
        fs::write(&real, "old").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o640)).unwrap();
        let link = dir.join("link.md");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write_atomic(&link, b"new").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&real).unwrap(), b"new");
        assert_eq!(fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o640);
        fs::remove_dir_all(&dir).unwrap();
    }
}
