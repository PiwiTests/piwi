// Read-only inspection of a folder on this machine, so the dashboard can tell
// what a checkout is before creating or linking a Piwi project to it: the name
// it would report under, whether Playwright is present, and whether the
// `@piwitests/reporter` package is installed and wired into the config.
//
// The heuristics deliberately mirror the reporter CLI's own `detect.ts`
// (`packages/reporter/src/cli/detect.ts`): same config-file lookup order, same
// name suggestion (unscoped package name, then folder name).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::folder_search::find_config;
use crate::runner::{resolve_node_module, resolve_playwright_cli};

const REPORTER_PACKAGE: &str = "@piwitests/reporter";

/// Upper bound on how much of a config file is read; a Playwright config
/// larger than this is not a config file.
const MAX_CONFIG_BYTES: u64 = 512 * 1024;

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInspection {
    /// The absolute folder that was inspected.
    path: String,
    /// The folder is a directory on disk. Everything below is `None`/`false`
    /// when it is not.
    exists: bool,
    /// `package.json` `name` as written (scope kept), when present.
    package_name: Option<String>,
    /// The Piwi project name this folder would report under: the config's
    /// `projectName`, else the unscoped package name, else the folder's name.
    suggested_name: Option<String>,
    /// File name of the Playwright config found at the folder root.
    playwright_config: Option<String>,
    /// A Playwright installation resolves from the folder (own or hoisted).
    playwright_installed: bool,
    /// `@piwitests/reporter` resolves from the folder or is a declared dependency.
    reporter_installed: bool,
    /// The Playwright config references `@piwitests/reporter`.
    reporter_configured: bool,
    /// `projectName` value parsed out of the Playwright config, when set.
    configured_project_name: Option<String>,
    /// The config sets `projectName` with an expression (`` `shop-${tenant}` ``), whose value only a run knows: it
    /// may read the project's run variables.
    project_name_computed: bool,
    /// The Playwright config declares a `webServer` — Playwright starts the app
    /// under test itself, so a reproduction/bisect exercises the real app.
    web_server: bool,
}

/// Whether the config source declares a `webServer` block. A `webServer:` key
/// (any whitespace before the colon), the shape Playwright requires — enough to
/// tell "Playwright starts the app" from "the tests target an external URL"
/// without parsing the config.
fn has_web_server(source: &str) -> bool {
    let bytes = source.as_bytes();
    let mut from = 0;
    while let Some(found) = source[from..].find("webServer") {
        let mut i = from + found + "webServer".len();
        from = i;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < bytes.len() && bytes[i] == b':' {
            return true;
        }
    }
    false
}

#[derive(Default, serde::Deserialize)]
struct PackageJson {
    name: Option<String>,
    #[serde(default)]
    dependencies: HashMap<String, String>,
    #[serde(default, rename = "devDependencies")]
    dev_dependencies: HashMap<String, String>,
}

fn read_package_json(folder: &Path) -> Option<PackageJson> {
    let raw = std::fs::read_to_string(folder.join("package.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

/// The config's contents, or `None` when there is no config or it is
/// unreadable/oversized — in which case nothing can be said about it.
fn read_config(folder: &Path, config: Option<&str>) -> Option<String> {
    let path = folder.join(config?);
    let size = std::fs::metadata(&path).ok()?.len();
    if size > MAX_CONFIG_BYTES {
        return None;
    }
    std::fs::read_to_string(&path).ok()
}

/// How a config source sets `projectName`.
#[derive(Debug, PartialEq)]
enum ConfigProjectName {
    /// A plain single-line literal: `projectName: 'web'`.
    Literal(String),
    /// An expression whose value only a run knows: a template with `${…}`, a concatenation, a variable. It may read
    /// the project's run variables.
    Computed,
    /// No `projectName` key.
    Unset,
}

/// How the config source sets `projectName`: the first key written as a plain literal, else whether a key is written
/// with an expression. A key is `projectName` (bare or quoted) followed by `:`, not part of a longer name nor on a
/// `//` comment line.
fn config_project_name(source: &str) -> ConfigProjectName {
    let bytes = source.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'$');
    let skip_space = |mut i: usize| {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        i
    };
    let mut computed = false;
    let mut from = 0;
    while let Some(found) = source[from..].find("projectName") {
        let start = from + found;
        let mut i = start + "projectName".len();
        from = i;
        let before = start.checked_sub(1).map(|at| bytes[at]);
        let quoted = matches!(before, Some(b'\'' | b'"')) && before == bytes.get(i).copied();
        if quoted {
            i += 1;
        } else if before.is_some_and(|b| word(b) || b == b'.') || bytes.get(i).is_some_and(|&b| word(b)) {
            continue;
        }
        let line_start = source[..start].rfind('\n').map_or(0, |at| at + 1);
        if source[line_start..start].trim_start().starts_with("//") {
            continue;
        }
        i = skip_space(i);
        if bytes.get(i) != Some(&b':') {
            continue;
        }
        i = skip_space(i + 1);
        let Some(&quote) = bytes.get(i).filter(|b| matches!(b, b'\'' | b'"' | b'`')) else {
            computed = true;
            continue;
        };
        let value_start = i + 1;
        let Some(length) = source[value_start..].find(quote as char) else {
            computed = true;
            continue;
        };
        let value = &source[value_start..value_start + length];
        let after = skip_space(value_start + length + 1);
        let ends = after >= bytes.len() || matches!(bytes[after], b',' | b'}' | b')' | b']' | b';');
        if ends && !value.is_empty() && !value.contains('\n') && !value.contains("${") {
            return ConfigProjectName::Literal(value.to_string());
        }
        computed = true;
    }
    if computed {
        ConfigProjectName::Computed
    } else {
        ConfigProjectName::Unset
    }
}

/// The `projectName` the config writes as a plain literal, when it does: what the tests read of a source.
#[cfg(test)]
fn parse_config_project_name(source: &str) -> Option<String> {
    match config_project_name(source) {
        ConfigProjectName::Literal(name) => Some(name),
        _ => None,
    }
}

/// Unscoped, filesystem-safe name: `@acme/checkout` → `checkout`.
fn unscoped(name: &str) -> &str {
    match name.strip_prefix('@') {
        Some(rest) => rest.split_once('/').map_or(name, |(_, tail)| tail),
        None => name,
    }
}

fn inspect(folder: &Path) -> FolderInspection {
    let path = folder.to_string_lossy().to_string();
    if !folder.is_dir() {
        return FolderInspection {
            path,
            exists: false,
            package_name: None,
            suggested_name: None,
            playwright_config: None,
            playwright_installed: false,
            reporter_installed: false,
            reporter_configured: false,
            configured_project_name: None,
            project_name_computed: false,
            web_server: false,
        };
    }

    let package = read_package_json(folder);
    let config = find_config(folder);
    let config_source = read_config(folder, config);
    let project_name = config_source.as_deref().map_or(ConfigProjectName::Unset, config_project_name);
    let project_name_computed = project_name == ConfigProjectName::Computed;
    let configured_project_name = match project_name {
        ConfigProjectName::Literal(name) => Some(name),
        _ => None,
    };

    let package_name = package.as_ref().and_then(|p| p.name.clone());
    let dependency_declared = package.as_ref().is_some_and(|p| {
        p.dependencies.contains_key(REPORTER_PACKAGE)
            || p.dev_dependencies.contains_key(REPORTER_PACKAGE)
    });

    let suggested_name = configured_project_name
        .clone()
        .or_else(|| {
            package_name
                .as_deref()
                .map(unscoped)
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            folder
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .filter(|n| !n.is_empty())
        });

    FolderInspection {
        path,
        exists: true,
        package_name,
        suggested_name,
        playwright_config: config.map(str::to_string),
        playwright_installed: resolve_playwright_cli(folder).is_some(),
        reporter_installed: dependency_declared
            || resolve_node_module(folder, &["@piwitests/reporter/package.json"]).is_some(),
        reporter_configured: config_source
            .as_deref()
            .is_some_and(|s| s.contains(REPORTER_PACKAGE)),
        configured_project_name,
        project_name_computed,
        web_server: config_source.as_deref().is_some_and(has_web_server),
    }
}

/// What a folder on this machine looks like to Piwi: the project name it would
/// report under and whether Playwright and the Piwi reporter are set up. A
/// folder that is gone reports `exists: false` rather than an error, so the
/// dashboard can render the state.
#[tauri::command]
pub fn desktop_inspect_folder(path: String) -> Result<FolderInspection, String> {
    let folder = PathBuf::from(&path);
    if !folder.is_absolute() {
        return Err("the folder path must be absolute".into());
    }
    Ok(inspect(&folder))
}

/// Playwright's default blob-report output folder (the reports the import page
/// consumes — each `.zip` is a complete run).
const REPORTS_DIR: &str = "blob-report";
/// Playwright's default test output folder (`outputDir`), where per-test traces
/// are written — each `trace.zip` is one execution.
const RESULTS_DIR: &str = "test-results";

/// Upper bound on how many archives a scan returns, so a checkout with an
/// enormous results tree cannot produce an unbounded list.
const MAX_ARCHIVES: usize = 500;

/// How deep the results tree is walked for trace files. Playwright nests one
/// directory per test under `test-results/`; a few extra levels cover retries
/// and grouped output without walking an entire repository.
const MAX_RESULTS_DEPTH: usize = 6;

/// One importable Playwright archive on disk: a blob report or a trace `.zip`.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalArchive {
    /// Absolute path to the `.zip`.
    pub path: String,
    /// File name (basename), for display.
    pub name: String,
    /// Size in bytes.
    pub size: u64,
    /// `"blob"` when found under `blob-report/`, `"trace"` when found under
    /// `test-results/`; `None` for a file the user picked by hand, whose kind
    /// the server decides when it opens it.
    pub kind: Option<&'static str>,
}

/// Build a `LocalArchive` for a file path, reading its size (0 when unreadable).
pub fn local_archive(path: &Path, kind: Option<&'static str>) -> LocalArchive {
    LocalArchive {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        size: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        kind,
    }
}

/// Blob reports (`*.zip`) directly inside `blob-report/`, sorted by name.
fn collect_blob_reports(dir: &Path, out: &mut Vec<LocalArchive>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut found: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.path())
        .filter(|p| is_zip(p))
        .collect();
    found.sort();
    for path in found {
        if out.len() >= MAX_ARCHIVES {
            return;
        }
        out.push(local_archive(&path, Some("blob")));
    }
}

/// Trace files (`trace*.zip`) anywhere under `test-results/`, walked to a
/// bounded depth. Symlinks are not followed, so a cyclic tree cannot loop.
fn collect_traces(dir: &Path, depth: usize, out: &mut Vec<LocalArchive>) {
    if depth > MAX_RESULTS_DEPTH || out.len() >= MAX_ARCHIVES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = Vec::new();
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            dirs.push(path);
        } else if file_type.is_file() && is_trace_zip(&path) {
            files.push(path);
        }
    }
    files.sort();
    dirs.sort();
    for path in files {
        if out.len() >= MAX_ARCHIVES {
            return;
        }
        out.push(local_archive(&path, Some("trace")));
    }
    for path in dirs {
        collect_traces(&path, depth + 1, out);
    }
}

fn is_zip(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
}

/// A Playwright trace file: `trace.zip`, or a numbered `trace-1.zip`.
fn is_trace_zip(path: &Path) -> bool {
    is_zip(path)
        && path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("trace"))
}

/// Importable archives left in a checkout by previous Playwright runs: blob
/// reports under `blob-report/` (whole runs) and trace files under
/// `test-results/` (single executions). Blob reports come first. A folder that
/// is gone, or that has neither sub-folder, yields an empty list rather than an
/// error, so the dashboard can simply skip proposing an import.
#[tauri::command]
pub fn desktop_find_importable_runs(path: String) -> Result<Vec<LocalArchive>, String> {
    let folder = PathBuf::from(&path);
    if !folder.is_absolute() {
        return Err("the folder path must be absolute".into());
    }
    let mut out = Vec::new();
    if folder.is_dir() {
        collect_blob_reports(&folder.join(REPORTS_DIR), &mut out);
        collect_traces(&folder.join(RESULTS_DIR), 0, &mut out);
    }
    Ok(out)
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
                "piwi-inspect-{label}-{}-{unique}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("create folder");
            Self(path)
        }

        fn write(&self, name: &str, contents: &str) {
            std::fs::write(self.0.join(name), contents).expect("write file");
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_missing_folder_reports_not_existing() {
        let folder = Folder::new("gone");
        let missing = folder.0.join("not-there");

        let result = inspect(&missing);

        assert!(!result.exists);
        assert_eq!(result.suggested_name, None);
        assert_eq!(result.path, missing.to_string_lossy());
    }

    #[test]
    fn an_empty_folder_suggests_its_own_name() {
        let folder = Folder::new("bare");

        let result = inspect(&folder.0);

        assert!(result.exists);
        assert_eq!(result.package_name, None);
        assert_eq!(
            result.suggested_name.as_deref(),
            folder.0.file_name().map(|n| n.to_str().unwrap()),
        );
        assert_eq!(result.playwright_config, None);
        assert!(!result.playwright_installed);
        assert!(!result.reporter_installed);
        assert!(!result.reporter_configured);
    }

    #[test]
    fn the_package_name_wins_over_the_folder_name_and_loses_its_scope() {
        let folder = Folder::new("named");
        folder.write("package.json", r#"{ "name": "@acme/checkout" }"#);

        let result = inspect(&folder.0);

        assert_eq!(result.package_name.as_deref(), Some("@acme/checkout"));
        assert_eq!(result.suggested_name.as_deref(), Some("checkout"));
    }

    #[test]
    fn the_configured_project_name_wins_over_the_package_name() {
        let folder = Folder::new("configured-name");
        folder.write("package.json", r#"{ "name": "checkout" }"#);
        folder.write(
            "playwright.config.ts",
            "export default defineConfig(wrapConfig({\n  reporter: [['@piwitests/reporter', { projectName: 'web-app' }]],\n}));\n",
        );

        let result = inspect(&folder.0);

        assert_eq!(result.configured_project_name.as_deref(), Some("web-app"));
        assert_eq!(result.suggested_name.as_deref(), Some("web-app"));
        assert!(result.reporter_configured);
    }

    #[test]
    fn finds_the_config_in_playwrights_lookup_order() {
        let folder = Folder::new("config-order");
        folder.write("playwright.config.js", "module.exports = {};\n");
        folder.write("playwright.config.ts", "export default {};\n");

        let result = inspect(&folder.0);

        assert_eq!(
            result.playwright_config.as_deref(),
            Some("playwright.config.ts")
        );
        assert!(!result.reporter_configured);
    }

    #[test]
    fn a_declared_reporter_dependency_counts_as_installed() {
        let folder = Folder::new("dependency");
        folder.write(
            "package.json",
            r#"{ "name": "app", "devDependencies": { "@piwitests/reporter": "^1.0.0" } }"#,
        );

        let result = inspect(&folder.0);

        assert!(result.reporter_installed);
        assert!(!result.reporter_configured);
    }

    #[test]
    fn a_reporter_in_node_modules_counts_as_installed() {
        let folder = Folder::new("node-modules");
        let package = folder
            .0
            .join("node_modules")
            .join("@piwitests")
            .join("reporter");
        std::fs::create_dir_all(&package).expect("create package");
        std::fs::write(package.join("package.json"), "{}").expect("write package.json");

        let result = inspect(&folder.0);

        assert!(result.reporter_installed);
    }

    #[test]
    fn detects_a_playwright_installation() {
        let folder = Folder::new("playwright");
        let package = folder
            .0
            .join("node_modules")
            .join("@playwright")
            .join("test");
        std::fs::create_dir_all(&package).expect("create package");
        std::fs::write(package.join("cli.js"), "").expect("write cli");

        let result = inspect(&folder.0);

        assert!(result.playwright_installed);
    }

    #[test]
    fn a_project_name_the_config_computes_is_told_apart_from_none() {
        use ConfigProjectName::{Computed, Literal, Unset};
        for computed in [
            "wrapConfig(defineConfig({}), { projectName: `shop-${process.env.TENANT}` })",
            "wrapConfig(c, { projectName: 'shop-' + process.env.TENANT })",
            "reporter: [['@piwitests/reporter', { projectName: process.env.PROJECT }]]",
            "wrapConfig(c, { 'projectName': `shop-${tenant}` })",
            "// projectName: 'shop',\nwrapConfig(c, { projectName: `shop-${t}` })",
        ] {
            assert_eq!(config_project_name(computed), Computed, "{computed}");
        }
        for unset in [
            "export default defineConfig({ use: { baseURL } })",
            "const piwiProjectName = 'x'; options.projectNameFallback;",
            "use: { baseURL: `https://${projectName}.test` }",
            "const { projectName, baseURL } = tenantSettings(); f(projectName, x);",
            "// projectName: 'shop',",
        ] {
            assert_eq!(config_project_name(unset), Unset, "{unset}");
        }
        assert_eq!(config_project_name("{ projectName: 'web', }"), Literal("web".into()));
        assert_eq!(config_project_name("{ \"projectName\": \"web\" }"), Literal("web".into()));
    }

    #[test]
    fn parses_the_project_name_literal_in_any_quote_style() {
        for (label, source) in [
            (
                "single",
                "reporter: [['@piwitests/reporter', { projectName: 'web' }]]",
            ),
            (
                "double",
                "reporter: [[\"@piwitests/reporter\", { projectName: \"web\" }]]",
            ),
            (
                "backtick",
                "reporter: [['@piwitests/reporter', { projectName: `web` }]]",
            ),
            ("spaced", "projectName  :   'web'"),
        ] {
            assert_eq!(
                parse_config_project_name(source).as_deref(),
                Some("web"),
                "quote style: {label}",
            );
        }
    }

    #[test]
    fn skips_project_names_that_are_not_literals() {
        assert_eq!(
            parse_config_project_name("projectName: process.env.NAME"),
            None
        );
        assert_eq!(parse_config_project_name("projectName: `app-${env}`"), None);
        assert_eq!(parse_config_project_name("projectName: ''"), None);
        assert_eq!(
            parse_config_project_name("const projectNameHint = 1;"),
            None
        );
    }

    #[test]
    fn a_later_literal_is_found_after_a_non_literal_mention() {
        let source = "// projectName comes from the package\nprojectName: 'real-name'";
        assert_eq!(
            parse_config_project_name(source).as_deref(),
            Some("real-name")
        );
    }

    #[test]
    fn detects_a_web_server_block() {
        let folder = Folder::new("web-server");
        folder.write(
            "playwright.config.ts",
            "export default defineConfig({\n  webServer: { command: 'npm run dev', url: 'http://localhost:3000' },\n});\n",
        );

        let result = inspect(&folder.0);
        assert!(result.web_server);
    }

    #[test]
    fn no_web_server_when_the_config_has_none() {
        let folder = Folder::new("no-web-server");
        folder.write(
            "playwright.config.ts",
            "export default defineConfig({ retries: 2 });\n",
        );

        let result = inspect(&folder.0);
        assert!(!result.web_server);
    }

    #[test]
    fn web_server_detection_ignores_a_mention_that_is_not_a_key() {
        assert!(has_web_server("webServer: {}"));
        assert!(has_web_server("  webServer : { command: 'x' }"));
        assert!(!has_web_server("// configure your webServer here"));
        assert!(!has_web_server("const webServerHint = 1;"));
    }

    #[test]
    fn unscoped_strips_only_a_leading_scope() {
        assert_eq!(unscoped("@acme/checkout"), "checkout");
        assert_eq!(unscoped("checkout"), "checkout");
        assert_eq!(unscoped("@malformed"), "@malformed");
    }

    impl Folder {
        /// Create (nested) directories under the folder and write a file at the end.
        fn write_nested(&self, relative: &str, contents: &str) {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("create parents");
            }
            std::fs::write(path, contents).expect("write file");
        }
    }

    fn scan(folder: &Path) -> Vec<LocalArchive> {
        let mut out = Vec::new();
        collect_blob_reports(&folder.join(REPORTS_DIR), &mut out);
        collect_traces(&folder.join(RESULTS_DIR), 0, &mut out);
        out
    }

    #[test]
    fn a_folder_with_no_report_or_results_folders_has_nothing_to_import() {
        let folder = Folder::new("no-runs");
        folder.write("package.json", r#"{ "name": "app" }"#);

        assert_eq!(scan(&folder.0), Vec::new());
    }

    #[test]
    fn finds_blob_reports_and_traces_with_blob_reports_first() {
        let folder = Folder::new("importable");
        folder.write_nested("blob-report/report-1.zip", "blob one");
        folder.write_nested("blob-report/report-2.zip", "blob two");
        folder.write_nested("test-results/checkout-chromium/trace.zip", "trace one");
        folder.write_nested(
            "test-results/checkout-chromium-retry1/trace.zip",
            "trace two",
        );

        let found = scan(&folder.0);

        let names: Vec<&str> = found.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(
            names,
            ["report-1.zip", "report-2.zip", "trace.zip", "trace.zip"]
        );
        let kinds: Vec<Option<&str>> = found.iter().map(|a| a.kind).collect();
        assert_eq!(
            kinds,
            [Some("blob"), Some("blob"), Some("trace"), Some("trace")]
        );
        // Every path is absolute and carries the file's byte size.
        assert!(found.iter().all(|a| Path::new(&a.path).is_absolute()));
        assert!(found.iter().all(|a| a.size > 0));
    }

    #[test]
    fn ignores_non_zip_evidence_and_non_trace_zips() {
        let folder = Folder::new("mixed-results");
        folder.write_nested("test-results/a-chromium/trace.zip", "trace");
        folder.write_nested("test-results/a-chromium/test-failed-1.png", "png");
        folder.write_nested("test-results/a-chromium/video.webm", "webm");
        folder.write_nested("test-results/a-chromium/attachment.zip", "not a trace");

        let found = scan(&folder.0);

        let names: Vec<&str> = found.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["trace.zip"]);
    }

    #[test]
    fn the_command_requires_an_absolute_path() {
        assert!(desktop_find_importable_runs("relative/path".into()).is_err());
    }
}
