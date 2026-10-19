// Local test execution for linked project folders.
//
// A Piwi project can be linked to a folder on this machine — the checkout that
// produces its test runs. The link is what makes "run these tests locally"
// possible: the shell resolves that folder's own Playwright installation and
// executes it with the bundled Node sidecar, streaming output back to the
// dashboard webview as events. Results reach the dashboard the same way any
// local run does: the project's Playwright config already reports to Piwi, and
// the reporter discovers this app via `~/.piwi/desktop.json`.
//
// Links live in the shell's own store (`settings.json`), not the server
// database — a folder path is a fact about this machine, not about the project.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;
use tauri::{AppHandle, Emitter as _, Manager as _};
use tauri_plugin_dialog::DialogExt as _;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt as _;
use tauri_plugin_store::StoreExt as _;

use crate::inspect::{local_archive, LocalArchive};
use crate::{node_path, STORE_FILE};

/// Store key holding the `{ project id → link record }` map.
const PROJECT_LINKS_KEY: &str = "projectLinks";

/// Event channel every local run reports on; the payload carries the run id so
/// the webview can tell concurrent runs apart.
pub(crate) const RUN_EVENT: &str = "piwi:local-run";

/// How many ancestors of the linked folder to search for a `node_modules`
/// containing Playwright — covers monorepos with hoisted installs.
const MAX_NODE_MODULES_WALK: usize = 12;

/// `playwright test` flags the dashboard may pass. Anything else dash-like is
/// rejected, so the webview cannot redirect config, output or reporters.
const ALLOWED_FLAGS: [&str; 12] = [
    "--headed",
    "--debug",
    "--ui",
    "--trace",
    "--repeat-each",
    "--project",
    "--grep",
    "--workers",
    "--retries",
    "--max-failures",
    "--timeout",
    "--last-failed",
];

/// The child a reproduce/bisect job is running right now. A pid rather than a
/// handle so the same stop path reaches a Tauri sidecar child and a plain
/// `npm`/`git` child alike, together with the process tree each spawned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JobChild {
    pub pid: u32,
    /// A Node process (the test, or a browser install) that winds down on
    /// Ctrl+C; a git or package-manager step is killed at once.
    pub interruptible: bool,
}

/// A long-running reproduce/bisect job: its stop flag, the child currently
/// spawned (checkout / install / browser / test), and how to tear the
/// throwaway worktree down. The job owns the worktree for its life.
pub struct Job {
    pub stop: Arc<AtomicBool>,
    pub child: Arc<Mutex<Option<JobChild>>>,
    pub cleanup: crate::worktree::Cleanup,
    pub cleaned: Arc<std::sync::atomic::AtomicBool>,
}

/// How long the runs still going when the app quits get to wind down after a
/// Ctrl+C before their process trees are killed.
const QUIT_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// Running local processes, keyed by run id so the webview can stop one. Plain
/// test runs live in `children`; reproduce/bisect drivers live in `jobs` because
/// they also own a worktree that must be removed when they stop or the app quits.
#[derive(Default)]
pub struct LocalRuns {
    next_id: AtomicU32,
    children: Mutex<HashMap<u32, CommandChild>>,
    /// Plain runs already asked to stop gracefully — a second stop kills them.
    stopping: Mutex<HashSet<u32>>,
    jobs: Mutex<HashMap<u32, Job>>,
    /// Reproduction specs written into a linked folder, by run id: removed when
    /// their run ends, or when the app quits.
    specs: Mutex<HashMap<u32, PathBuf>>,
}

impl LocalRuns {
    /// How many local processes are running — plain runs plus reproduce/bisect
    /// jobs. Each drops out of its map as soon as it finishes.
    pub fn active_count(&self) -> usize {
        self.children.lock().unwrap().len() + self.jobs.lock().unwrap().len()
    }

    /// Allocate the next run id.
    pub(crate) fn allocate_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Register a reproduce/bisect job so it can be stopped and cleaned up.
    pub(crate) fn register_job(&self, id: u32, job: Job) {
        self.jobs.lock().unwrap().insert(id, job);
    }

    /// Remove a job from tracking once its driver has finished with it.
    pub(crate) fn drop_job(&self, id: u32) {
        self.jobs.lock().unwrap().remove(&id);
    }

    /// Record (or clear) the child currently running for a job, so a stop or
    /// app-quit reaches exactly what is live.
    pub(crate) fn set_job_child(&self, id: u32, child: Option<JobChild>) {
        if let Some(job) = self.jobs.lock().unwrap().get(&id) {
            *job.child.lock().unwrap() = child;
        }
    }

    /// Track a spawned run's process so it can be stopped like any local run.
    pub(crate) fn track_child(&self, id: u32, child: CommandChild) {
        self.children.lock().unwrap().insert(id, child);
    }

    /// Forget a run spawned outside this module once its process has exited.
    pub(crate) fn forget_child(&self, id: u32) {
        self.drop_child(id);
    }

    /// Record a reproduction spec run `id` wrote into a linked folder.
    pub(crate) fn track_spec(&self, id: u32, spec: PathBuf) {
        self.specs.lock().unwrap().insert(id, spec);
    }

    /// Remove run `id`'s reproduction spec, if it still has one.
    pub(crate) fn remove_spec(&self, id: u32) {
        if let Some(spec) = self.specs.lock().unwrap().remove(&id) {
            crate::repro::remove_spec(&spec);
        }
    }

    /// Forget a plain run once its process has exited.
    fn drop_child(&self, id: u32) {
        self.children.lock().unwrap().remove(&id);
        self.stopping.lock().unwrap().remove(&id);
    }

    /// Kill a plain run's process tree now, if it is still running.
    fn kill_child(&self, id: u32) {
        let child = self.children.lock().unwrap().remove(&id);
        self.stopping.lock().unwrap().remove(&id);
        if let Some(child) = child {
            crate::worktree::kill_child_tree(child.pid());
            let _ = child.kill();
        }
    }

    /// Kill a job's current child tree now, if it is still the one running.
    fn kill_job_child(&self, id: u32, pid: u32) {
        if let Some(job) = self.jobs.lock().unwrap().get(&id) {
            if job.child.lock().unwrap().is_some_and(|c| c.pid == pid) {
                crate::worktree::kill_child_tree(pid);
            }
        }
    }

    /// Stop every process still tracked, tear down every worktree and remove
    /// every reproduction spec — called when the app exits so no orphaned test
    /// run, webServer, browser fleet, worktree or spec outlives the shell.
    ///
    /// Each test run is first asked to stop as Ctrl+C would, so Playwright
    /// closes its webServer and browsers itself; whatever still runs
    /// `QUIT_GRACE` later is killed with its process tree.
    pub fn kill_all(&self) {
        let mut interrupted = false;
        for child in self.children.lock().unwrap().values() {
            interrupted |= crate::interrupt::interrupt(child.pid());
        }
        for job in self.jobs.lock().unwrap().values() {
            job.stop.store(true, Ordering::SeqCst);
            if let Some(child) = job.child.lock().unwrap().filter(|c| c.interruptible) {
                interrupted |= crate::interrupt::interrupt(child.pid);
            }
        }
        if interrupted {
            let deadline = std::time::Instant::now() + QUIT_GRACE;
            while self.any_test_running() && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
        for (_, child) in self.children.lock().unwrap().drain() {
            crate::worktree::kill_child_tree(child.pid());
            let _ = child.kill();
        }
        self.stopping.lock().unwrap().clear();
        for (_, job) in self.jobs.lock().unwrap().drain() {
            if let Some(child) = *job.child.lock().unwrap() {
                crate::worktree::kill_child_tree(child.pid);
            }
            crate::worktree::perform_cleanup(&job.cleanup, &job.cleaned);
        }
        for (_, spec) in self.specs.lock().unwrap().drain() {
            crate::repro::remove_spec(&spec);
        }
    }

    /// Whether a plain run, or a job's test or browser install, is still running.
    fn any_test_running(&self) -> bool {
        !self.children.lock().unwrap().is_empty()
            || self
                .jobs
                .lock()
                .unwrap()
                .values()
                .any(|job| job.child.lock().unwrap().is_some_and(|c| c.interruptible))
    }
}

/// A project's linked folder plus an optional start command (and readiness URL)
/// for reproduce/bisect steps when the Playwright config has no `webServer`.
/// The command is stored only: no reproduce, bisect or lab driver runs it.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinkRecord {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readiness_url: Option<String>,
}

/// Links written by older builds stored a bare path string; accept either shape
/// so upgrading never drops an existing folder link.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum StoredLink {
    Path(String),
    Record(LinkRecord),
}

impl From<StoredLink> for LinkRecord {
    fn from(stored: StoredLink) -> Self {
        match stored {
            StoredLink::Path(path) => LinkRecord {
                path,
                start_command: None,
                readiness_url: None,
            },
            StoredLink::Record(record) => record,
        }
    }
}

pub(crate) fn read_links(app: &AppHandle) -> HashMap<String, LinkRecord> {
    let raw: HashMap<String, StoredLink> = app
        .store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(PROJECT_LINKS_KEY))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    raw.into_iter().map(|(k, v)| (k, v.into())).collect()
}

fn write_links(app: &AppHandle, links: &HashMap<String, LinkRecord>) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(PROJECT_LINKS_KEY, json!(links));
    store.save().map_err(|e| e.to_string())?;
    // Editors read the links from the discovery file to pick their project.
    crate::refresh_discovery_file(app);
    Ok(())
}

/// The linked folder for a project, when one is set and still on disk. Used by
/// the reproduce/bisect drivers to resolve the repository to work against.
pub(crate) fn linked_folder(app: &AppHandle, project_id: &str) -> Option<LinkRecord> {
    read_links(app).remove(project_id)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLink {
    path: String,
    exists: bool,
    start_command: Option<String>,
    readiness_url: Option<String>,
}

/// Native folder picker. Returns `None` when the user cancels.
#[tauri::command]
pub async fn desktop_pick_folder(app: AppHandle) -> Option<String> {
    let dialog = app.dialog().file();
    // The blocking picker must not run on the IPC/async worker it was called
    // from — park it on a blocking thread and await the result.
    tauri::async_runtime::spawn_blocking(move || {
        dialog
            .blocking_pick_folder()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

/// Native multi-select picker for import archives, filtered to `.zip`. Opens at
/// `default_path` when it is an existing directory — the linked project folder,
/// so the import page's picker starts where the reports are. Returns an empty
/// list when the user cancels.
#[tauri::command]
pub async fn desktop_pick_import_files(
    app: AppHandle,
    default_path: Option<String>,
) -> Vec<LocalArchive> {
    let mut dialog = app
        .dialog()
        .file()
        .add_filter("Playwright archives", &["zip"]);
    if let Some(dir) = default_path {
        let path = PathBuf::from(&dir);
        if path.is_dir() {
            dialog = dialog.set_directory(path);
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        dialog
            .blocking_pick_files()
            .into_iter()
            .flatten()
            .filter_map(|f| f.into_path().ok())
            // The kind is unknown for a hand-picked file — the server decides
            // when it opens the archive.
            .map(|p| local_archive(&p, None))
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Whether `project_id` is a Piwi project id: digits only. The webview names a
/// project by it, and it becomes a folder name under the worktrees dir, so
/// nothing else is accepted.
pub(crate) fn valid_project_id(project_id: &str) -> bool {
    !project_id.is_empty()
        && project_id.len() <= 20
        && project_id.bytes().all(|b| b.is_ascii_digit())
}

#[tauri::command]
pub fn desktop_get_project_link(app: AppHandle, project_id: String) -> Option<ProjectLink> {
    read_links(&app).get(&project_id).map(|r| ProjectLink {
        exists: Path::new(&r.path).is_dir(),
        path: r.path.clone(),
        start_command: r.start_command.clone(),
        readiness_url: r.readiness_url.clone(),
    })
}

/// Set (`path: Some`) or clear (`path: None`) the folder linked to a project. A
/// re-link to the same folder keeps its start command; a different folder starts
/// fresh.
#[tauri::command]
pub fn desktop_set_project_link(
    app: AppHandle,
    project_id: String,
    path: Option<String>,
) -> Result<(), String> {
    if !valid_project_id(&project_id) {
        return Err("invalid project id".into());
    }
    let mut links = read_links(&app);
    match path {
        Some(p) => {
            let folder = PathBuf::from(&p);
            if !folder.is_absolute() {
                return Err("the folder path must be absolute".into());
            }
            if !folder.is_dir() {
                return Err("the folder does not exist".into());
            }
            let previous = links.get(&project_id);
            let keep = previous.filter(|r| r.path == p);
            links.insert(
                project_id,
                LinkRecord {
                    path: p,
                    start_command: keep.and_then(|r| r.start_command.clone()),
                    readiness_url: keep.and_then(|r| r.readiness_url.clone()),
                },
            );
        }
        None => {
            links.remove(&project_id);
        }
    }
    write_links(&app, &links)
}

/// Store (or clear) the start command for reproduce/bisect steps when the
/// Playwright config has no `webServer`, and the URL to poll until the app
/// answers. Requires a linked folder. Stored only: no driver reads either value.
#[tauri::command]
pub fn desktop_set_project_start_command(
    app: AppHandle,
    project_id: String,
    start_command: Option<String>,
    readiness_url: Option<String>,
) -> Result<(), String> {
    let mut links = read_links(&app);
    let record = links
        .get_mut(&project_id)
        .ok_or("no folder is linked to this project")?;
    record.start_command = start_command
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    record.readiness_url = readiness_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    write_links(&app, &links)
}

#[derive(serde::Serialize)]
pub struct SpecCheck {
    folder: String,
    missing: Vec<String>,
}

/// The given spec paths that are absent from `folder`, in the order given and
/// without repeats.
///
/// A path that is absolute, or that climbs out of the folder, is skipped
/// rather than reported: it says nothing about whether the right folder is
/// linked, and the answer here only ever drives a warning.
fn missing_specs(folder: &Path, files: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut missing = Vec::new();
    for file in files {
        let relative = Path::new(file);
        if relative.is_absolute()
            || relative
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            continue;
        }
        if !seen.insert(file.as_str()) {
            continue;
        }
        if !folder.join(relative).is_file() {
            missing.push(file.clone());
        }
    }
    missing
}

/// Which of a run's spec files the linked folder does not contain — the cheap
/// way to catch a project linked to the wrong checkout before spawning a run
/// whose failure would surface as a module-resolution stack trace.
#[tauri::command]
pub fn desktop_check_local_specs(
    app: AppHandle,
    project_id: String,
    files: Vec<String>,
) -> Result<SpecCheck, String> {
    let folder = read_links(&app)
        .get(&project_id)
        .map(|r| PathBuf::from(&r.path))
        .ok_or("no folder is linked to this project")?;
    if !folder.is_dir() {
        return Err("the linked folder no longer exists — pick it again".into());
    }
    Ok(SpecCheck {
        missing: missing_specs(&folder, &files),
        folder: folder.to_string_lossy().to_string(),
    })
}

/// Resolve a file inside a `node_modules` reachable from `start`, walking up so
/// a package inside a monorepo with a hoisted root `node_modules` still
/// resolves. `candidates` are `node_modules`-relative paths tried at each level.
pub(crate) fn resolve_node_module(start: &Path, candidates: &[&str]) -> Option<PathBuf> {
    let mut dir = Some(start);
    for _ in 0..MAX_NODE_MODULES_WALK {
        let d = dir?;
        for candidate in candidates {
            let p = d.join("node_modules").join(candidate);
            if p.is_file() {
                return Some(p);
            }
        }
        dir = d.parent();
    }
    None
}

/// Find the linked folder's own Playwright CLI entry.
pub(crate) fn resolve_playwright_cli(start: &Path) -> Option<PathBuf> {
    resolve_node_module(start, &["@playwright/test/cli.js", "playwright/cli.js"])
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEnvCheck {
    folder: String,
    exists: bool,
    /// Absolute path of the Playwright CLI entry the run would use, when found.
    playwright_cli: Option<String>,
}

/// What a local run would find at `folder`: whether the folder is still on disk,
/// and which Playwright CLI it would execute. A folder that is gone reports no
/// CLI — its ancestors say nothing about a checkout that is not there.
fn local_env(folder: &Path) -> LocalEnvCheck {
    let exists = folder.is_dir();
    LocalEnvCheck {
        folder: folder.to_string_lossy().to_string(),
        exists,
        playwright_cli: exists
            .then(|| resolve_playwright_cli(folder))
            .flatten()
            .map(|p| p.to_string_lossy().to_string()),
    }
}

/// Whether a local run could start at all: the linked folder is still there and
/// holds a Playwright installation. A missing folder or a missing Playwright is
/// reported rather than raised, so the dashboard can show the state before
/// anyone asks for a run.
#[tauri::command]
pub fn desktop_check_local_env(
    app: AppHandle,
    project_id: String,
) -> Result<LocalEnvCheck, String> {
    let folder = read_links(&app)
        .get(&project_id)
        .map(|r| PathBuf::from(&r.path))
        .ok_or("no folder is linked to this project")?;
    Ok(local_env(&folder))
}

pub(crate) fn validate_args(args: &[String]) -> Result<(), String> {
    for arg in args {
        if arg.contains('\0') {
            return Err("invalid argument".into());
        }
        if arg.starts_with('-') {
            let flag = arg.split('=').next().unwrap_or(arg);
            if !ALLOWED_FLAGS.contains(&flag) {
                return Err(format!("flag not allowed: {flag}"));
            }
        }
    }
    Ok(())
}

/// A `piwi:local-run` event. `kind` selects which of the optional fields carries
/// the payload: `stdout`/`stderr`/`error` use `line`, `exit` uses `code`, `phase`
/// uses `phase` (a reproduce/bisect step header), `bisect` uses `bisect`, and
/// `repro` uses `repro` (what a repro spec recorded about its run).
#[derive(Clone, serde::Serialize)]
pub(crate) struct RunEventPayload {
    pub id: u32,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bisect: Option<crate::worktree::BisectEvent>,
    /// For `repro`: the spec's recorded outcome, `null` when it recorded none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repro: Option<serde_json::Value>,
    /// For `lab`: the report `piwi flake --json` printed, `null` when it printed none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lab: Option<serde_json::Value>,
}

impl RunEventPayload {
    pub(crate) fn line(id: u32, kind: &'static str, text: String) -> Self {
        Self {
            id,
            kind,
            line: Some(text),
            code: None,
            phase: None,
            bisect: None,
            repro: None,
            lab: None,
        }
    }
    pub(crate) fn exit(id: u32, code: Option<i32>) -> Self {
        Self {
            id,
            kind: "exit",
            line: None,
            code,
            phase: None,
            bisect: None,
            repro: None,
            lab: None,
        }
    }
    pub(crate) fn phase(id: u32, phase: &str) -> Self {
        Self {
            id,
            kind: "phase",
            line: None,
            code: None,
            phase: Some(phase.to_string()),
            bisect: None,
            repro: None,
            lab: None,
        }
    }
    pub(crate) fn bisect(id: u32, event: crate::worktree::BisectEvent) -> Self {
        Self {
            id,
            kind: "bisect",
            line: None,
            code: None,
            phase: None,
            bisect: Some(event),
            repro: None,
            lab: None,
        }
    }
    pub(crate) fn repro(id: u32, recorded: Option<serde_json::Value>) -> Self {
        Self {
            id,
            kind: "repro",
            line: None,
            code: None,
            phase: None,
            bisect: None,
            repro: Some(recorded.unwrap_or(serde_json::Value::Null)),
            lab: None,
        }
    }
    pub(crate) fn lab(id: u32, report: Option<serde_json::Value>) -> Self {
        Self {
            id,
            kind: "lab",
            line: None,
            code: None,
            phase: None,
            bisect: None,
            repro: None,
            lab: Some(report.unwrap_or(serde_json::Value::Null)),
        }
    }
}

/// Run `playwright test <args>` for `project_id`, using the bundled Node sidecar
/// and the run folder's own Playwright package. Returns a run id; progress
/// arrives as `piwi:local-run` events carrying that id.
///
/// The default run folder is the linked checkout. A `cwd` may point the run at a
/// throwaway worktree instead — the reproduce/bisect drivers use this — but only
/// one that canonicalizes inside this app's worktrees dir, so the webview can
/// never redirect a run at an arbitrary folder.
#[tauri::command]
pub async fn desktop_run_local_tests(
    app: AppHandle,
    project_id: String,
    args: Vec<String>,
    cwd: Option<String>,
    origin_ref: Option<String>,
) -> Result<u32, String> {
    validate_args(&args)?;
    let origin = crate::worktree::origin_env(
        "desktop",
        crate::worktree::origin_reference(None, origin_ref)?.as_deref(),
    );

    let folder = match cwd {
        Some(dir) => crate::worktree::validate_worktree_cwd(&app, &dir)?,
        None => {
            let f = read_links(&app)
                .get(&project_id)
                .map(|r| PathBuf::from(&r.path))
                .ok_or("no folder is linked to this project")?;
            if !f.is_dir() {
                return Err("the linked folder no longer exists — pick it again".into());
            }
            f
        }
    };
    let cli = resolve_playwright_cli(&folder).ok_or(
        "no Playwright installation found in the linked folder (or its parents) — run your package manager's install first",
    )?;

    let mut cmd_args: Vec<String> = vec![node_path(&cli), "test".into()];
    cmd_args.extend(args);

    let command = app
        .shell()
        .sidecar("node")
        .map_err(|e| e.to_string())?
        .args(cmd_args)
        .current_dir(folder)
        // Plain text for the in-app output pane.
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .envs(origin);

    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;

    let state = app.state::<LocalRuns>();
    let id = state.allocate_id();
    state.children.lock().unwrap().insert(id, child);

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
                        runs.drop_child(id);
                    }
                    RunEventPayload::exit(id, status.code)
                }
                _ => continue,
            };
            let _ = emit_app.emit(RUN_EVENT, &payload);
        }
    });

    Ok(id)
}

/// Stop a running local process as Ctrl+C would in a terminal (see
/// `interrupt.rs`): Playwright stops its workers and the reporter still sends
/// the run's end. A process still running `STOP_GRACE` later — or asked to stop
/// a second time, or one that cannot be interrupted — is killed with its process
/// tree (the test may have spawned browsers or a webServer).
///
/// For a reproduce/bisect job the stop flag is raised first, so its driver
/// starts no further step once the current child exits, then resets any bisect
/// and removes the worktree. A run that already exited is a no-op.
#[tauri::command]
pub async fn desktop_stop_local_tests(app: AppHandle, run_id: u32) -> Result<(), String> {
    let state = app.state::<LocalRuns>();
    let job = state.jobs.lock().unwrap().get(&run_id).map(|job| {
        (
            job.stop.swap(true, Ordering::SeqCst),
            *job.child.lock().unwrap(),
        )
    });
    if let Some((already_stopping, child)) = job {
        let Some(child) = child else {
            return Ok(());
        };
        if already_stopping || !child.interruptible || !crate::interrupt::interrupt(child.pid) {
            state.kill_job_child(run_id, child.pid);
        } else {
            after_grace(&app, move |runs| runs.kill_job_child(run_id, child.pid));
        }
        return Ok(());
    }

    let pid = state.children.lock().unwrap().get(&run_id).map(|c| c.pid());
    let Some(pid) = pid else {
        return Ok(());
    };
    let already_stopping = !state.stopping.lock().unwrap().insert(run_id);
    if already_stopping || !crate::interrupt::interrupt(pid) {
        state.kill_child(run_id);
    } else {
        after_grace(&app, move |runs| runs.kill_child(run_id));
    }
    Ok(())
}

/// Run `force` once `STOP_GRACE` has passed — on a plain thread, since the wait
/// must not hold up the async runtime.
fn after_grace(app: &AppHandle, force: impl FnOnce(&LocalRuns) + Send + 'static) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(crate::interrupt::STOP_GRACE);
        if let Some(runs) = app.try_state::<LocalRuns>() {
            force(&runs);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quitting_removes_the_reproduction_specs_still_on_disk() {
        let dir = std::env::temp_dir().join(format!("piwi-quit-spec-{}", std::process::id()));
        let specs = dir.join("tests").join("piwi-repro");
        std::fs::create_dir_all(&specs).unwrap();
        let spec = specs.join("piwi-repro-abc.spec.ts");
        std::fs::write(&spec, "").unwrap();

        let runs = LocalRuns::default();
        runs.track_spec(1, spec.clone());
        runs.kill_all();
        assert!(!spec.exists());
        assert!(!specs.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_project_id_is_digits_only() {
        assert!(valid_project_id("1"));
        assert!(valid_project_id("4021"));
        for bad in ["", "../../etc", "1/2", "1.0", "-1", " 1", "abc", &"9".repeat(21)] {
            assert!(!valid_project_id(bad), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn nothing_is_running_before_a_run_starts() {
        assert_eq!(LocalRuns::default().active_count(), 0);
    }

    /// A folder holding `tests/a.spec.ts`, removed when the test ends.
    struct Checkout(PathBuf);

    impl Checkout {
        fn new(label: &str) -> Self {
            use std::sync::atomic::AtomicU32;
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir()
                .join(format!("piwi-run-{label}-{}-{unique}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(path.join("tests")).expect("create checkout");
            std::fs::write(path.join("tests").join("a.spec.ts"), "").expect("write spec");
            Self(path)
        }
    }

    impl Drop for Checkout {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reports_only_the_specs_the_folder_does_not_hold() {
        let checkout = Checkout::new("partial");

        let missing = missing_specs(
            &checkout.0,
            &["tests/a.spec.ts".into(), "tests/example.spec.ts".into()],
        );

        assert_eq!(missing, vec!["tests/example.spec.ts".to_string()]);
    }

    #[test]
    fn reports_nothing_when_every_spec_is_present() {
        let checkout = Checkout::new("complete");
        assert!(missing_specs(&checkout.0, &["tests/a.spec.ts".into()]).is_empty());
    }

    #[test]
    fn reports_each_missing_spec_once() {
        let checkout = Checkout::new("dupes");

        let missing = missing_specs(
            &checkout.0,
            &["tests/gone.spec.ts".into(), "tests/gone.spec.ts".into()],
        );

        assert_eq!(missing, vec!["tests/gone.spec.ts".to_string()]);
    }

    #[test]
    fn skips_paths_that_cannot_be_judged_against_the_folder() {
        let checkout = Checkout::new("outside");

        let missing = missing_specs(
            &checkout.0,
            &["../elsewhere/b.spec.ts".into(), "/abs/c.spec.ts".into()],
        );

        assert!(missing.is_empty());
    }

    #[test]
    fn directories_do_not_count_as_specs() {
        let checkout = Checkout::new("dir");
        assert_eq!(
            missing_specs(&checkout.0, &["tests".into()]),
            vec!["tests".to_string()]
        );
    }

    /// Put a Playwright package in this folder's own `node_modules`.
    fn install_playwright(dir: &Path) {
        let package = dir.join("node_modules").join("@playwright").join("test");
        std::fs::create_dir_all(&package).expect("create playwright package");
        std::fs::write(package.join("cli.js"), "").expect("write cli");
    }

    /// Where `install_playwright` leaves the CLI, in the form the check reports.
    fn installed_cli(dir: &Path) -> String {
        dir.join("node_modules")
            .join("@playwright")
            .join("test")
            .join("cli.js")
            .to_string_lossy()
            .to_string()
    }

    #[test]
    fn finds_the_playwright_installed_in_the_folder() {
        let checkout = Checkout::new("env-installed");
        install_playwright(&checkout.0);

        let env = local_env(&checkout.0);

        assert!(env.exists);
        assert_eq!(env.playwright_cli, Some(installed_cli(&checkout.0)));
    }

    #[test]
    fn finds_a_playwright_hoisted_to_a_parent_folder() {
        let root = Checkout::new("env-hoisted");
        install_playwright(&root.0);
        let package = root.0.join("packages").join("web");
        std::fs::create_dir_all(&package).expect("create package folder");

        let env = local_env(&package);

        assert!(env.exists);
        assert_eq!(env.playwright_cli, Some(installed_cli(&root.0)));
    }

    #[test]
    fn reports_no_cli_when_the_folder_has_no_playwright() {
        let checkout = Checkout::new("env-bare");

        let env = local_env(&checkout.0);

        assert!(env.exists);
        assert_eq!(env.playwright_cli, None);
    }

    #[test]
    fn reports_a_folder_that_is_not_on_disk() {
        let checkout = Checkout::new("env-missing");
        install_playwright(&checkout.0);
        let gone = checkout.0.join("moved-away");

        let env = local_env(&gone);

        assert!(!env.exists);
        assert_eq!(env.playwright_cli, None);
        assert_eq!(env.folder, gone.to_string_lossy());
    }
}
