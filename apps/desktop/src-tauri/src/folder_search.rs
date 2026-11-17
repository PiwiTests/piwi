// Finds the folder of a Piwi project on this machine: the folder Playwright
// runs in. It holds the Playwright config, and the spec paths a project's runs
// report are relative to it, so a folder that holds those specs is the one to
// link. In a monorepo it is the subfolder with the config, not the repository
// root.
//
// Read-only and bounded: a search below a folder examines a fixed number of
// folders, enters no link and skips dependency and output folders; a git file
// is read only when it is a regular file, and only its first bytes. On macOS no
// search reads the folders directly in the home folder (Desktop, Documents…),
// which would ask the person for access. Depends on `std` and `serde` alone.

use std::collections::HashSet;
use std::io::Read as _;
use std::path::{Component, Path, PathBuf};

/// Playwright's own config lookup order.
pub(crate) const CONFIG_NAMES: [&str; 6] = [
    "playwright.config.ts",
    "playwright.config.mts",
    "playwright.config.cts",
    "playwright.config.js",
    "playwright.config.mjs",
    "playwright.config.cjs",
];

/// Folders a search below never enters: dependencies, build and test output.
const SKIPPED_FOLDERS: [&str; 8] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    "test-results",
    "playwright-report",
    "blob-report",
];

/// The extensions of a Playwright test file: a spec path without one is never checked.
const SPEC_EXTENSIONS: [&str; 8] = [".ts", ".js", ".mjs", ".cjs", ".mts", ".cts", ".tsx", ".jsx"];

/// How many levels below a folder a search looks for a config.
const MAX_DEPTH_BELOW: usize = 4;
/// How many folders a search below a folder the person picked examines at most.
const MAX_FOLDERS_BELOW: usize = 2_000;
/// How many folders a search below one clone examines at most.
const MAX_FOLDERS_BELOW_CLONE: usize = 300;
/// How many clones of the repository the suggestions search at most.
const MAX_CLONES: usize = 5;
/// How many levels above a folder a search looks, up to the root of its git repository.
const MAX_LEVELS_ABOVE: usize = 8;
/// How many levels above a folder a search looks when it is in no git repository.
const MAX_LEVELS_ABOVE_OUTSIDE_GIT: usize = 2;
/// How many levels above a folder its git repository's root is looked for.
const MAX_GIT_ROOT_WALK: usize = 64;
/// How many spec paths a check reads.
const MAX_SPECS: usize = 200;
/// How many spec paths missing from a folder a check names.
const MAX_MISSING_NAMED: usize = 3;
/// How many alternatives or suggestions a search returns.
const MAX_RESULTS: usize = 5;
/// How many parent folders the search for clones reads.
const MAX_CLONE_PARENTS: usize = 8;
/// How many folders of one parent the search for clones reads.
const MAX_SIBLINGS: usize = 300;
/// Upper bound on a git file read (`.git` of a worktree, `commondir`, `config`).
const MAX_GIT_FILE_BYTES: u64 = 256 * 1024;

/// What a folder is to a project: whether it holds the Playwright config and
/// the specs of the project's runs, which repository it is a clone of, and the
/// folders above or below it that fit better when it does not.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderCheck {
    /// The folder checked.
    pub path: String,
    /// The folder is a directory on disk. Everything below is empty when it is not.
    pub exists: bool,
    /// File name of the Playwright config at the folder's root.
    pub playwright_config: Option<String>,
    /// How many of the spec paths given were checked: the relative ones, once each.
    pub specs_checked: usize,
    /// How many of them the folder holds.
    pub specs_found: usize,
    /// The first spec paths the folder does not hold.
    pub missing_specs: Vec<String>,
    /// The repository the folder is a clone of, as `host/owner/repo`, from its first remote that names one.
    pub repository: Option<String>,
    /// Whether one of the folder's remotes names the repository expected; `None` when either is unknown.
    pub same_repository: Option<bool>,
    /// The folder holds the config and, when specs were given, some of them.
    pub fits: bool,
    /// Folders above or below it that hold a config, best first; empty when it fits.
    pub alternatives: Vec<FolderCandidate>,
}

/// A folder offered for a project.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderCandidate {
    pub path: String,
    /// File name of the Playwright config at its root.
    pub playwright_config: String,
    /// How many of the spec paths given it holds.
    pub specs_found: usize,
    /// Why it is offered: `above` or `below` the folder checked, a folder a
    /// `run` of the project was reported from, or a `clone` of its repository.
    pub source: &'static str,
}

/// The Playwright config at the root of `folder`, in Playwright's lookup order.
pub(crate) fn find_config(folder: &Path) -> Option<&'static str> {
    CONFIG_NAMES
        .into_iter()
        .find(|name| folder.join(name).is_file())
}

/// A spec path as a run reports it (relative to the config's folder, with `/`
/// or `\` between its parts) as a relative path; `None` for an absolute path
/// or one that leaves its folder.
fn relative_spec(file: &str) -> Option<PathBuf> {
    let normalized = file.replace('\\', "/");
    if normalized.starts_with('/') {
        return None;
    }
    let mut relative = PathBuf::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            name => relative.push(name),
        }
    }
    let leaves = relative
        .components()
        .any(|c| matches!(c, Component::Prefix(_) | Component::RootDir | Component::ParentDir));
    (!leaves && !relative.as_os_str().is_empty()).then_some(relative)
}

/// Whether `folder` holds the spec `file`; `None` for a path that cannot be
/// checked (absolute, or leaving the folder).
pub(crate) fn spec_in(folder: &Path, file: &str) -> Option<bool> {
    relative_spec(file).map(|relative| folder.join(relative).is_file())
}

/// The spec paths a check reads: the relative paths of test files (`SPEC_EXTENSIONS`), once each, at most `MAX_SPECS`.
fn checkable_specs(specs: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    specs
        .iter()
        .filter(|file| SPEC_EXTENSIONS.iter().any(|ext| file.ends_with(ext)))
        .filter(|file| relative_spec(file).is_some())
        .filter(|file| seen.insert(file.as_str()))
        .take(MAX_SPECS)
        .cloned()
        .collect()
}

fn specs_found(folder: &Path, specs: &[String]) -> usize {
    specs
        .iter()
        .filter(|file| spec_in(folder, file) == Some(true))
        .count()
}

/// The folder holds a config and, when specs are known, some of them.
fn fits(folder: &Path, specs: &[String]) -> bool {
    find_config(folder).is_some() && (specs.is_empty() || specs_found(folder, specs) > 0)
}

fn shown(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// A regular file's first `MAX_GIT_FILE_BYTES` as text; `None` for anything else (a pipe, a device).
fn read_small(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    file.take(MAX_GIT_FILE_BYTES).read_to_string(&mut text).ok()?;
    Some(text)
}

/// The person's home folder.
fn home_folder() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

/// Whether reading the folders directly in `folder` would ask the person for
/// access: the home folder on macOS, whose Desktop, Documents and Downloads
/// are protected.
fn guarded(folder: &Path) -> bool {
    cfg!(target_os = "macos") && home_folder().is_some_and(|home| home == folder)
}

/// The root of the git working tree `folder` is in: the nearest folder holding
/// `.git`, below the home folder (a home tracked for its dotfiles is no
/// project's repository).
pub(crate) fn git_root(folder: &Path) -> Option<PathBuf> {
    let home = home_folder();
    folder
        .ancestors()
        .take(MAX_GIT_ROOT_WALK)
        .take_while(|dir| home.as_deref() != Some(*dir))
        .find(|dir| dir.join(".git").exists())
        .map(Path::to_path_buf)
}

/// The config file of the repository whose working tree is `root`: its
/// `.git/config`, or for a linked worktree, whose `.git` file names its git
/// folder, the config of the repository that folder belongs to.
fn git_config_file(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git.join("config"));
    }
    let pointer = read_small(&dot_git)?;
    let git_dir = root.join(pointer.lines().find_map(|line| line.strip_prefix("gitdir:"))?.trim());
    let common = read_small(&git_dir.join("commondir"))
        .map(|common| git_dir.join(common.trim()))
        .unwrap_or(git_dir);
    Some(common.join("config"))
}

/// The URLs of the remotes a git config file's text declares, in its order.
fn remote_urls(config: &str) -> Vec<String> {
    let mut in_remote = false;
    let mut urls = Vec::new();
    for line in config.lines().map(str::trim) {
        if let Some(section) = line.strip_prefix('[') {
            let name: String = section
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect();
            in_remote = name.eq_ignore_ascii_case("remote");
            continue;
        }
        if !in_remote || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let value = value.trim().trim_matches('"');
            if key.trim().eq_ignore_ascii_case("url") && !value.is_empty() {
                urls.push(value.to_string());
            }
        }
    }
    urls
}

/// A Git host's SSH alias replaced by the host it stands for, as the server's
/// `canonicalScmHostname` does, with Azure DevOps' SSH host.
fn canonical_host(host: &str) -> &str {
    match host {
        "ssh.github.com" => "github.com",
        "ssh.bitbucket.org" | "altssh.bitbucket.org" => "bitbucket.org",
        "ssh.dev.azure.com" => "dev.azure.com",
        other => other,
    }
}

/// A remote URL as `host/owner/repo` in lower case, whatever its form (https,
/// `ssh://`, `git@host:owner/repo`, with credentials, a port or a `.git`
/// suffix, Azure DevOps' `v3/` and `_git/` parts): two remotes of one
/// repository give the same key, and no credential is kept. `None` for a local
/// path, a host with no dot (an `insteadOf` shorthand such as `gh:`) or a URL
/// with no owner and repository.
pub(crate) fn repository_key(url: &str) -> Option<String> {
    let url = url.trim();
    let (host, path) = if let Some((scheme, rest)) = url.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        if !matches!(scheme.as_str(), "https" | "http" | "ssh" | "git" | "git+ssh" | "ssh+git") {
            return None;
        }
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
        (host.split(':').next().unwrap_or(host), path)
    } else {
        // `[user@]host:owner/repo`: nothing before the colon may hold a slash,
        // and a one-letter host is a Windows drive.
        let (before, path) = url.split_once(':')?;
        let host = before.rsplit_once('@').map_or(before, |(_, host)| host);
        if before.contains('/') || before.contains('\\') || host.len() < 2 {
            return None;
        }
        (host, path)
    };
    let host = host.to_ascii_lowercase();
    let host = canonical_host(&host);
    let path = path.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path).trim_end_matches('/');
    let path = if host == "dev.azure.com" {
        path.strip_prefix("v3/").unwrap_or(path).replacen("/_git/", "/", 1)
    } else {
        path.to_string()
    };
    if !host.contains('.') || !path.contains('/') {
        return None;
    }
    Some(format!("{host}/{path}"))
}

/// The repositories the remotes of the repository holding `folder` name, as `repository_key`s.
fn folder_repositories(folder: &Path) -> Vec<String> {
    let Some(config) = git_root(folder)
        .and_then(|root| git_config_file(&root))
        .and_then(|file| read_small(&file))
    else {
        return Vec::new();
    };
    let mut keys = Vec::new();
    for key in remote_urls(&config).iter().filter_map(|url| repository_key(url)) {
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

/// Folders below `folder` (not itself) holding a Playwright config, nearest
/// first: at most `MAX_DEPTH_BELOW` levels down, through no link, hidden
/// folder or `SKIPPED_FOLDERS`, examining at most `max_folders` folders. None
/// below a `guarded` folder.
fn config_folders_below(folder: &Path, max_folders: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if guarded(folder) {
        return found;
    }
    let mut level = vec![folder.to_path_buf()];
    let mut examined = 0;
    for _ in 0..MAX_DEPTH_BELOW {
        let mut next = Vec::new();
        for dir in &level {
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };
            let mut children: Vec<PathBuf> = entries
                .flatten()
                // The entry's own type: a link to a folder is not followed.
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .filter(|entry| {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    !name.starts_with('.') && !SKIPPED_FOLDERS.contains(&&*name)
                })
                .map(|entry| entry.path())
                .collect();
            children.sort();
            for child in children {
                if examined >= max_folders {
                    return found;
                }
                examined += 1;
                if find_config(&child).is_some() {
                    found.push(child.clone());
                }
                next.push(child);
            }
        }
        level = next;
    }
    found
}

/// Folders above `folder` holding a Playwright config, nearest first: up to
/// the root of its git repository, or `MAX_LEVELS_ABOVE_OUTSIDE_GIT` levels
/// when it is in none.
fn config_folders_above(folder: &Path) -> Vec<PathBuf> {
    let root = git_root(folder);
    if root.as_deref() == Some(folder) {
        return Vec::new();
    }
    let levels = if root.is_some() { MAX_LEVELS_ABOVE } else { MAX_LEVELS_ABOVE_OUTSIDE_GIT };
    let mut found = Vec::new();
    for dir in folder.ancestors().skip(1).take(levels) {
        if find_config(dir).is_some() {
            found.push(dir.to_path_buf());
        }
        if root.as_deref() == Some(dir) {
            break;
        }
    }
    found
}

fn candidate(path: &Path, specs: &[String], source: &'static str) -> Option<FolderCandidate> {
    Some(FolderCandidate {
        path: shown(path),
        playwright_config: find_config(path)?.to_string(),
        specs_found: specs_found(path, specs),
        source,
    })
}

/// The candidates once each, by path, at most `MAX_RESULTS`: those holding
/// some of the specs when any does, the most first; the order found breaks ties.
fn ranked(candidates: Vec<FolderCandidate>, specs_known: bool) -> Vec<FolderCandidate> {
    let any_holds_specs = candidates.iter().any(|c| c.specs_found > 0);
    let mut seen = HashSet::new();
    let mut kept: Vec<FolderCandidate> = candidates
        .into_iter()
        .filter(|c| !(specs_known && any_holds_specs) || c.specs_found > 0)
        .filter(|c| seen.insert(c.path.clone()))
        .collect();
    kept.sort_by_key(|c| std::cmp::Reverse(c.specs_found));
    kept.truncate(MAX_RESULTS);
    kept
}

/// Check `folder` for a project whose runs name `specs` (relative to the
/// config's folder) and, when known, come from `expected_repository` (a remote
/// URL in any form). When it does not fit, the folders above it (up to its
/// repository's root) and below it that hold a config are offered instead.
pub(crate) fn check_folder(folder: &Path, specs: &[String], expected_repository: Option<&str>) -> FolderCheck {
    let specs = checkable_specs(specs);
    if !folder.is_dir() {
        return FolderCheck {
            path: shown(folder),
            exists: false,
            playwright_config: None,
            specs_checked: specs.len(),
            specs_found: 0,
            missing_specs: Vec::new(),
            repository: None,
            same_repository: None,
            fits: false,
            alternatives: Vec::new(),
        };
    }
    let config = find_config(folder);
    let (found, missing): (Vec<&String>, Vec<&String>) =
        specs.iter().partition(|file| spec_in(folder, file) == Some(true));
    let repositories = folder_repositories(folder);
    let expected = expected_repository.and_then(repository_key);
    let same_repository = match (&expected, repositories.is_empty()) {
        (Some(expected), false) => Some(repositories.contains(expected)),
        _ => None,
    };
    let fits = config.is_some() && (specs.is_empty() || !found.is_empty());
    let alternatives = if fits {
        Vec::new()
    } else {
        let above = config_folders_above(folder);
        let below = config_folders_below(folder, MAX_FOLDERS_BELOW);
        let candidates = above
            .iter()
            .filter_map(|dir| candidate(dir, &specs, "above"))
            .chain(below.iter().filter_map(|dir| candidate(dir, &specs, "below")))
            .collect();
        ranked(candidates, !specs.is_empty())
    };
    FolderCheck {
        path: shown(folder),
        exists: true,
        playwright_config: config.map(str::to_string),
        specs_checked: specs.len(),
        specs_found: found.len(),
        missing_specs: missing.into_iter().take(MAX_MISSING_NAMED).cloned().collect(),
        repository: repositories.into_iter().next(),
        same_repository,
        fits,
        alternatives,
    }
}

/// The folder to link in place of `picked` when `picked` holds neither a
/// config nor any of `specs` (a repository's root, a folder of tests) and a
/// folder above or below it holds some of them: the one holding the most.
pub(crate) fn better_folder(picked: &Path, specs: &[String]) -> Option<PathBuf> {
    let check = check_folder(picked, specs, None);
    if !check.exists || check.playwright_config.is_some() || check.specs_found > 0 {
        return None;
    }
    check
        .alternatives
        .into_iter()
        .find(|alternative| alternative.specs_found > 0)
        .map(|alternative| PathBuf::from(alternative.path))
}

/// The folders holding the clones next to `linked`: the parent of each linked
/// folder's repository root, once each, in path order, never a `guarded` one.
fn clone_parents(linked: &[PathBuf]) -> Vec<PathBuf> {
    let mut parents: Vec<PathBuf> = Vec::new();
    for folder in linked {
        let root = git_root(folder).unwrap_or_else(|| folder.clone());
        if let Some(parent) = root.parent().filter(|parent| !guarded(parent)) {
            if !parents.iter().any(|known| known == parent) {
                parents.push(parent.to_path_buf());
            }
        }
    }
    parents.sort();
    parents.truncate(MAX_CLONE_PARENTS);
    parents
}

/// The folders directly in `parent` that are clones of the repository `key`
/// names, among the first `MAX_SIBLINGS` by name.
fn clones_in(parent: &Path, key: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut folders: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .map(|entry| entry.path())
        .collect();
    folders.sort();
    folders
        .into_iter()
        .filter(|path| path.is_dir())
        .take(MAX_SIBLINGS)
        .filter(|folder| folder.join(".git").exists())
        .filter(|folder| folder_repositories(folder).iter().any(|repository| repository == key))
        .collect()
}

/// The folders on this machine that fit a project, best first: the folders
/// its runs were reported from (`working_dirs`), then, when its repository is
/// known, the folders of the clones of that repository found next to the
/// folders already `linked`. A folder under one of `excluded` is never offered.
pub(crate) fn suggest_folders(
    working_dirs: &[String],
    linked: &[PathBuf],
    specs: &[String],
    expected_repository: Option<&str>,
    excluded: &[PathBuf],
) -> Vec<FolderCandidate> {
    let specs = checkable_specs(specs);
    let offered = |path: &Path| !excluded.iter().any(|root| path.starts_with(root)) && fits(path, &specs);
    let mut from_runs = Vec::new();
    for dir in working_dirs {
        let path = PathBuf::from(dir);
        if path.is_absolute() && path.is_dir() && offered(&path) {
            from_runs.extend(candidate(&path, &specs, "run"));
        }
    }
    let mut from_clones = Vec::new();
    if let Some(key) = expected_repository.and_then(repository_key) {
        let clones: Vec<PathBuf> = clone_parents(linked)
            .iter()
            .flat_map(|parent| clones_in(parent, &key))
            .take(MAX_CLONES)
            .collect();
        for clone in clones {
            let below = config_folders_below(&clone, MAX_FOLDERS_BELOW_CLONE);
            for path in std::iter::once(clone).chain(below) {
                if offered(&path) {
                    from_clones.extend(candidate(&path, &specs, "clone"));
                }
            }
        }
    }
    let specs_known = !specs.is_empty();
    let mut suggestions = ranked(from_runs, specs_known);
    for clone in ranked(from_clones, specs_known) {
        if !suggestions.iter().any(|known| known.path == clone.path) {
            suggestions.push(clone);
        }
    }
    suggestions.truncate(MAX_RESULTS);
    suggestions
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A temp folder removed when the test ends.
    struct Folder(PathBuf);

    impl Folder {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "piwi-folder-search-{label}-{}-{unique}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("create folder");
            Self(path)
        }

        /// Write a file at `relative`, creating the folders above it.
        fn write(&self, relative: &str, contents: &str) {
            let path = self.0.join(relative);
            std::fs::create_dir_all(path.parent().expect("a parent")).expect("create parents");
            std::fs::write(path, contents).expect("write file");
        }

        /// A git clone at `relative` whose `origin` is `remote`.
        fn clone_of(&self, relative: &str, remote: &str) {
            self.write(
                &format!("{relative}/.git/config"),
                &format!("[core]\n\tbare = false\n[remote \"origin\"]\n\turl = {remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n"),
            );
        }

        fn at(&self, relative: &str) -> PathBuf {
            self.0.join(relative)
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn specs(files: &[&str]) -> Vec<String> {
        files.iter().map(|f| f.to_string()).collect()
    }

    /// A monorepo whose Playwright config and specs live in `e2e/`.
    fn monorepo(root: &Folder) {
        root.clone_of("shop", "git@github.com:Acme/Shop.git");
        root.write("shop/package.json", "{}");
        root.write("shop/e2e/playwright.config.ts", "export default {}");
        root.write("shop/e2e/tests/cart.spec.ts", "");
        root.write("shop/e2e/tests/login.spec.ts", "");
    }

    #[test]
    fn the_config_folder_holding_the_specs_fits() {
        let root = Folder::new("fits");
        monorepo(&root);

        let check = check_folder(&root.at("shop/e2e"), &specs(&["tests/cart.spec.ts"]), None);

        assert!(check.fits);
        assert_eq!(check.playwright_config.as_deref(), Some("playwright.config.ts"));
        assert_eq!((check.specs_checked, check.specs_found), (1, 1));
        assert!(check.alternatives.is_empty());
    }

    #[test]
    fn the_repository_root_of_a_monorepo_offers_the_config_folder_below() {
        let root = Folder::new("below");
        monorepo(&root);

        let check = check_folder(
            &root.at("shop"),
            &specs(&["tests/cart.spec.ts", "tests/login.spec.ts", "tests/gone.spec.ts"]),
            None,
        );

        assert!(!check.fits);
        assert_eq!(check.playwright_config, None);
        assert_eq!(check.specs_found, 0);
        assert_eq!(check.missing_specs.len(), 3);
        assert_eq!(check.alternatives.len(), 1);
        let alternative = &check.alternatives[0];
        assert_eq!(alternative.path, shown(&root.at("shop/e2e")));
        assert_eq!((alternative.source, alternative.specs_found), ("below", 2));
    }

    #[test]
    fn a_folder_inside_the_config_folder_offers_the_one_above() {
        let root = Folder::new("above");
        monorepo(&root);

        let check = check_folder(&root.at("shop/e2e/tests"), &specs(&["tests/cart.spec.ts"]), None);

        assert!(!check.fits);
        assert_eq!(check.alternatives.len(), 1);
        assert_eq!(check.alternatives[0].path, shown(&root.at("shop/e2e")));
        assert_eq!(check.alternatives[0].source, "above");
    }

    #[test]
    fn the_search_above_stops_at_the_repository_root() {
        let root = Folder::new("stop");
        root.write("playwright.config.ts", "export default {}");
        root.clone_of("repo", "https://github.com/acme/shop");
        root.write("repo/app/index.ts", "");

        assert!(config_folders_above(&root.at("repo/app")).is_empty());
    }

    #[test]
    fn alternatives_holding_the_specs_come_before_the_others_and_only_they_are_kept() {
        let root = Folder::new("rank");
        root.clone_of("repo", "https://github.com/acme/shop");
        root.write("repo/apps/admin/playwright.config.ts", "");
        root.write("repo/apps/web/playwright.config.ts", "");
        root.write("repo/apps/web/tests/a.spec.ts", "");

        let check = check_folder(&root.at("repo"), &specs(&["tests/a.spec.ts"]), None);

        assert_eq!(
            check.alternatives.iter().map(|a| a.path.clone()).collect::<Vec<_>>(),
            vec![shown(&root.at("repo/apps/web"))]
        );
    }

    #[test]
    fn with_no_specs_every_config_folder_below_is_offered_nearest_first() {
        let root = Folder::new("nospecs");
        root.clone_of("repo", "https://github.com/acme/shop");
        root.write("repo/packages/web/e2e/playwright.config.js", "");
        root.write("repo/e2e/playwright.config.ts", "");

        let check = check_folder(&root.at("repo"), &[], None);

        assert_eq!(
            check.alternatives.iter().map(|a| a.path.clone()).collect::<Vec<_>>(),
            vec![shown(&root.at("repo/e2e")), shown(&root.at("repo/packages/web/e2e"))]
        );
        assert_eq!(check.alternatives[1].playwright_config, "playwright.config.js");
    }

    #[test]
    fn the_search_below_skips_dependencies_and_hidden_folders() {
        let root = Folder::new("skip");
        root.write("repo/node_modules/pkg/playwright.config.ts", "");
        root.write("repo/.cache/playwright.config.ts", "");

        assert!(config_folders_below(&root.at("repo"), MAX_FOLDERS_BELOW).is_empty());
    }

    #[test]
    fn the_search_below_examines_at_most_its_budget_of_folders() {
        let root = Folder::new("budget");
        for name in ["a", "b", "c"] {
            root.write(&format!("repo/{name}/playwright.config.ts"), "");
        }

        assert_eq!(config_folders_below(&root.at("repo"), 2), vec![root.at("repo/a"), root.at("repo/b")]);
    }

    #[test]
    fn only_test_files_are_checked_as_specs() {
        let root = Folder::new("ext");
        root.write("app/playwright.config.ts", "");
        root.write("app/notes.txt", "");

        let check = check_folder(&root.at("app"), &specs(&["notes.txt", "tests/a.spec.mts"]), None);

        assert_eq!((check.specs_checked, check.specs_found), (1, 0));
    }

    #[cfg(unix)]
    #[test]
    fn a_git_config_that_is_not_a_regular_file_is_not_read() {
        let root = Folder::new("device");
        std::fs::create_dir_all(root.at("repo/.git")).expect("create .git");
        std::os::unix::fs::symlink("/dev/zero", root.at("repo/.git/config")).expect("link the config");

        assert!(folder_repositories(&root.at("repo")).is_empty());
    }

    #[test]
    fn a_config_folder_without_any_of_the_specs_does_not_fit() {
        let root = Folder::new("nospec");
        root.write("app/playwright.config.ts", "");

        let check = check_folder(&root.at("app"), &specs(&["tests/a.spec.ts"]), None);

        assert!(!check.fits);
        assert_eq!(check.missing_specs, specs(&["tests/a.spec.ts"]));
    }

    #[test]
    fn a_missing_folder_does_not_exist_and_offers_nothing() {
        let root = Folder::new("gone");

        let check = check_folder(&root.at("nothing"), &specs(&["a.spec.ts"]), None);

        assert!(!check.exists && !check.fits);
        assert!(check.alternatives.is_empty());
    }

    #[test]
    fn spec_paths_read_either_separator_and_never_leave_the_folder() {
        let root = Folder::new("specs");
        root.write("tests/a.spec.ts", "");

        assert_eq!(spec_in(&root.0, "tests/a.spec.ts"), Some(true));
        assert_eq!(spec_in(&root.0, "tests\\a.spec.ts"), Some(true));
        assert_eq!(spec_in(&root.0, "./tests/a.spec.ts"), Some(true));
        assert_eq!(spec_in(&root.0, "tests/b.spec.ts"), Some(false));
        assert_eq!(spec_in(&root.0, "../tests/a.spec.ts"), None);
        assert_eq!(spec_in(&root.0, "/etc/hosts"), None);
        assert_eq!(spec_in(&root.0, ""), None);
    }

    #[test]
    fn repository_keys_match_whatever_the_remote_form() {
        let expected = Some("github.com/acme/shop".to_string());
        for remote in [
            "https://github.com/acme/shop",
            "https://github.com/Acme/Shop.git",
            "https://user:token@github.com/acme/shop/",
            "http://github.com:8080/acme/shop",
            "git@github.com:acme/shop.git",
            "ssh://git@ssh.github.com:443/acme/shop.git",
            "git://github.com/acme/shop",
        ] {
            assert_eq!(repository_key(remote), expected, "{remote}");
        }
        assert_eq!(
            repository_key("git@gitlab.example.com:group/sub/app.git").as_deref(),
            Some("gitlab.example.com/group/sub/app")
        );
        assert_eq!(repository_key("https://github.com/Acme/Shop.GIT").as_deref(), Some("github.com/acme/shop"));
    }

    #[test]
    fn azure_devops_remotes_match_over_ssh_and_https() {
        let expected = Some("dev.azure.com/acme/web/shop".to_string());
        assert_eq!(repository_key("git@ssh.dev.azure.com:v3/acme/web/shop"), expected);
        assert_eq!(repository_key("https://acme@dev.azure.com/acme/web/_git/shop"), expected);
        assert_eq!(repository_key("https://ssh.dev.azure.com/v3/acme/web/shop"), expected);
    }

    #[test]
    fn local_paths_and_bare_hosts_have_no_repository_key() {
        for remote in [
            "/srv/git/shop.git",
            "../shop",
            "C:\\repos\\shop",
            "file:///srv/shop",
            "https://github.com",
            "git@host.example:shop",
            "gh:acme/shop",
        ] {
            assert_eq!(repository_key(remote), None, "{remote}");
        }
    }

    #[test]
    fn every_remote_counts_so_a_fork_with_an_upstream_is_the_same_repository() {
        let root = Folder::new("fork");
        root.write(
            "fork/.git/config",
            "[remote \"origin\"]\n\turl = git@github.com:me/shop.git\n[remote \"upstream\"]\n\turl = https://github.com/acme/shop.git\n[branch \"main\"]\n\tremote = origin\n",
        );
        root.write("fork/playwright.config.ts", "");

        let check = check_folder(&root.at("fork"), &[], Some("https://github.com/acme/shop"));

        assert_eq!(check.repository.as_deref(), Some("github.com/me/shop"));
        assert_eq!(check.same_repository, Some(true));
        assert_eq!(check_folder(&root.at("fork"), &[], Some("https://github.com/acme/other")).same_repository, Some(false));
        assert_eq!(check_folder(&root.at("fork"), &[], None).same_repository, None);
    }

    #[test]
    fn a_linked_worktree_reads_the_remotes_of_its_repository() {
        let root = Folder::new("worktree");
        root.clone_of("main", "https://github.com/acme/shop");
        root.write("main/.git/worktrees/feature/commondir", "../..\n");
        root.write(
            "feature/.git",
            &format!("gitdir: {}\n", shown(&root.at("main/.git/worktrees/feature"))),
        );

        assert_eq!(folder_repositories(&root.at("feature")), vec!["github.com/acme/shop".to_string()]);
    }

    #[test]
    fn the_folders_runs_came_from_are_suggested_first_when_they_fit() {
        let root = Folder::new("runs");
        monorepo(&root);
        root.write("other/playwright.config.ts", "");

        let suggestions = suggest_folders(
            &[
                shown(&root.at("shop/e2e")),
                shown(&root.at("other")),
                "/home/runner/work/shop/shop/e2e".to_string(),
                "relative/e2e".to_string(),
            ],
            &[],
            &specs(&["tests/cart.spec.ts"]),
            None,
            &[],
        );

        assert_eq!(suggestions.len(), 1);
        assert_eq!((suggestions[0].path.clone(), suggestions[0].source), (shown(&root.at("shop/e2e")), "run"));
    }

    #[test]
    fn clones_of_the_repository_next_to_a_linked_folder_are_suggested() {
        let root = Folder::new("clones");
        monorepo(&root);
        root.clone_of("blog", "https://github.com/acme/blog");
        root.write("blog/playwright.config.ts", "");
        root.clone_of("unrelated", "https://github.com/acme/unrelated");
        root.write("unrelated/e2e/playwright.config.ts", "");
        root.write("unrelated/e2e/tests/cart.spec.ts", "");

        let suggestions = suggest_folders(
            &[],
            &[root.at("blog")],
            &specs(&["tests/cart.spec.ts"]),
            Some("https://github.com/acme/shop.git"),
            &[],
        );

        assert_eq!(suggestions.len(), 1);
        assert_eq!((suggestions[0].path.clone(), suggestions[0].source), (shown(&root.at("shop/e2e")), "clone"));
    }

    #[test]
    fn a_folder_under_an_excluded_root_is_never_suggested() {
        let root = Folder::new("excluded");
        monorepo(&root);

        let suggestions = suggest_folders(
            &[shown(&root.at("shop/e2e"))],
            &[root.at("shop")],
            &specs(&["tests/cart.spec.ts"]),
            Some("https://github.com/acme/shop"),
            std::slice::from_ref(&root.0),
        );

        assert!(suggestions.is_empty());
    }

    #[test]
    fn a_run_folder_is_offered_once_even_when_it_is_also_a_clone() {
        let root = Folder::new("once");
        monorepo(&root);

        let suggestions = suggest_folders(
            &[shown(&root.at("shop/e2e"))],
            &[root.at("shop")],
            &specs(&["tests/cart.spec.ts"]),
            Some("https://github.com/acme/shop"),
            &[],
        );

        assert_eq!(suggestions.iter().map(|s| s.source).collect::<Vec<_>>(), vec!["run"]);
    }

    #[test]
    fn the_better_folder_is_the_one_holding_the_specs() {
        let root = Folder::new("better");
        monorepo(&root);
        let cart = specs(&["tests/cart.spec.ts"]);

        assert_eq!(better_folder(&root.at("shop"), &cart), Some(root.at("shop/e2e")));
        assert_eq!(better_folder(&root.at("shop/e2e"), &cart), None);
        assert_eq!(better_folder(&root.at("shop"), &specs(&["tests/other.spec.ts"])), None);
    }

    #[test]
    fn a_folder_with_its_own_config_is_never_swapped_for_another() {
        let root = Folder::new("own-config");
        root.write("shop/playwright.config.ts", "");
        root.write("shop/examples/demo/playwright.config.ts", "");
        root.write("shop/examples/demo/tests/example.spec.ts", "");

        assert_eq!(better_folder(&root.at("shop"), &specs(&["tests/example.spec.ts"])), None);
    }
}
