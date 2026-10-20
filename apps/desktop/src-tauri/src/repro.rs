// Running a bug report's steps with Playwright, from a repro request.
//
// Piwi Picker posts a report's steps (never code) to the bundled server, which
// keeps the request until the developer confirms it in the window. The window
// then calls `desktop_run_repro`: the shell asks the server to render the steps
// as a spec with the project's settings, finds the project's test directory
// from Playwright itself, writes the spec to `<testDir>/piwi-repro/`, runs it
// with the linked folder's own Playwright, and deletes it when the run ends.
// The spec records its own outcome in a file the shell names, which comes back
// to the window as a `repro` event before the run's `exit`.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter as _, Manager as _};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt as _;

use crate::mcp_clients::ServerInfo;
use crate::node_path;
use crate::runner::{
    read_links, resolve_playwright_cli, validate_args, LocalRuns, RunEventPayload, RUN_EVENT,
};

/// The folder, under the project's test directory, repro specs are written to.
const REPRO_FOLDER: &str = "piwi-repro";

/// A request id as the server mints it: short lowercase hex.
pub(crate) fn valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Where the spec for `request_id` goes: `<testDir>/piwi-repro/bug-<id>.spec.ts`.
/// The test directory must be the linked folder or inside it, once both are
/// resolved, so a config cannot point the write anywhere else.
pub(crate) fn repro_spec_path(
    folder: &Path,
    test_dir: &Path,
    request_id: &str,
) -> Result<PathBuf, String> {
    if !valid_request_id(request_id) {
        return Err("invalid repro request id".into());
    }
    let folder = folder
        .canonicalize()
        .map_err(|_| "the linked folder no longer exists — pick it again".to_string())?;
    let test_dir = test_dir
        .canonicalize()
        .map_err(|_| "the project's test directory does not exist".to_string())?;
    if !test_dir.starts_with(&folder) {
        return Err("the project's test directory is outside the linked folder".into());
    }
    Ok(test_dir
        .join(REPRO_FOLDER)
        .join(format!("bug-{request_id}.spec.ts")))
}

/// The repository the linked folder is in: the nearest folder holding `.git`,
/// or the linked folder itself outside a repository. A project's bugs folder,
/// which its test import is written for, is relative to it.
fn repo_root(folder: &Path) -> PathBuf {
    folder
        .ancestors()
        .find(|dir| dir.join(".git").exists())
        .unwrap_or(folder)
        .to_path_buf()
}

/// The spec's folder relative to the repository root, with forward slashes,
/// for the server to write the project's test import from it.
fn spec_dir_in_repo(root: &Path, spec: &Path) -> Option<String> {
    let dir = spec.parent()?.strip_prefix(root).ok()?;
    let parts: Vec<String> = dir
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(parts.join("/"))
}

/// Percent-encodes a query value, keeping unreserved characters and `/`.
fn query_escape(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The file argument for `playwright test`, which reads each one as a regular
/// expression over the test file's path: the spec's own folder and name,
/// escaped, either separator. A raw path would not match on Windows (`\b` is a
/// word boundary) nor in a folder named with `(`, `+` or `[`.
fn repro_file_filter(request_id: &str) -> String {
    format!("{REPRO_FOLDER}[\\\\/]bug-{request_id}\\.spec\\.ts$")
}

/// The value given to `--project`, as `--project=x` or `--project x`.
fn project_flag(args: &[String]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if let Some(value) = arg.strip_prefix("--project=") {
            return Some(value.to_string());
        }
        if arg == "--project" {
            return iter.next().cloned();
        }
    }
    None
}

/// The test directory `playwright test --list --reporter=json` reports for the
/// named project, or for the first one. Output printed before the JSON (a
/// config that logs) is skipped.
pub(crate) fn test_dir_from_list(stdout: &str, project: Option<&str>) -> Option<PathBuf> {
    let start = stdout
        .find("\n{")
        .map(|i| i + 1)
        .or_else(|| stdout.starts_with('{').then_some(0))?;
    let report: serde_json::Value = serde_json::from_str(stdout[start..].trim()).ok()?;
    let projects = report.get("config")?.get("projects")?.as_array()?;
    let chosen = project
        .and_then(|name| {
            projects
                .iter()
                .find(|p| p.get("name").and_then(|n| n.as_str()) == Some(name))
        })
        .or_else(|| projects.first())?;
    chosen.get("testDir")?.as_str().map(PathBuf::from)
}

/// The body of a plain HTTP/1.0 response, when its status is 200. Otherwise
/// the error names the status, and the server's own message when its body
/// carries one.
pub(crate) fn http_body(response: &[u8]) -> Result<&[u8], String> {
    let split = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("the local server sent an incomplete response")?;
    let head = String::from_utf8_lossy(&response[..split]);
    let status = head.lines().next().unwrap_or_default();
    if !status.contains(" 200 ") {
        let message = serde_json::from_slice::<serde_json::Value>(&response[split + 4..])
            .ok()
            .and_then(|body| {
                body.get("message")
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
            })
            .filter(|m| !m.is_empty());
        return Err(match message {
            Some(message) => message,
            None => format!("the local server answered {}", status.trim()),
        });
    }
    Ok(&response[split + 4..])
}

/// GET a JSON document from the bundled server, with the app's token. `path`
/// is built by the caller from validated parts only.
pub(crate) fn local_get_json(server: &ServerInfo, path: &str) -> Result<serde_json::Value, String> {
    use std::io::{Read, Write};
    let mut stream =
        std::net::TcpStream::connect(("127.0.0.1", server.port)).map_err(|e| e.to_string())?;
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(60)));
    let request = format!(
        "GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nx-piwi-token: {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        server.port, server.token
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(http_body(&response)?)
        .map_err(|_| "the local server sent something other than JSON".to_string())
}

/// A new directory for one run's verdict file: a random name under the temp
/// dir, created fresh (never one that already exists) and, on Unix, open to the
/// user only, so another local user can neither predict the file nor plant one.
fn private_run_dir(prefix: &str) -> std::io::Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("{prefix}{}", crate::random_hex_32()));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(&dir)?;
    Ok(dir)
}

/// Ask the bundled server for the request's spec, rendered for the project.
fn fetch_spec(
    server: &ServerInfo,
    request_id: &str,
    project_id: &str,
    spec_dir: Option<&str>,
) -> Result<String, String> {
    use std::io::{Read, Write};
    if !crate::runner::valid_project_id(project_id) {
        return Err("invalid project id".into());
    }
    let mut stream =
        std::net::TcpStream::connect(("127.0.0.1", server.port)).map_err(|e| e.to_string())?;
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));
    let dir = spec_dir
        .map(|d| format!("&specDir={}", query_escape(d)))
        .unwrap_or_default();
    let request = format!(
        "GET /api/desktop/repro-requests/{request_id}/spec?projectId={project_id}{dir} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nx-piwi-token: {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        server.port, server.token
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|e| e.to_string())?;
    let body: serde_json::Value = serde_json::from_slice(http_body(&response)?)
        .map_err(|_| "the local server sent no spec".to_string())?;
    body.get("code")
        .and_then(|c| c.as_str())
        .map(str::to_string)
        .ok_or_else(|| "the local server sent no spec".into())
}

/// Remove the spec, then its folder when nothing else is left in it.
pub(crate) fn remove_spec(spec: &Path) {
    let _ = std::fs::remove_file(spec);
    if let Some(dir) = spec.parent() {
        let _ = std::fs::remove_dir(dir); // fails, as it should, when not empty
    }
}

/// Run a confirmed repro request in the project's linked folder. Returns a run
/// id; output arrives as `piwi:local-run` events, then a `repro` event carrying
/// what the spec recorded (`{ status, line, message }`, or null when it
/// recorded nothing), then `exit`. `args` go through the same flag allowlist
/// as any local run. The test runs as a reproduction, referencing the bug
/// report it came from when `bug_report_id` names one, else `origin_ref`.
#[tauri::command]
pub async fn desktop_run_repro(
    app: AppHandle,
    project_id: String,
    request_id: String,
    args: Vec<String>,
    bug_report_id: Option<u64>,
    origin_ref: Option<String>,
) -> Result<u32, String> {
    validate_args(&args)?;
    let origin = crate::worktree::origin_env(
        "reproduce",
        crate::worktree::origin_reference(bug_report_id, origin_ref)?.as_deref(),
    );
    // Flags only, values joined with `=`: the spec is the one file the run takes.
    if args.iter().any(|a| !a.starts_with('-')) {
        return Err("a repro run takes flags only".into());
    }
    if !valid_request_id(&request_id) {
        return Err("invalid repro request id".into());
    }
    let folder = read_links(&app)
        .get(&project_id)
        .map(|r| PathBuf::from(&r.path))
        .ok_or("no folder is linked to this project")?;
    if !folder.is_dir() {
        return Err("the linked folder no longer exists — pick it again".into());
    }
    let cli = resolve_playwright_cli(&folder).ok_or(
        "no Playwright installation found in the linked folder (or its parents) — run your package manager's install first",
    )?;

    let listed = app
        .shell()
        .sidecar("node")
        .map_err(|e| e.to_string())?
        .args([
            node_path(&cli),
            "test".into(),
            "--list".into(),
            "--reporter=json".into(),
        ])
        .current_dir(&folder)
        .env("NO_COLOR", "1")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&listed.stdout);
    let test_dir = test_dir_from_list(&stdout, project_flag(&args).as_deref())
        .ok_or("Playwright did not report the project's test directory")?;
    let spec = repro_spec_path(&folder, &test_dir, &request_id)?;
    let spec_dir = folder
        .canonicalize()
        .ok()
        .and_then(|linked| spec_dir_in_repo(&repo_root(&linked), &spec));

    let code = {
        let server = app.state::<ServerInfo>();
        let (port, token) = (server.port, server.token.clone());
        let id = request_id.clone();
        let pid = project_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            fetch_spec(&ServerInfo { port, token }, &id, &pid, spec_dir.as_deref())
        })
        .await
        .map_err(|e| e.to_string())??
    };

    let mut cmd_args: Vec<String> = vec![
        node_path(&cli),
        "test".into(),
        repro_file_filter(&request_id),
    ];
    cmd_args.extend(args);
    let sidecar = app.shell().sidecar("node").map_err(|e| e.to_string())?;

    let state = app.state::<LocalRuns>();
    let id = state.allocate_id();
    std::fs::create_dir_all(spec.parent().expect("the spec has a folder"))
        .map_err(|e| e.to_string())?;
    state.track_spec(id, spec.clone());
    let result_dir = match std::fs::write(&spec, code).and_then(|()| private_run_dir("piwi-repro-")) {
        Ok(dir) => dir,
        Err(e) => {
            state.remove_spec(id);
            return Err(e.to_string());
        }
    };
    let result_file = result_dir.join("result.json");
    let command = sidecar
        .args(cmd_args)
        .current_dir(&folder)
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env(
            "PIWI_REPRO_RESULT",
            result_file.to_string_lossy().to_string(),
        )
        .envs(origin);
    let spawned = command.spawn();
    let (mut rx, child) = match spawned {
        Ok(pair) => pair,
        Err(e) => {
            state.remove_spec(id);
            let _ = std::fs::remove_dir_all(&result_dir);
            return Err(e.to_string());
        }
    };
    state.track_child(id, child);

    let emit_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let payload = match event {
                CommandEvent::Stdout(line) => RunEventPayload::line(
                    id,
                    "stdout",
                    String::from_utf8_lossy(&line).trim_end().to_string(),
                ),
                CommandEvent::Stderr(line) => RunEventPayload::line(
                    id,
                    "stderr",
                    String::from_utf8_lossy(&line).trim_end().to_string(),
                ),
                CommandEvent::Error(err) => RunEventPayload::line(id, "error", err),
                CommandEvent::Terminated(status) => {
                    if let Some(runs) = emit_app.try_state::<LocalRuns>() {
                        runs.forget_child(id);
                        runs.remove_spec(id);
                    }
                    let recorded = std::fs::read(&result_file)
                        .ok()
                        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
                    let _ = std::fs::remove_dir_all(&result_dir);
                    let _ = emit_app.emit(RUN_EVENT, &RunEventPayload::repro(id, recorded));
                    RunEventPayload::exit(id, status.code)
                }
                _ => continue,
            };
            let _ = emit_app.emit(RUN_EVENT, &payload);
        }
    });

    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Component;

    #[test]
    fn each_run_gets_a_new_private_verdict_dir() {
        let a = private_run_dir("piwi-repro-test-").expect("create a run dir");
        let b = private_run_dir("piwi-repro-test-").expect("create another run dir");
        assert_ne!(a, b);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&a).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
        }
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    /// A linked folder holding `tests/`, removed when the test ends.
    struct Checkout(PathBuf);

    impl Checkout {
        fn new(label: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("piwi-repro-{label}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(path.join("tests")).expect("create checkout");
            Self(path)
        }
    }

    impl Drop for Checkout {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writes_the_spec_under_the_test_directory() {
        let checkout = Checkout::new("inside");
        let spec = repro_spec_path(&checkout.0, &checkout.0.join("tests"), "a1b2").expect("a path");
        let tests = checkout.0.join("tests").canonicalize().unwrap();
        assert_eq!(spec, tests.join("piwi-repro").join("bug-a1b2.spec.ts"));
    }

    #[test]
    fn refuses_a_test_directory_outside_the_linked_folder() {
        let checkout = Checkout::new("outside");
        let elsewhere = Checkout::new("elsewhere");
        assert!(repro_spec_path(&checkout.0, &elsewhere.0.join("tests"), "a1b2").is_err());
        assert!(repro_spec_path(&checkout.0.join("tests"), &checkout.0, "a1b2").is_err());
    }

    #[test]
    fn refuses_a_test_directory_that_climbs_out_through_dot_dot() {
        let checkout = Checkout::new("climb");
        let climbing = checkout.0.join("tests").join("..").join("..");
        assert!(climbing
            .components()
            .any(|c| matches!(c, Component::ParentDir)));
        assert!(repro_spec_path(&checkout.0, &climbing, "a1b2").is_err());
    }

    #[test]
    fn refuses_a_request_id_that_is_not_a_plain_id() {
        let checkout = Checkout::new("ids");
        let tests = checkout.0.join("tests");
        for id in ["", "../x", "a/b", "A1", "x.spec", &"a".repeat(33)] {
            assert!(
                repro_spec_path(&checkout.0, &tests, id).is_err(),
                "{id} should be refused"
            );
        }
    }

    #[test]
    fn reads_the_test_directory_of_the_named_project() {
        let out = r#"loading config
{"config":{"projects":[{"name":"chromium","testDir":"/repo/e2e"},{"name":"api","testDir":"/repo/api"}]},"suites":[]}"#;
        assert_eq!(
            test_dir_from_list(out, Some("api")),
            Some(PathBuf::from("/repo/api"))
        );
        assert_eq!(
            test_dir_from_list(out, None),
            Some(PathBuf::from("/repo/e2e"))
        );
        assert_eq!(
            test_dir_from_list(out, Some("missing")),
            Some(PathBuf::from("/repo/e2e"))
        );
        assert_eq!(test_dir_from_list("Error: no config", None), None);
    }

    #[test]
    fn reads_the_project_flag_in_both_forms() {
        assert_eq!(
            project_flag(&["--headed".into(), "--project=api".into()]),
            Some("api".into())
        );
        assert_eq!(
            project_flag(&["--project".into(), "web".into()]),
            Some("web".into())
        );
        assert_eq!(project_flag(&["--trace=on".into()]), None);
    }

    #[test]
    fn reads_only_a_successful_response_body() {
        assert_eq!(
            http_body(b"HTTP/1.1 200 OK\r\nA: b\r\n\r\n{\"code\":1}").unwrap(),
            b"{\"code\":1}"
        );
        assert!(http_body(b"HTTP/1.1 404 Not Found\r\n\r\n{}").is_err());
        assert_eq!(
            http_body(b"HTTP/1.1 409 Conflict\r\n\r\n{\"message\":\"nothing reproduced\"}"),
            Err("nothing reproduced".to_string())
        );
        assert_eq!(
            http_body(b"HTTP/1.1 404 Not Found\r\n\r\n{}"),
            Err("the local server answered HTTP/1.1 404 Not Found".to_string())
        );
        assert!(http_body(b"HTTP/1.1 200 OK").is_err());
    }

    #[test]
    fn finds_the_repository_the_linked_folder_is_in() {
        let checkout = Checkout::new("repo");
        let app = checkout.0.join("apps").join("web");
        std::fs::create_dir_all(&app).unwrap();
        assert_eq!(repo_root(&app), app);
        std::fs::create_dir_all(checkout.0.join(".git")).unwrap();
        assert_eq!(repo_root(&app), checkout.0);
    }

    #[test]
    fn names_the_spec_folder_from_the_repository_root() {
        let root = Path::new("/repo");
        let spec = root.join("e2e").join("piwi-repro").join("bug-a1.spec.ts");
        assert_eq!(
            spec_dir_in_repo(root, &spec).as_deref(),
            Some("e2e/piwi-repro")
        );
        assert_eq!(spec_dir_in_repo(Path::new("/elsewhere"), &spec), None);
    }

    #[test]
    fn escapes_a_query_value() {
        assert_eq!(query_escape("e2e/piwi-repro"), "e2e/piwi-repro");
        assert_eq!(query_escape("my tests/(x)&y"), "my%20tests/%28x%29%26y");
    }

    #[test]
    fn filters_the_run_to_the_spec_with_an_escaped_pattern() {
        assert_eq!(
            repro_file_filter("a1b2"),
            r"piwi-repro[\\/]bug-a1b2\.spec\.ts$"
        );
    }

    #[test]
    fn removes_the_spec_and_its_folder_once_empty() {
        let checkout = Checkout::new("cleanup");
        let spec = repro_spec_path(&checkout.0, &checkout.0.join("tests"), "c3").unwrap();
        std::fs::create_dir_all(spec.parent().unwrap()).unwrap();
        std::fs::write(&spec, "").unwrap();
        remove_spec(&spec);
        assert!(!spec.parent().unwrap().exists());

        let kept = spec.parent().unwrap().join("mine.spec.ts");
        std::fs::create_dir_all(spec.parent().unwrap()).unwrap();
        std::fs::write(&spec, "").unwrap();
        std::fs::write(&kept, "").unwrap();
        remove_spec(&spec);
        assert!(kept.exists());
    }
}
