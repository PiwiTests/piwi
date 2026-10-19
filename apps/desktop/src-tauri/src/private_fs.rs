// Files and folders that hold a credential, readable by their owner only.
//
// A file is written to a temporary sibling opened with its final permissions,
// then renamed over the target: the content never sits on disk with wider
// permissions, and a reader never sees a half-written file. Modes apply on Unix
// only — on Windows the per-user profile is already ACL-protected and `std::fs`
// cannot express ACLs.

use std::io::{self, Write as _};
use std::path::Path;

/// Owner read/write.
const PRIVATE_FILE_MODE: u32 = 0o600;
/// Owner read/write/search.
const PRIVATE_DIR_MODE: u32 = 0o700;

/// Create `dir` (and its missing parents) and restrict `dir` itself to its
/// owner. An existing folder is tightened too: only folders this app owns are
/// passed here. Tightening is best-effort, so a filesystem that ignores modes
/// does not block startup.
pub(crate) fn create_private_dir(dir: &Path) -> io::Result<()> {
    if !dir.is_dir() {
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, PRIVATE_DIR_MODE);
        match builder.create(dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && dir.is_dir() => {}
            Err(e) => return Err(e),
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(PRIVATE_DIR_MODE));
    }
    Ok(())
}

/// Replace `path` with `contents`, readable and writable by its owner only.
pub(crate) fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    replace_file(path, contents, PRIVATE_FILE_MODE)
}

/// Replace another app's file with `contents`, keeping the permissions it has,
/// or owner-only for a new file. A symlink is followed: the link stays and its
/// target is rewritten.
pub(crate) fn write_keeping_mode(path: &Path, contents: &[u8]) -> io::Result<()> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mode = existing_mode(&target).unwrap_or(PRIVATE_FILE_MODE);
    replace_file(&target, contents, mode)
}

#[cfg(unix)]
fn existing_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::metadata(path).ok().map(|meta| meta.permissions().mode() & 0o7777)
}

#[cfg(not(unix))]
fn existing_mode(_path: &Path) -> Option<u32> {
    None
}

/// Write `contents` to a new temporary file next to `path`, created with
/// `mode`, then rename it over `path`. The temporary file is removed on failure.
fn replace_file(path: &Path, contents: &[u8], mode: u32) -> io::Result<()> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a file path"))?;
    let suffix = &crate::random_hex_32()[..12];
    let temp = path.with_file_name(format!(".{}.{suffix}.tmp", name.to_string_lossy()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, mode);
        let mut file = options.open(&temp)?;
        // The creation mode is narrowed by the umask; set the exact one.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            file.set_permissions(std::fs::Permissions::from_mode(mode))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::PathBuf;

    /// A directory under the OS temp dir, removed when the test ends.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("piwi-private-{label}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn mode_of(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_private_file_is_owner_only_and_replaces_the_old_content() {
        let dir = TempDir::new("file");
        let path = dir.0.join("secret.key");
        write_private(&path, b"one").unwrap();
        assert_eq!(mode_of(&path), 0o600);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert_eq!(mode_of(&path), 0o600);
        assert_eq!(entries(&dir.0), ["secret.key"]);
    }

    #[test]
    fn another_apps_file_keeps_its_mode_and_its_symlink() {
        let dir = TempDir::new("keep");
        let target = dir.0.join("real.json");
        std::fs::write(&target, "{}").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        let link = dir.0.join("mcp.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        write_keeping_mode(&link, b"{\"a\":1}").unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read(&target).unwrap(), b"{\"a\":1}");
        assert_eq!(mode_of(&target), 0o640);

        let fresh = dir.0.join("new.json");
        write_keeping_mode(&fresh, b"{}").unwrap();
        assert_eq!(mode_of(&fresh), 0o600);
    }

    #[test]
    fn a_private_dir_is_created_and_tightened_owner_only() {
        let dir = TempDir::new("dir");
        let created = dir.0.join("a").join(".piwi");
        create_private_dir(&created).unwrap();
        assert_eq!(mode_of(&created), 0o700);

        let existing = dir.0.join("existing");
        std::fs::create_dir(&existing).unwrap();
        std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o755)).unwrap();
        create_private_dir(&existing).unwrap();
        assert_eq!(mode_of(&existing), 0o700);
    }
}
