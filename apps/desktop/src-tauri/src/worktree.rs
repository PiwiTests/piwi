// Reproducing a failure, running a Flake Lab session and driving a git bisect
// against a linked project folder, without ever touching the user's checkout.
//
// A reproduction, a lab session and a bisect all run in a throwaway `git worktree` of a commit,
// created under this app's data dir — never inside the linked folder — so the
// user's HEAD, uncommitted changes and `node_modules` are left alone. The shell
// drives every step itself (checkout · install · browser · test, and for a bisect
// the good/bad loop) and streams progress into the Local runs tray on the same
// `piwi:local-run` channel a normal local run uses.
//
// The webview only ever names a project and a commit window, for a lab session
// a test case id and bounded numbers, and for an editor's lab job the request;
// `git` is invoked through a fixed set of subcommands with validated arguments
// (SHAs match `^[0-9a-f]{7,40}$`, worktree paths are canonicalized and must sit
// under the worktrees dir). A lab session reads the commit of the test's latest
// failure from the bundled server itself, a lab job its commit and plan, and
// the `piwi flake` arguments and environment are built here.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter as _, Manager as _};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt as _;

use crate::mcp_clients::ServerInfo;
use crate::node_path;
use crate::repro::local_get_json;
use crate::runner::{
    linked_folder, resolve_playwright_cli, validate_args, Job, JobChild, LinkRecord, LocalRuns,
    RunEventPayload, RUN_EVENT,
};

/// A bisect progress event carried on a `piwi:local-run` event of kind `bisect`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectEvent {
    /// `step` (a new candidate), `verdict` (good/bad/skipped), or `result` (done).
    pub event: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps_estimate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_bad: Option<FirstBad>,
}

/// The first bad commit a bisect named, as `git show -s` reported it.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstBad {
    pub sha: String,
    pub subject: String,
    pub author: Option<String>,
    pub date: Option<String>,
}

/// How to tear a job's worktree down: reset an in-progress bisect, then remove
/// the worktree from the main repo. Run once, whether the driver finishes, the
/// user stops it, or the app quits.
pub struct Cleanup {
    pub git: PathBuf,
    pub folder: PathBuf,
    pub worktree: PathBuf,
    pub bisect: bool,
}

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

/// A commit reference the webview may hand us: 7–40 lowercase hex. Anything else
/// is rejected before it reaches a `git` argument.
pub(crate) fn valid_sha(sha: &str) -> bool {
    let len = sha.len();
    (7..=40).contains(&len)
        && sha
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// The package managers a worktree install can use, chosen from the lockfile.
#[derive(Debug, PartialEq, Clone, Copy)]
pub(crate) enum PackageManager {
    Npm,
    Pnpm,
    Yarn,
}

impl PackageManager {
    /// The lockfile whose presence selects this manager.
    fn lockfile(self) -> &'static str {
        match self {
            PackageManager::Npm => "package-lock.json",
            PackageManager::Pnpm => "pnpm-lock.yaml",
            PackageManager::Yarn => "yarn.lock",
        }
    }

    /// The tool name and the frozen-install arguments for a clean install.
    fn install_command(self) -> (&'static str, &'static [&'static str]) {
        match self {
            PackageManager::Npm => ("npm", &["ci"]),
            PackageManager::Pnpm => ("pnpm", &["install", "--frozen-lockfile"]),
            PackageManager::Yarn => ("yarn", &["install", "--frozen-lockfile"]),
        }
    }
}

/// Which package manager a folder uses, read from its lockfile. npm is the
/// baseline when no lockfile — or only `package-lock.json` — is present.
pub(crate) fn detect_package_manager(folder: &Path) -> PackageManager {
    if folder.join("pnpm-lock.yaml").is_file() {
        PackageManager::Pnpm
    } else if folder.join("yarn.lock").is_file() {
        PackageManager::Yarn
    } else {
        PackageManager::Npm
    }
}

/// Whether two files exist and hold byte-identical contents — the test for the
/// cheap install path: an unchanged lockfile means the worktree can share the
/// linked folder's `node_modules` instead of installing.
pub(crate) fn files_equal(a: &Path, b: &Path) -> bool {
    match (std::fs::read(a), std::fs::read(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Whether `candidate` sits inside `base`. Both must be canonicalized by the
/// caller so `..` and symlinks cannot escape the containment check.
pub(crate) fn path_within(base: &Path, candidate: &Path) -> bool {
    candidate.starts_with(base)
}

/// git's own bisect progress, parsed from the output of a `bisect` step:
/// `Bisecting: N revisions left to test after this (roughly M steps)` names the
/// remaining work, and the following `[<sha>] <subject>` line names the commit it
/// checked out.
#[derive(Debug, PartialEq)]
pub(crate) struct BisectProgress {
    pub revisions_left: u32,
    pub steps_remaining: u32,
    pub sha: Option<String>,
}

pub(crate) fn parse_bisect_progress(output: &str) -> Option<BisectProgress> {
    let mut progress: Option<BisectProgress> = None;
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Bisecting: ") {
            // "N revisions left to test after this (roughly M steps)"
            let revisions_left = rest
                .split_whitespace()
                .next()
                .and_then(|n| n.parse().ok())?;
            let steps_remaining = rest
                .split("roughly ")
                .nth(1)
                .and_then(|tail| tail.split_whitespace().next())
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
            progress = Some(BisectProgress {
                revisions_left,
                steps_remaining,
                sha: None,
            });
        } else if let (Some(p), Some(sha)) = (progress.as_mut(), parse_candidate_sha(line)) {
            p.sha = Some(sha);
        }
    }
    progress
}

/// The commit sha from a `[<40-hex>] <subject>` checkout line, if the line is one.
fn parse_candidate_sha(line: &str) -> Option<String> {
    let rest = line.strip_prefix('[')?;
    let (sha, _) = rest.split_once(']')?;
    (sha.len() >= 7 && sha.bytes().all(|b| b.is_ascii_hexdigit())).then(|| sha.to_lowercase())
}

/// The first bad commit's sha, parsed from `<sha> is the first bad commit`.
pub(crate) fn parse_first_bad(output: &str) -> Option<String> {
    for line in output.lines() {
        if let Some(sha) = line.trim().strip_suffix(" is the first bad commit") {
            if sha.len() >= 7 && sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Some(sha.to_lowercase());
            }
        }
    }
    None
}

/// What a lab session runs, as the webview asks for it: one suspect's arm, or
/// every arm (and every condition at once with `all`), the runs of each arm and
/// the budget. Bounded here, so only whole numbers reach the command line.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct FlakeLabOptions {
    pub suspect: Option<u32>,
    pub all: bool,
    pub runs: Option<u32>,
    pub budget_minutes: Option<u32>,
}

impl FlakeLabOptions {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.suspect.is_some() && self.all {
            return Err("run one suspect or all of them, not both".into());
        }
        if self.suspect.is_some_and(|n| !(1..=50).contains(&n)) {
            return Err("the suspect must be a rank from 1 to 50".into());
        }
        if self.runs.is_some_and(|n| !(1..=100).contains(&n)) {
            return Err("runs must be from 1 to 100".into());
        }
        if self.budget_minutes.is_some_and(|n| !(1..=240).contains(&n)) {
            return Err("the budget must be from 1 to 240 minutes".into());
        }
        Ok(())
    }
}

/// The reporter's `piwi` entry, relative to a `node_modules`.
const REPORTER_CLI: &str = "@piwitests/reporter/dist/cli/index.js";

/// The sidecar arguments of a lab session: `piwi flake <id>` and its options,
/// recorded as run from the desktop app. The id and the numbers are the only
/// values that come from the webview.
pub(crate) fn flake_lab_args(
    cli: &Path,
    test_case_id: u64,
    options: &FlakeLabOptions,
) -> Vec<String> {
    let mut args = vec![node_path(cli), "flake".into(), test_case_id.to_string()];
    if let Some(n) = options.suspect {
        args.extend(["--suspect".into(), n.to_string()]);
    } else if options.all {
        args.push("--all".into());
    }
    if let Some(n) = options.runs {
        args.extend(["--runs".into(), n.to_string()]);
    }
    if let Some(n) = options.budget_minutes {
        args.extend(["--budget".into(), format!("{n}m")]);
    }
    args.extend(["--source".into(), "desktop".into()]);
    args
}

/// The sidecar arguments of a flake-aware bisect step: the test's reproducing
/// arm alone, nothing saved, answered in `git bisect run` exit codes.
pub(crate) fn flake_bisect_args(cli: &Path, test_case_id: u64) -> Vec<String> {
    vec![
        node_path(cli),
        "flake".into(),
        "verify".into(),
        test_case_id.to_string(),
        "--bisect".into(),
        "--source".into(),
        "desktop".into(),
    ]
}

/// The sidecar arguments of an editor's lab job: `piwi flake` on the plan file
/// the shell wrote, with its results printed as JSON. `piwi flake` builds the
/// Playwright arguments from the plan, which this app's server validated.
pub(crate) fn lab_job_args(cli: &Path, plan_file: &Path) -> Vec<String> {
    vec![
        node_path(cli),
        "flake".into(),
        "--plan".into(),
        plan_file.to_string_lossy().into_owned(),
        "--json".into(),
    ]
}

/// The commit and the plan of an editor's lab job, read from its request as
/// the bundled server keeps it: a `flake-lab` request the window started.
pub(crate) fn parse_lab_job(
    request: &serde_json::Value,
) -> Result<(String, serde_json::Value), String> {
    if request.get("kind").and_then(|v| v.as_str()) != Some("flake-lab") {
        return Err("the request is not a Flake Lab job".into());
    }
    if request.get("status").and_then(|v| v.as_str()) != Some("running") {
        return Err("the job has not been started in the window".into());
    }
    let job = request.get("job").ok_or("the request carries no job")?;
    let commit = job
        .get("commit")
        .and_then(|v| v.as_str())
        .map(str::to_lowercase)
        .filter(|c| valid_sha(c))
        .ok_or("the job's commit is not a commit id")?;
    let plan = job
        .get("plan")
        .filter(|p| p.is_object())
        .cloned()
        .ok_or("the job carries no plan")?;
    Ok((commit, plan))
}

/// The report `piwi flake --json` printed: the JSON object its output ends
/// with. None when it printed none, as when it could not run.
pub(crate) fn parse_lab_report(stdout: &str) -> Option<serde_json::Value> {
    let start = if stdout.starts_with('{') {
        0
    } else {
        stdout.find("\n{")? + 1
    };
    let report: serde_json::Value = serde_json::from_str(stdout[start..].trim_end()).ok()?;
    report.is_object().then_some(report)
}

/// Where a lab job's plan file goes: beside the project's worktrees, in this
/// app's data dir, never inside a linked folder or a worktree.
pub(crate) fn lab_plan_path(root: &Path, project_id: &str, request_id: &str) -> PathBuf {
    root.join(project_id).join(format!("lab-{request_id}.json"))
}

/// The environment a reproduction, a bisect step and `piwi flake` run with:
/// this app's server and token, which win over a dashboard named in the user's
/// environment or a `.env` in the worktree, so a run of an old commit reports
/// to this app only, and plain output for the tray.
pub(crate) fn flake_lab_env(server: &ServerInfo) -> Vec<(&'static str, String)> {
    vec![
        (
            "PIWI_DASHBOARD_URL",
            format!("http://127.0.0.1:{}", server.port),
        ),
        ("PIWI_API_KEY", server.token.clone()),
        ("NO_COLOR", "1".into()),
        ("FORCE_COLOR", "0".into()),
    ]
}

/// The environment a local test runs with: the reporter records the run's
/// origin (`desktop`, `reproduce`, `bisect`) and, when there is one, its
/// reference, which the window uses to find the run the reporter recorded.
pub(crate) fn origin_env(
    kind: &'static str,
    origin_ref: Option<&str>,
) -> Vec<(&'static str, String)> {
    let mut env = vec![("PIWI_ORIGIN", kind.to_string())];
    if let Some(reference) = origin_ref {
        env.push(("PIWI_ORIGIN_REF", reference.to_string()));
    }
    env
}

/// A run's origin reference: the failure cluster (or bug report) it was
/// launched for, else the reference the webview chose for it. A reference is
/// at most 200 letters, digits and `._:/#@-`, as the reporter keeps it.
pub(crate) fn origin_reference(
    id: Option<u64>,
    chosen: Option<String>,
) -> Result<Option<String>, String> {
    if let Some(id) = id {
        return Ok(Some(id.to_string()));
    }
    match chosen {
        None => Ok(None),
        Some(reference)
            if !reference.is_empty()
                && reference.len() <= 200
                && reference
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._:/#@-".contains(c)) =>
        {
            Ok(Some(reference))
        }
        Some(_) => Err("invalid origin reference".into()),
    }
}

/// The `git bisect` subcommand for a flake-aware step's exit code: 0 good, 1
/// bad, 125 skip. Anything else means the step could not ask the dashboard,
/// which stops the bisect rather than guessing.
pub(crate) fn flake_step_verdict(code: Option<i32>) -> Result<&'static str, String> {
    match code {
        Some(0) => Ok("good"),
        Some(1) => Ok("bad"),
        Some(125) => Ok("skip"),
        Some(code) => Err(format!("piwi flake could not run this step (exit {code})")),
        None => Err("piwi flake stopped without an exit code".into()),
    }
}

/// The project and the commit of the test's latest failure, read from the
/// flake-plan response (`projectId`, `failureCommit`).
pub(crate) fn parse_flake_target(
    plan: &serde_json::Value,
) -> Result<(String, Option<String>), String> {
    let project = plan
        .get("projectId")
        .and_then(|v| v.as_u64())
        .ok_or("the local server sent no project for this test")?;
    let commit = plan
        .get("failureCommit")
        .and_then(|v| v.as_str())
        .map(|c| c.to_lowercase());
    Ok((project.to_string(), commit))
}

/// Whether `git status --porcelain` output lists any change.
pub(crate) fn is_dirty(porcelain: &str) -> bool {
    porcelain.lines().any(|l| !l.trim().is_empty())
}

/// The executable candidate names for a tool on this platform (Windows resolves
/// `.cmd`/`.exe` shims; POSIX uses the bare name).
fn tool_candidates(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![
            format!("{name}.cmd"),
            format!("{name}.exe"),
            name.to_string(),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![name.to_string()]
    }
}

/// Find the first `candidates` entry that exists as a file in one of `dirs`, in
/// order. Pure so the resolution order is unit-testable without a real PATH.
pub(crate) fn resolve_tool_in(dirs: &[PathBuf], candidates: &[String]) -> Option<PathBuf> {
    for dir in dirs {
        for candidate in candidates {
            let p = dir.join(candidate);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// The directories searched for a user tool: `PATH`, then the well-known install
/// locations a GUI app on macOS does not inherit `PATH` for.
fn tool_search_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let home = app.path().home_dir().ok();
    for extra in [
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/bin"),
    ] {
        dirs.push(extra);
    }
    if let Some(home) = &home {
        dirs.push(home.join(".volta").join("bin"));
        // The active-version bin dirs under nvm, best-effort.
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm").join("versions").join("node")) {
            for entry in entries.flatten() {
                dirs.push(entry.path().join("bin"));
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            dirs.push(PathBuf::from(&pf).join("Git").join("cmd"));
            dirs.push(PathBuf::from(&pf).join("nodejs"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
    }
    dirs
}

/// Resolve a user tool (`git`, `npm`, `pnpm`, `yarn`) to an absolute path, or
/// `None` when it is not installed anywhere the shell knows to look.
fn resolve_tool(app: &AppHandle, name: &str) -> Option<PathBuf> {
    resolve_tool_in(&tool_search_dirs(app), &tool_candidates(name))
}

// ── Worktree location + cwd validation ────────────────────────────────────────

/// The root under which every worktree is created: `<app data>/worktrees`. Never
/// inside a linked folder.
fn worktrees_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("worktrees");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The prefix of a worktrees folder moved aside for deletion.
const DISCARDED_PREFIX: &str = "worktrees-discarded-";

/// Discard the worktrees an earlier launch left behind (a crash skips the
/// cleanup on quit). Called at startup, before any job can start: the folder is
/// moved aside at once, then deleted in the background together with any folder
/// an interrupted deletion left. A linked repository forgets the removed
/// worktrees at its next `git worktree prune`.
pub(crate) fn discard_leftover_worktrees(app_data_dir: &Path) {
    let root = app_data_dir.join("worktrees");
    if root.is_dir() {
        let aside = app_data_dir.join(format!("{DISCARDED_PREFIX}{}", &crate::random_hex_32()[..8]));
        let _ = std::fs::rename(&root, aside);
    }
    let Ok(entries) = std::fs::read_dir(app_data_dir) else {
        return;
    };
    let discarded: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(DISCARDED_PREFIX))
        .map(|entry| entry.path())
        .collect();
    if !discarded.is_empty() {
        std::thread::spawn(move || {
            for dir in discarded {
                let _ = std::fs::remove_dir_all(dir);
            }
        });
    }
}

/// Validate a `cwd` a local run was pointed at: it must canonicalize to a real
/// directory inside this app's worktrees dir. Used by `desktop_run_local_tests`
/// so the webview cannot redirect a run at an arbitrary folder.
pub(crate) fn validate_worktree_cwd(app: &AppHandle, dir: &str) -> Result<PathBuf, String> {
    let root = worktrees_root(app)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let candidate = PathBuf::from(dir)
        .canonicalize()
        .map_err(|_| "the worktree no longer exists".to_string())?;
    if !path_within(&root, &candidate) {
        return Err("the run folder must be inside the app's worktrees directory".into());
    }
    Ok(candidate)
}

// ── Process-tree kill + cleanup (called from LocalRuns stop / kill_all) ─────────

/// Kill a child and the process tree it spawned (a test can start browsers and a
/// webServer). Best-effort: on Windows `taskkill /T /F`; on Unix the process and
/// its direct children (the browsers Playwright launches), then a SIGKILL sweep.
pub(crate) fn kill_child_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .output();
    }
    #[cfg(not(windows))]
    {
        let pid = pid.to_string();
        // Children first so nothing is reparented away before we reach it.
        let _ = Command::new("pkill").args(["-TERM", "-P", &pid]).output();
        let _ = Command::new("kill").args(["-TERM", &pid]).output();
        let _ = Command::new("pkill").args(["-KILL", "-P", &pid]).output();
        let _ = Command::new("kill").args(["-KILL", &pid]).output();
    }
}

/// Reset any in-progress bisect and remove the worktree — once. Best-effort: the
/// app must exit cleanly even when git is gone or the worktree is already gone.
pub(crate) fn perform_cleanup(cleanup: &Cleanup, cleaned: &AtomicBool) {
    if cleaned.swap(true, Ordering::SeqCst) {
        return;
    }
    if cleanup.bisect {
        let _ = Command::new(&cleanup.git)
            .args(["bisect", "reset"])
            .current_dir(&cleanup.worktree)
            .output();
    }
    let _ = Command::new(&cleanup.git)
        .arg("-C")
        .arg(&cleanup.folder)
        .args(["worktree", "remove", "--force"])
        .arg(&cleanup.worktree)
        .output();
    let _ = Command::new(&cleanup.git)
        .arg("-C")
        .arg(&cleanup.folder)
        .args(["worktree", "prune"])
        .output();
}

// ── git plumbing ──────────────────────────────────────────────────────────────

/// Run a git subcommand and capture its combined stdout+stderr; `Err` carries the
/// output when git exits non-zero.
fn git_capture(git: &Path, dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new(git)
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if out.status.success() {
        Ok(text)
    } else {
        Err(text.trim().to_string())
    }
}

/// Whether a commit is known to the repository at `folder`.
fn commit_exists(git: &Path, folder: &Path, sha: &str) -> bool {
    Command::new(git)
        .arg("-C")
        .arg(folder)
        .args(["cat-file", "-e", &format!("{sha}^{{commit}}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ── Emitting ──────────────────────────────────────────────────────────────────

fn emit(app: &AppHandle, payload: RunEventPayload) {
    let _ = app.emit(RUN_EVENT, &payload);
}

fn emit_line(app: &AppHandle, id: u32, kind: &'static str, text: impl Into<String>) {
    emit(app, RunEventPayload::line(id, kind, text.into()));
}

// ── Install / browser / test phases (streaming) ───────────────────────────────

/// Symlink (or junction on Windows) the linked folder's `node_modules` into the
/// worktree, the cheap path when the lockfile is unchanged.
fn link_node_modules(folder: &Path, worktree: &Path) -> Result<(), String> {
    let src = folder.join("node_modules");
    let dst = worktree.join("node_modules");
    if dst.exists() {
        return Ok(());
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(&src, &dst).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(&src, &dst).map_err(|e| e.to_string())
    }
}

/// Install dependencies in the worktree. Prefers linking the linked folder's
/// `node_modules` when the lockfile is byte-identical; otherwise runs the folder's
/// package manager. Returns whether the step succeeded.
fn install_worktree(
    app: &AppHandle,
    id: u32,
    folder: &Path,
    worktree: &Path,
    stop: &AtomicBool,
) -> bool {
    let pm = detect_package_manager(folder);
    let lockfile = pm.lockfile();
    let folder_lock = folder.join(lockfile);
    let worktree_lock = worktree.join(lockfile);
    let folder_modules = folder.join("node_modules").is_dir();

    if folder_modules && files_equal(&folder_lock, &worktree_lock) {
        match link_node_modules(folder, worktree) {
            Ok(()) => {
                emit_line(
                    app,
                    id,
                    "stdout",
                    format!("Linked node_modules ({lockfile} unchanged)."),
                );
                return true;
            }
            Err(e) => emit_line(
                app,
                id,
                "stderr",
                format!("Could not link node_modules ({e}); installing."),
            ),
        }
    }

    let (tool, tool_args) = pm.install_command();
    let Some(bin) = resolve_tool(app, tool) else {
        emit_line(app, id, "error", format!("`{tool}` was not found — install it, or open the linked folder and install dependencies there."));
        return false;
    };
    emit_line(app, id, "stdout", format!("{tool} {}", tool_args.join(" ")));
    run_std_streaming(app, id, &bin, tool_args, worktree, stop)
        .map(|code| code == 0)
        .unwrap_or(false)
}

/// Install the browser the failure ran on, only when it is not already in
/// Playwright's cache. Uses the worktree's own Playwright CLI via the sidecar.
async fn ensure_browser(
    app: &AppHandle,
    id: u32,
    worktree: &Path,
    cli: &Path,
    browser: Option<&str>,
) -> bool {
    let Some(browser) = browser else {
        return true; // Unknown browser — the run installs on demand.
    };
    if browser_cached(app, browser) {
        emit_line(app, id, "stdout", format!("{browser} already installed."));
        return true;
    }
    emit_line(app, id, "stdout", format!("Installing {browser}…"));
    let args = vec![node_path(cli), "install".into(), browser.to_string()];
    run_sidecar_streaming(app, id, None, worktree, args, &[])
        .await
        .map(|code| code == 0)
        .unwrap_or(false)
}

/// A rough check for a browser already in Playwright's per-user cache, so the
/// slow `playwright install` is skipped when it is present.
fn browser_cached(app: &AppHandle, browser: &str) -> bool {
    let Some(home) = app.path().home_dir().ok() else {
        return false;
    };
    #[cfg(target_os = "macos")]
    let cache = home.join("Library").join("Caches").join("ms-playwright");
    #[cfg(target_os = "windows")]
    let cache = home.join("AppData").join("Local").join("ms-playwright");
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let cache = home.join(".cache").join("ms-playwright");
    std::fs::read_dir(&cache)
        .map(|entries| {
            entries.flatten().any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .starts_with(browser)
            })
        })
        .unwrap_or(false)
}

/// Spawn a std process, stream its output as run events, record its pid for stop,
/// and return its exit code. Blocks the calling task until the process exits.
fn run_std_streaming(
    app: &AppHandle,
    id: u32,
    bin: &Path,
    args: &[&str],
    dir: &Path,
    stop: &AtomicBool,
) -> Option<i32> {
    if stop.load(Ordering::SeqCst) {
        return None;
    }
    let mut child = match Command::new(bin)
        .args(args)
        .current_dir(dir)
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            emit_line(app, id, "error", e.to_string());
            return None;
        }
    };
    record_child(
        app,
        id,
        Some(JobChild {
            pid: child.id(),
            interruptible: false,
        }),
    );

    if let Some(out) = child.stdout.take() {
        let app = app.clone();
        let reader = BufReader::new(out);
        std::thread::spawn(move || {
            for line in reader.lines().map_while(Result::ok) {
                emit_line(&app, id, "stdout", line);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let app = app.clone();
        let reader = BufReader::new(err);
        std::thread::spawn(move || {
            for line in reader.lines().map_while(Result::ok) {
                emit_line(&app, id, "stderr", line);
            }
        });
    }
    let code = child.wait().ok().and_then(|s| s.code());
    record_child(app, id, None);
    code
}

/// Spawn the Node sidecar (browser install or the test), stream its output, record
/// its pid for stop, and return its exit code.
async fn run_sidecar_streaming(
    app: &AppHandle,
    id: u32,
    cli: Option<&Path>,
    worktree: &Path,
    node_args: Vec<String>,
    env: &[(&'static str, String)],
) -> Option<i32> {
    let _ = cli; // node_args already carry the resolved CLI path
    run_sidecar(app, id, worktree, node_args, env, false)
        .await
        .0
}

/// Spawn the Node sidecar, stream its output, record its pid for stop, and
/// return its exit code, with its standard output when `keep_stdout` is set.
async fn run_sidecar(
    app: &AppHandle,
    id: u32,
    worktree: &Path,
    node_args: Vec<String>,
    env: &[(&'static str, String)],
    keep_stdout: bool,
) -> (Option<i32>, String) {
    let mut stdout = String::new();
    let command = match app.shell().sidecar("node") {
        Ok(c) => c
            .args(node_args)
            .current_dir(worktree)
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0")
            .envs(env.iter().map(|(k, v)| (k.to_string(), v.clone()))),
        Err(e) => {
            emit_line(app, id, "error", e.to_string());
            return (None, stdout);
        }
    };
    let (mut rx, child) = match command.spawn() {
        Ok(pair) => pair,
        Err(e) => {
            emit_line(app, id, "error", e.to_string());
            return (None, stdout);
        }
    };
    record_child(
        app,
        id,
        Some(JobChild {
            pid: child.pid(),
            interruptible: true,
        }),
    );
    let mut code = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line).trim_end().to_string();
                if keep_stdout {
                    stdout.push_str(&text);
                    stdout.push('\n');
                }
                emit_line(app, id, "stdout", text)
            }
            CommandEvent::Stderr(line) => emit_line(
                app,
                id,
                "stderr",
                String::from_utf8_lossy(&line).trim_end().to_string(),
            ),
            CommandEvent::Error(err) => emit_line(app, id, "error", err),
            CommandEvent::Terminated(status) => {
                code = status.code;
                break;
            }
            _ => {}
        }
    }
    record_child(app, id, None);
    (code, stdout)
}

/// Record (or clear) the child currently running for a job, so stop and
/// app-quit reach exactly what is live.
fn record_child(app: &AppHandle, id: u32, child: Option<JobChild>) {
    if let Some(runs) = app.try_state::<LocalRuns>() {
        runs.set_job_child(id, child);
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Resolve the linked folder for a project, checking it is on disk and a git repo.
fn resolve_repo(
    app: &AppHandle,
    project_id: &str,
) -> Result<(LinkRecord, PathBuf, PathBuf), String> {
    if !crate::runner::valid_project_id(project_id) {
        return Err("invalid project id".into());
    }
    let record = linked_folder(app, project_id).ok_or("no folder is linked to this project")?;
    let folder = PathBuf::from(&record.path);
    if !folder.is_dir() {
        return Err("the linked folder no longer exists — pick it again".into());
    }
    let git = resolve_tool(app, "git").ok_or("git was not found — install it and try again")?;
    if !folder.join(".git").exists() {
        return Err("the linked folder is not a git repository".into());
    }
    Ok((record, folder, git))
}

/// Prepare job `id`'s worktree of `commit` under the worktrees dir. Returns the
/// worktree path.
fn add_worktree(
    app: &AppHandle,
    git: &Path,
    folder: &Path,
    project_id: &str,
    commit: &str,
    id: u32,
) -> Result<PathBuf, String> {
    add_worktree_in(&worktrees_root(app)?, git, folder, project_id, "", commit, id)
}

/// Where job `id` checks out `commit`: `<root>/<project>/<prefix><short sha>-<id>`.
/// One folder per job, so jobs at the same commit never share or remove each
/// other's worktree.
pub(crate) fn job_worktree_path(
    root: &Path,
    project_id: &str,
    prefix: &str,
    commit: &str,
    id: u32,
) -> PathBuf {
    root.join(project_id)
        .join(format!("{prefix}{}-{id}", &commit[..commit.len().min(12)]))
}

/// Prepare job `id`'s worktree of `commit` ([`job_worktree_path`]), detached,
/// from the repository at `folder`. The folder's HEAD, index and working files
/// are left as they are.
pub(crate) fn add_worktree_in(
    root: &Path,
    git: &Path,
    folder: &Path,
    project_id: &str,
    prefix: &str,
    commit: &str,
    id: u32,
) -> Result<PathBuf, String> {
    if !crate::runner::valid_project_id(project_id) {
        return Err("invalid project id".into());
    }
    if !commit_exists(git, folder, commit) {
        return Err(format!(
            "commit {} is unknown to the linked repository — run `git fetch` in it first.",
            &commit[..commit.len().min(12)]
        ));
    }
    let worktree = job_worktree_path(root, project_id, prefix, commit, id);
    // Run ids restart at each launch: a folder already there is a leftover of
    // an earlier launch, which no running job owns, and it blocks `add`.
    if worktree.exists() {
        let _ = Command::new(git)
            .arg("-C")
            .arg(folder)
            .args(["worktree", "remove", "--force"])
            .arg(&worktree)
            .output();
        let _ = std::fs::remove_dir_all(&worktree);
    }
    if let Some(parent) = worktree.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    git_capture(
        git,
        folder,
        &[
            "worktree",
            "add",
            "--detach",
            &worktree.to_string_lossy(),
            commit,
        ],
    )?;
    Ok(worktree)
}

/// Reproduce the failing test(s) end to end in a throwaway worktree of `commit`:
/// checkout · install · browser · test. Returns a run id; progress streams as
/// `piwi:local-run` events. The user's checkout is never touched.
#[tauri::command]
pub async fn desktop_reproduce_here(
    app: AppHandle,
    project_id: String,
    commit: String,
    args: Vec<String>,
    browser: Option<String>,
    cluster_id: Option<u64>,
    origin_ref: Option<String>,
) -> Result<u32, String> {
    validate_args(&args)?;
    if !valid_sha(&commit) {
        return Err("invalid commit".into());
    }
    let origin_ref = origin_reference(cluster_id, origin_ref)?;
    let (_record, folder, git) = resolve_repo(&app, &project_id)?;

    let state = app.state::<LocalRuns>();
    let id = state.allocate_id();
    let stop = Arc::new(AtomicBool::new(false));
    let cleaned = Arc::new(AtomicBool::new(false));
    let worktree = add_worktree(&app, &git, &folder, &project_id, &commit, id)?;
    state.register_job(
        id,
        Job {
            stop: stop.clone(),
            child: Arc::new(Mutex::new(None)),
            cleanup: Cleanup {
                git: git.clone(),
                folder: folder.clone(),
                worktree: worktree.clone(),
                bisect: false,
            },
            cleaned: cleaned.clone(),
        },
    );

    tauri::async_runtime::spawn(async move {
        let code = reproduce_driver(
            &app,
            id,
            &folder,
            &git,
            &worktree,
            &args,
            browser.as_deref(),
            origin_ref.as_deref(),
            &stop,
        )
        .await;
        finish_job(&app, id, &git, &folder, &worktree, false, &cleaned, code);
    });
    Ok(id)
}

#[allow(clippy::too_many_arguments)]
async fn reproduce_driver(
    app: &AppHandle,
    id: u32,
    folder: &Path,
    _git: &Path,
    worktree: &Path,
    args: &[String],
    browser: Option<&str>,
    origin_ref: Option<&str>,
    stop: &AtomicBool,
) -> Option<i32> {
    emit(app, RunEventPayload::phase(id, "checkout"));
    emit_line(
        app,
        id,
        "stdout",
        "Worktree ready — your checkout is untouched.",
    );
    emit_line(
        app,
        id,
        "stdout",
        "The commit's own Playwright version is used — not the run's pin.",
    );

    emit(app, RunEventPayload::phase(id, "install"));
    if stop.load(Ordering::SeqCst) || !install_worktree(app, id, folder, worktree, stop) {
        return None;
    }
    let env = origin_env("reproduce", origin_ref);
    run_test_phase(app, id, worktree, args, browser, &env, stop).await
}

/// The browser + test phases shared by reproduce and each bisect step; the test
/// runs with this app's server and token ([`flake_lab_env`]) and `env`.
async fn run_test_phase(
    app: &AppHandle,
    id: u32,
    worktree: &Path,
    args: &[String],
    browser: Option<&str>,
    env: &[(&'static str, String)],
    stop: &AtomicBool,
) -> Option<i32> {
    let cli = resolve_playwright_cli(worktree)?;

    emit(app, RunEventPayload::phase(id, "browser"));
    if stop.load(Ordering::SeqCst) || !ensure_browser(app, id, worktree, &cli, browser).await {
        return None;
    }

    emit(app, RunEventPayload::phase(id, "test"));
    if stop.load(Ordering::SeqCst) {
        return None;
    }
    let mut node_args = vec![node_path(&cli), "test".to_string()];
    node_args.extend(args.iter().cloned());
    let mut env_with_app = flake_lab_env(&server_info(app));
    env_with_app.extend_from_slice(env);
    run_sidecar_streaming(app, id, Some(&cli), worktree, node_args, &env_with_app).await
}

/// Drive a git bisect over the window `good..bad` in a throwaway worktree, step by
/// step, naming the first bad commit. Returns a run id; progress streams as
/// `piwi:local-run` events.
#[tauri::command]
pub async fn desktop_bisect_here(
    app: AppHandle,
    project_id: String,
    good: String,
    bad: String,
    args: Vec<String>,
    browser: Option<String>,
    flake_test_case_id: Option<u64>,
    cluster_id: Option<u64>,
    origin_ref: Option<String>,
) -> Result<u32, String> {
    validate_args(&args)?;
    if !valid_sha(&good) || !valid_sha(&bad) {
        return Err("invalid commit".into());
    }
    let origin_ref = origin_reference(cluster_id, origin_ref)?;
    // A flake-aware bisect asks `piwi flake verify --bisect` at each step, with
    // this app's server and token.
    let flake = flake_test_case_id.map(|id| (id, server_info(&app)));
    let (_record, folder, git) = resolve_repo(&app, &project_id)?;
    if !commit_exists(&git, &folder, &good) || !commit_exists(&git, &folder, &bad) {
        return Err(format!(
            "one of the commits is unknown to the linked repository — run `git fetch {}` in it first.",
            &bad[..bad.len().min(12)]
        ));
    }
    // The good commit must be an ancestor of the bad one for a bisect to make sense.
    let ancestor = Command::new(&git)
        .arg("-C")
        .arg(&folder)
        .args(["merge-base", "--is-ancestor", &good, &bad])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ancestor {
        return Err("the last green commit is not an ancestor of the failing commit — the window does not make sense for a bisect.".into());
    }

    let state = app.state::<LocalRuns>();
    let id = state.allocate_id();
    let stop = Arc::new(AtomicBool::new(false));
    let cleaned = Arc::new(AtomicBool::new(false));
    let worktree = add_worktree(&app, &git, &folder, &project_id, &bad, id)?;
    state.register_job(
        id,
        Job {
            stop: stop.clone(),
            child: Arc::new(Mutex::new(None)),
            cleanup: Cleanup {
                git: git.clone(),
                folder: folder.clone(),
                worktree: worktree.clone(),
                bisect: true,
            },
            cleaned: cleaned.clone(),
        },
    );

    tauri::async_runtime::spawn(async move {
        let code = bisect_driver(
            &app,
            id,
            &git,
            &worktree,
            &folder,
            &good,
            &bad,
            &args,
            browser.as_deref(),
            flake.as_ref(),
            origin_ref.as_deref(),
            &stop,
        )
        .await;
        finish_job(&app, id, &git, &folder, &worktree, true, &cleaned, code);
    });
    Ok(id)
}

#[allow(clippy::too_many_arguments)]
async fn bisect_driver(
    app: &AppHandle,
    id: u32,
    git: &Path,
    worktree: &Path,
    folder: &Path,
    good: &str,
    bad: &str,
    args: &[String],
    browser: Option<&str>,
    flake: Option<&(u64, ServerInfo)>,
    origin_ref: Option<&str>,
    stop: &AtomicBool,
) -> Option<i32> {
    emit(app, RunEventPayload::phase(id, "bisect"));
    if let Some((test_case_id, _)) = flake {
        emit_line(
            app,
            id,
            "stdout",
            format!("Each step runs the Flake Lab arm that reproduced test {test_case_id}: bad on a failure with the same error as in CI, good after enough clean runs."),
        );
    }
    let start = git_capture(git, worktree, &["bisect", "start", bad, good]);
    let mut output = match start {
        Ok(text) => text,
        Err(e) => {
            emit_line(app, id, "error", e);
            return None;
        }
    };

    let mut step: u32 = 0;
    loop {
        if stop.load(Ordering::SeqCst) {
            return None;
        }
        if let Some(sha) = parse_first_bad(&output) {
            let first_bad = describe_commit(git, worktree, &sha);
            emit(
                app,
                RunEventPayload::bisect(
                    id,
                    BisectEvent {
                        event: "result",
                        step: None,
                        steps_estimate: None,
                        sha: None,
                        verdict: None,
                        first_bad: Some(first_bad),
                    },
                ),
            );
            return Some(0);
        }
        let Some(progress) = parse_bisect_progress(&output) else {
            emit_line(app, id, "error", "Could not read git bisect progress.");
            return None;
        };
        step += 1;
        let candidate = progress.sha.clone();
        emit(
            app,
            RunEventPayload::bisect(
                id,
                BisectEvent {
                    event: "step",
                    step: Some(step),
                    steps_estimate: Some(step + progress.steps_remaining),
                    sha: candidate.clone(),
                    verdict: None,
                    first_bad: None,
                },
            ),
        );

        // Install can change inside the window, so re-check the lockfile each step.
        let installed = install_worktree(app, id, folder, worktree, stop);
        let browser_ok =
            installed && ensure_browser_for_step(app, id, worktree, browser, stop).await;
        // The sub-command that judges this commit — `skip` when it cannot be
        // built or tested, otherwise `good`/`bad` from the test's exit code. Each
        // advances the bisect and prints the next candidate, which becomes the
        // output the loop reads next.
        let verdict = if !installed || !browser_ok {
            "skip"
        } else if let Some((test_case_id, server)) = flake {
            let code = run_flake_step(app, id, folder, worktree, *test_case_id, server, stop).await;
            if stop.load(Ordering::SeqCst) {
                return None;
            }
            match flake_step_verdict(code) {
                Ok(verdict) => verdict,
                Err(e) => {
                    emit_line(app, id, "error", e);
                    return None;
                }
            }
        } else {
            let env = origin_env("bisect", origin_ref);
            let code = run_test_phase(app, id, worktree, args, browser, &env, stop).await;
            if stop.load(Ordering::SeqCst) {
                return None;
            }
            if code == Some(0) {
                "good"
            } else {
                "bad"
            }
        };
        match git_capture(git, worktree, &["bisect", verdict]) {
            Ok(text) => output = text,
            Err(e) => {
                emit_line(app, id, "error", e);
                return None;
            }
        }
        let reported = if verdict == "skip" {
            "skipped"
        } else {
            verdict
        };
        emit(
            app,
            RunEventPayload::bisect(
                id,
                BisectEvent {
                    event: "verdict",
                    step: Some(step),
                    steps_estimate: None,
                    sha: candidate,
                    verdict: Some(reported.to_string()),
                    first_bad: None,
                },
            ),
        );
    }
}

/// This app's server address and token, for the `piwi flake` runs it starts.
fn server_info(app: &AppHandle) -> ServerInfo {
    let server = app.state::<ServerInfo>();
    ServerInfo {
        port: server.port,
        token: server.token.clone(),
    }
}

/// The reporter's `piwi` entry for a lab run in `worktree`: the linked
/// folder's, the newest the user has installed, else the worktree's own. The
/// test, its fixtures and Playwright always come from the worktree.
fn resolve_reporter_cli(folder: &Path, worktree: &Path) -> Option<PathBuf> {
    crate::runner::resolve_node_module(folder, &[REPORTER_CLI])
        .or_else(|| crate::runner::resolve_node_module(worktree, &[REPORTER_CLI]))
}

/// One flake-aware bisect step: `piwi flake verify <id> --bisect` in the
/// worktree. Returns its exit code.
async fn run_flake_step(
    app: &AppHandle,
    id: u32,
    folder: &Path,
    worktree: &Path,
    test_case_id: u64,
    server: &ServerInfo,
    stop: &AtomicBool,
) -> Option<i32> {
    if stop.load(Ordering::SeqCst) {
        return None;
    }
    let Some(cli) = resolve_reporter_cli(folder, worktree) else {
        emit_line(app, id, "error", "@piwitests/reporter is not installed in the linked folder or at this commit — install it to run the lab.");
        return None;
    };
    let args = flake_bisect_args(&cli, test_case_id);
    run_sidecar_streaming(app, id, Some(&cli), worktree, args, &flake_lab_env(server)).await
}

/// Run a Flake Lab session on one test at the commit of its latest failure, in
/// a throwaway worktree of the project's linked folder: checkout · install ·
/// `piwi flake`. The webview names the test and the options only; the project
/// and the commit come from the bundled server, and the arguments and the
/// environment are built here. Returns a run id; output streams as
/// `piwi:local-run` events, and the exit code is `piwi flake`'s (0 reproduced,
/// 1 not reproduced, 2 could not run).
#[tauri::command]
pub async fn desktop_flake_lab_here(
    app: AppHandle,
    test_case_id: u64,
    suspect: Option<u32>,
    all: Option<bool>,
    runs: Option<u32>,
    budget_minutes: Option<u32>,
) -> Result<u32, String> {
    let options = FlakeLabOptions {
        suspect,
        all: all.unwrap_or(false),
        runs,
        budget_minutes,
    };
    options.validate()?;
    if test_case_id == 0 {
        return Err("invalid test case".into());
    }
    let server = server_info(&app);
    let plan_server = ServerInfo {
        port: server.port,
        token: server.token.clone(),
    };
    let plan = tauri::async_runtime::spawn_blocking(move || {
        local_get_json(
            &plan_server,
            &format!("/api/test-cases/{test_case_id}/flake-plan?kind=reproduce&record=false"),
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    let (project_id, commit) = parse_flake_target(&plan)?;
    let commit = commit.ok_or(
        "the test's latest failure has no commit on record, so there is nothing to check out — run `piwi flake` in your checkout instead",
    )?;
    if !valid_sha(&commit) {
        return Err("the latest failure's commit is not a commit id".into());
    }
    let (_record, folder, git) = resolve_repo(&app, &project_id)?;
    let dirty = git_capture(&git, &folder, &["status", "--porcelain"])
        .map(|out| is_dirty(&out))
        .unwrap_or(false);

    let state = app.state::<LocalRuns>();
    let id = state.allocate_id();
    let stop = Arc::new(AtomicBool::new(false));
    let cleaned = Arc::new(AtomicBool::new(false));
    let worktree = add_worktree_in(
        &worktrees_root(&app)?,
        &git,
        &folder,
        &project_id,
        "flake-",
        &commit,
        id,
    )?;
    state.register_job(
        id,
        Job {
            stop: stop.clone(),
            child: Arc::new(Mutex::new(None)),
            cleanup: Cleanup {
                git: git.clone(),
                folder: folder.clone(),
                worktree: worktree.clone(),
                bisect: false,
            },
            cleaned: cleaned.clone(),
        },
    );

    tauri::async_runtime::spawn(async move {
        let code = flake_lab_driver(
            &app,
            id,
            &folder,
            &worktree,
            &commit,
            dirty,
            test_case_id,
            &options,
            &server,
            &stop,
        )
        .await;
        // A session that could not start reads as an error, never as "not reproduced".
        finish_job(
            &app,
            id,
            &git,
            &folder,
            &worktree,
            false,
            &cleaned,
            Some(code.unwrap_or(2)),
        );
    });
    Ok(id)
}

#[allow(clippy::too_many_arguments)]
async fn flake_lab_driver(
    app: &AppHandle,
    id: u32,
    folder: &Path,
    worktree: &Path,
    commit: &str,
    dirty: bool,
    test_case_id: u64,
    options: &FlakeLabOptions,
    server: &ServerInfo,
    stop: &AtomicBool,
) -> Option<i32> {
    let cli = prepare_lab(app, id, folder, worktree, commit, dirty, stop)?;
    let args = flake_lab_args(&cli, test_case_id, options);
    run_sidecar_streaming(app, id, Some(&cli), worktree, args, &flake_lab_env(server)).await
}

/// The phases before a lab runs in its worktree: checkout, install, and the
/// reporter's `piwi` entry to run. None when a phase failed or the run was stopped.
fn prepare_lab(
    app: &AppHandle,
    id: u32,
    folder: &Path,
    worktree: &Path,
    commit: &str,
    dirty: bool,
    stop: &AtomicBool,
) -> Option<PathBuf> {
    emit(app, RunEventPayload::phase(id, "checkout"));
    emit_line(
        app,
        id,
        "stdout",
        format!(
            "Worktree of {} (the latest failure) ready — your checkout is untouched.",
            &commit[..commit.len().min(12)]
        ),
    );
    if dirty {
        emit_line(
            app,
            id,
            "stdout",
            "Your checkout has uncommitted changes; they stay as they are, and the lab does not see them.",
        );
    }

    emit(app, RunEventPayload::phase(id, "install"));
    if stop.load(Ordering::SeqCst) || !install_worktree(app, id, folder, worktree, stop) {
        return None;
    }

    emit(app, RunEventPayload::phase(id, "lab"));
    if stop.load(Ordering::SeqCst) {
        return None;
    }
    let Some(cli) = resolve_reporter_cli(folder, worktree) else {
        emit_line(app, id, "error", "@piwitests/reporter is not installed in the linked folder or at this commit — install it to run the lab.");
        return None;
    };
    Some(cli)
}

/// Run an editor's Flake Lab job the developer started in the window: the
/// shell reads the request's commit and plan from the bundled server, checks
/// the commit out in a throwaway worktree of the project's linked folder,
/// installs, writes the plan beside the worktree and runs
/// `piwi flake --plan <file> --json` there against this app. The webview names
/// the project and the request only. Output streams as `piwi:local-run`
/// events, then a `lab` event with the report (null when it printed none),
/// then the exit: `piwi flake`'s code (0 reproduced, 1 not reproduced, 2 could
/// not run).
#[tauri::command]
pub async fn desktop_flake_lab_job(
    app: AppHandle,
    project_id: String,
    request_id: String,
) -> Result<u32, String> {
    if !crate::repro::valid_request_id(&request_id) {
        return Err("invalid repro request id".into());
    }
    let server = server_info(&app);
    let read = ServerInfo {
        port: server.port,
        token: server.token.clone(),
    };
    let path = format!("/api/desktop/repro-requests/{request_id}");
    let request = tauri::async_runtime::spawn_blocking(move || local_get_json(&read, &path))
        .await
        .map_err(|e| e.to_string())??;
    let (commit, plan) = parse_lab_job(&request)?;
    let (_record, folder, git) = resolve_repo(&app, &project_id)?;
    let dirty = git_capture(&git, &folder, &["status", "--porcelain"])
        .map(|out| is_dirty(&out))
        .unwrap_or(false);

    let state = app.state::<LocalRuns>();
    let id = state.allocate_id();
    let root = worktrees_root(&app)?;
    let worktree = add_worktree_in(&root, &git, &folder, &project_id, "lab-job-", &commit, id)?;
    let cleanup = Cleanup {
        git: git.clone(),
        folder: folder.clone(),
        worktree: worktree.clone(),
        bisect: false,
    };
    let plan_file = lab_plan_path(&root, &project_id, &request_id);
    let written = serde_json::to_vec_pretty(&plan)
        .map_err(|e| e.to_string())
        .and_then(|bytes| std::fs::write(&plan_file, bytes).map_err(|e| e.to_string()));
    if let Err(e) = written {
        perform_cleanup(&cleanup, &AtomicBool::new(false));
        return Err(e);
    }

    let stop = Arc::new(AtomicBool::new(false));
    let cleaned = Arc::new(AtomicBool::new(false));
    state.register_job(
        id,
        Job {
            stop: stop.clone(),
            child: Arc::new(Mutex::new(None)),
            cleanup,
            cleaned: cleaned.clone(),
        },
    );

    tauri::async_runtime::spawn(async move {
        let code = lab_job_driver(
            &app, id, &folder, &worktree, &commit, dirty, &plan_file, &server, &stop,
        )
        .await;
        let _ = std::fs::remove_file(&plan_file);
        // A job that could not start reads as an error, never as "not reproduced".
        finish_job(
            &app,
            id,
            &git,
            &folder,
            &worktree,
            false,
            &cleaned,
            Some(code.unwrap_or(2)),
        );
    });
    Ok(id)
}

#[allow(clippy::too_many_arguments)]
async fn lab_job_driver(
    app: &AppHandle,
    id: u32,
    folder: &Path,
    worktree: &Path,
    commit: &str,
    dirty: bool,
    plan_file: &Path,
    server: &ServerInfo,
    stop: &AtomicBool,
) -> Option<i32> {
    let cli = prepare_lab(app, id, folder, worktree, commit, dirty, stop)?;
    let args = lab_job_args(&cli, plan_file);
    let (code, stdout) = run_sidecar(app, id, worktree, args, &flake_lab_env(server), true).await;
    emit(app, RunEventPayload::lab(id, parse_lab_report(&stdout)));
    code
}

/// The browser phase for a bisect step, without emitting the "browser" phase
/// header on every step (the tray already shows the candidate).
async fn ensure_browser_for_step(
    app: &AppHandle,
    id: u32,
    worktree: &Path,
    browser: Option<&str>,
    stop: &AtomicBool,
) -> bool {
    if stop.load(Ordering::SeqCst) {
        return false;
    }
    let Some(cli) = resolve_playwright_cli(worktree) else {
        return false;
    };
    ensure_browser(app, id, worktree, &cli, browser).await
}

/// `git show -s` for a commit, as the identity the tray shows and the cluster
/// records.
fn describe_commit(git: &Path, worktree: &Path, sha: &str) -> FirstBad {
    let full = git_capture(git, worktree, &["rev-parse", sha])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| sha.to_string());
    let subject = git_capture(git, worktree, &["show", "-s", "--format=%s", sha])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let author = git_capture(git, worktree, &["show", "-s", "--format=%an", sha])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let date = git_capture(
        git,
        worktree,
        &["show", "-s", "--format=%ad", "--date=short", sha],
    )
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());
    FirstBad {
        sha: full,
        subject,
        author,
        date,
    }
}

/// Drop a finished job from tracking, tear its worktree down and emit the exit.
#[allow(clippy::too_many_arguments)]
fn finish_job(
    app: &AppHandle,
    id: u32,
    git: &Path,
    folder: &Path,
    worktree: &Path,
    bisect: bool,
    cleaned: &AtomicBool,
    code: Option<i32>,
) {
    perform_cleanup(
        &Cleanup {
            git: git.to_path_buf(),
            folder: folder.to_path_buf(),
            worktree: worktree.to_path_buf(),
            bisect,
        },
        cleaned,
    );
    if let Some(runs) = app.try_state::<LocalRuns>() {
        runs.drop_job(id);
    }
    emit(app, RunEventPayload::exit(id, code.or(Some(1))));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_sha_accepts_7_to_40_lowercase_hex() {
        assert!(valid_sha("abc1234"));
        assert!(valid_sha("0123456789abcdef0123456789abcdef01234567"));
        assert!(!valid_sha("abc123")); // 6 chars
        assert!(!valid_sha("ABC1234")); // uppercase
        assert!(!valid_sha("abc123g")); // non-hex
        assert!(!valid_sha("")); // empty
        assert!(!valid_sha("0123456789abcdef0123456789abcdef012345678")); // 41 chars
        assert!(!valid_sha("abc 123")); // space
    }

    #[test]
    fn path_within_only_accepts_descendants() {
        let base = PathBuf::from("/data/worktrees");
        assert!(path_within(
            &base,
            &PathBuf::from("/data/worktrees/proj/abc123")
        ));
        assert!(path_within(&base, &base));
        assert!(!path_within(&base, &PathBuf::from("/data/other")));
        assert!(!path_within(&base, &PathBuf::from("/data")));
    }

    #[test]
    fn detects_the_package_manager_from_the_lockfile() {
        let dir = std::env::temp_dir().join(format!("piwi-pm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(detect_package_manager(&dir), PackageManager::Npm);
        std::fs::write(dir.join("yarn.lock"), "").unwrap();
        assert_eq!(detect_package_manager(&dir), PackageManager::Yarn);
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        // pnpm wins when both are present (checked first).
        assert_eq!(detect_package_manager(&dir), PackageManager::Pnpm);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_commands_are_frozen() {
        assert_eq!(PackageManager::Npm.install_command(), ("npm", &["ci"][..]));
        assert_eq!(
            PackageManager::Pnpm.install_command(),
            ("pnpm", &["install", "--frozen-lockfile"][..])
        );
        assert_eq!(
            PackageManager::Yarn.install_command(),
            ("yarn", &["install", "--frozen-lockfile"][..])
        );
    }

    #[test]
    fn files_equal_compares_bytes_and_requires_both() {
        let dir = std::env::temp_dir().join(format!("piwi-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a");
        let b = dir.join("b");
        std::fs::write(&a, "same").unwrap();
        std::fs::write(&b, "same").unwrap();
        assert!(files_equal(&a, &b));
        std::fs::write(&b, "different").unwrap();
        assert!(!files_equal(&a, &b));
        assert!(!files_equal(&a, &dir.join("missing")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_a_bisect_step() {
        let output = "Bisecting: 3 revisions left to test after this (roughly 2 steps)\n[a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0] fix the guard\n";
        let progress = parse_bisect_progress(output).expect("progress");
        assert_eq!(progress.revisions_left, 3);
        assert_eq!(progress.steps_remaining, 2);
        assert_eq!(
            progress.sha.as_deref(),
            Some("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")
        );
    }

    #[test]
    fn parses_a_bisect_step_without_a_step_estimate() {
        let output = "Bisecting: 0 revisions left to test after this\n[abcdef1234567] last one\n";
        let progress = parse_bisect_progress(output).expect("progress");
        assert_eq!(progress.revisions_left, 0);
        assert_eq!(progress.steps_remaining, 0);
        assert_eq!(progress.sha.as_deref(), Some("abcdef1234567"));
    }

    #[test]
    fn a_line_that_is_not_a_bisect_step_yields_nothing() {
        assert_eq!(parse_bisect_progress("nothing to see here"), None);
    }

    #[test]
    fn parses_the_first_bad_commit() {
        let output =
            "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 is the first bad commit\ncommit a1b2c3d4\nAuthor: Dev\n";
        assert_eq!(
            parse_first_bad(output).as_deref(),
            Some("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")
        );
        assert_eq!(parse_first_bad("still bisecting"), None);
    }

    fn cli() -> PathBuf {
        PathBuf::from("/repo/node_modules/@piwitests/reporter/dist/cli/index.js")
    }

    fn strings(args: &[String]) -> Vec<&str> {
        args.iter().map(String::as_str).collect()
    }

    #[test]
    fn a_lab_session_runs_piwi_flake_on_the_test_from_the_desktop_app() {
        let args = flake_lab_args(&cli(), 1842, &FlakeLabOptions::default());
        assert_eq!(
            strings(&args[1..]),
            ["flake", "1842", "--source", "desktop"]
        );
        assert_eq!(args[0], node_path(&cli()));
    }

    #[test]
    fn a_lab_session_passes_only_the_bounded_options() {
        let one = FlakeLabOptions {
            suspect: Some(2),
            all: false,
            runs: Some(6),
            budget_minutes: Some(20),
        };
        assert_eq!(
            strings(&flake_lab_args(&cli(), 7, &one)[1..]),
            [
                "flake",
                "7",
                "--suspect",
                "2",
                "--runs",
                "6",
                "--budget",
                "20m",
                "--source",
                "desktop"
            ]
        );
        let all = FlakeLabOptions {
            all: true,
            ..FlakeLabOptions::default()
        };
        assert_eq!(
            strings(&flake_lab_args(&cli(), 7, &all)[1..]),
            ["flake", "7", "--all", "--source", "desktop"]
        );
    }

    #[test]
    fn lab_options_out_of_bounds_are_refused() {
        assert!(FlakeLabOptions::default().validate().is_ok());
        let both = FlakeLabOptions {
            suspect: Some(1),
            all: true,
            ..FlakeLabOptions::default()
        };
        assert!(both.validate().is_err());
        for bad in [
            FlakeLabOptions {
                suspect: Some(0),
                ..FlakeLabOptions::default()
            },
            FlakeLabOptions {
                suspect: Some(51),
                ..FlakeLabOptions::default()
            },
            FlakeLabOptions {
                runs: Some(0),
                ..FlakeLabOptions::default()
            },
            FlakeLabOptions {
                runs: Some(101),
                ..FlakeLabOptions::default()
            },
            FlakeLabOptions {
                budget_minutes: Some(241),
                ..FlakeLabOptions::default()
            },
        ] {
            assert!(bad.validate().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_flake_bisect_step_asks_verify_for_one_step_and_saves_nothing() {
        assert_eq!(
            strings(&flake_bisect_args(&cli(), 1842)[1..]),
            ["flake", "verify", "1842", "--bisect", "--source", "desktop"]
        );
    }

    #[test]
    fn piwi_flake_reaches_this_app_with_its_token() {
        let env = flake_lab_env(&ServerInfo {
            port: 43210,
            token: "pd_secret".into(),
        });
        let get = |key: &str| env.iter().find(|(k, _)| *k == key).map(|(_, v)| v.as_str());
        assert_eq!(get("PIWI_DASHBOARD_URL"), Some("http://127.0.0.1:43210"));
        assert_eq!(get("PIWI_API_KEY"), Some("pd_secret"));
        assert_eq!(get("NO_COLOR"), Some("1"));
        // Nothing else: the webview cannot add a variable.
        assert_eq!(env.len(), 4);
    }

    #[test]
    fn a_reproduction_or_bisect_test_names_its_origin_and_cluster() {
        assert_eq!(
            origin_env("reproduce", Some("42")),
            [
                ("PIWI_ORIGIN", "reproduce".to_string()),
                ("PIWI_ORIGIN_REF", "42".to_string())
            ]
        );
        assert_eq!(
            origin_env("bisect", None),
            [("PIWI_ORIGIN", "bisect".to_string())]
        );
    }

    #[test]
    fn a_cluster_wins_over_the_chosen_reference_and_a_bad_reference_is_refused() {
        assert_eq!(
            origin_reference(Some(42), Some("job:ab12".into())),
            Ok(Some("42".to_string()))
        );
        assert_eq!(
            origin_reference(None, Some("job:ab12".into())),
            Ok(Some("job:ab12".to_string()))
        );
        assert_eq!(origin_reference(None, None), Ok(None));
        assert!(origin_reference(None, Some("a b".into())).is_err());
        assert!(origin_reference(None, Some(String::new())).is_err());
        assert!(origin_reference(None, Some("x".repeat(201))).is_err());
    }

    #[test]
    fn a_flake_step_exit_code_is_a_bisect_verdict() {
        assert_eq!(flake_step_verdict(Some(0)), Ok("good"));
        assert_eq!(flake_step_verdict(Some(1)), Ok("bad"));
        assert_eq!(flake_step_verdict(Some(125)), Ok("skip"));
        assert!(flake_step_verdict(Some(2)).is_err());
        assert!(flake_step_verdict(None).is_err());
    }

    #[test]
    fn a_lab_job_runs_piwi_flake_on_its_plan_file_and_prints_json() {
        let plan_file = PathBuf::from("/data/worktrees/3/lab-f00d.json");
        let args = lab_job_args(&cli(), &plan_file);
        assert_eq!(args[0], node_path(&cli()));
        assert_eq!(
            strings(&args[1..]),
            [
                "flake",
                "--plan",
                "/data/worktrees/3/lab-f00d.json",
                "--json"
            ]
        );
    }

    fn lab_request(kind: &str, status: &str, commit: &str) -> serde_json::Value {
        serde_json::json!({
            "id": "f00d",
            "kind": kind,
            "status": status,
            "job": { "commit": commit, "plan": { "version": 1, "kind": "reproduce" } },
        })
    }

    #[test]
    fn a_lab_job_is_read_from_a_started_flake_lab_request() {
        let (commit, plan) =
            parse_lab_job(&lab_request("flake-lab", "running", "ABCDEF1234567")).unwrap();
        assert_eq!(commit, "abcdef1234567");
        assert_eq!(
            plan,
            serde_json::json!({ "version": 1, "kind": "reproduce" })
        );

        assert!(parse_lab_job(&lab_request("bisect", "running", "abcdef1")).is_err());
        assert!(parse_lab_job(&lab_request("flake-lab", "waiting", "abcdef1")).is_err());
        assert!(parse_lab_job(&lab_request("flake-lab", "running", "HEAD~1")).is_err());
        assert!(parse_lab_job(&lab_request("flake-lab", "running", "--detach")).is_err());
        let no_plan = serde_json::json!({
            "kind": "flake-lab",
            "status": "running",
            "job": { "commit": "abcdef1", "plan": null },
        });
        assert!(parse_lab_job(&no_plan).is_err());
    }

    #[test]
    fn the_lab_report_is_the_json_object_its_output_ends_with() {
        let report = "{\n  \"kind\": \"reproduce\",\n  \"verdict\": \"reproduced\"\n}\n";
        assert_eq!(
            parse_lab_report(report),
            Some(serde_json::json!({ "kind": "reproduce", "verdict": "reproduced" }))
        );
        let after_a_warning = format!("(node:42) ExperimentalWarning: something\n{report}");
        assert_eq!(parse_lab_report(&after_a_warning), parse_lab_report(report));
        assert_eq!(parse_lab_report(""), None);
        assert_eq!(parse_lab_report("piwi flake: cannot read the plan\n"), None);
        assert_eq!(parse_lab_report("{ torn"), None);
        assert_eq!(parse_lab_report("[1, 2]"), None);
    }

    #[test]
    fn a_lab_jobs_plan_file_sits_beside_the_worktrees_never_in_one() {
        let root = PathBuf::from("/data/worktrees");
        let plan = lab_plan_path(&root, "3", "f00d");
        assert_eq!(plan, root.join("3").join("lab-f00d.json"));
        assert!(!plan.starts_with(root.join("3").join("lab-job-abcdef123456")));
    }

    #[test]
    fn reads_the_project_and_the_failure_commit_from_the_plan() {
        let plan = serde_json::json!({ "projectId": 3, "failureCommit": "ABCDEF1234567" });
        assert_eq!(
            parse_flake_target(&plan),
            Ok(("3".to_string(), Some("abcdef1234567".to_string())))
        );
        let no_commit = serde_json::json!({ "projectId": 3, "failureCommit": null });
        assert_eq!(parse_flake_target(&no_commit), Ok(("3".to_string(), None)));
        assert!(parse_flake_target(&serde_json::json!({})).is_err());
    }

    #[test]
    fn reads_a_dirty_checkout_from_git_status() {
        assert!(!is_dirty(""));
        assert!(!is_dirty("\n"));
        assert!(is_dirty(" M tests/a.spec.ts\n"));
        assert!(is_dirty("?? notes.txt\n"));
    }

    /// A git repository with one commit, removed when the test ends.
    struct Repo {
        dir: PathBuf,
        git: PathBuf,
    }

    impl Repo {
        fn new(label: &str) -> Option<Self> {
            let git = resolve_tool_in(
                &std::env::var_os("PATH")
                    .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
                    .unwrap_or_default(),
                &tool_candidates("git"),
            )?;
            let dir = std::env::temp_dir().join(format!("piwi-wt-{label}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("repo")).unwrap();
            let repo = Self { dir, git };
            repo.run(&["init", "-q"]);
            std::fs::write(repo.folder().join("a.spec.ts"), "committed\n").unwrap();
            repo.run(&["add", "."]);
            repo.run(&[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "-m",
                "one",
            ]);
            Some(repo)
        }
        fn folder(&self) -> PathBuf {
            self.dir.join("repo")
        }
        fn run(&self, args: &[&str]) -> String {
            let out = Command::new(&self.git)
                .arg("-C")
                .arg(self.folder())
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).to_string()
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn a_lab_worktree_leaves_a_dirty_checkout_as_it_is() {
        let Some(repo) = Repo::new("dirty") else {
            return; // no git on this machine
        };
        let head = repo.run(&["rev-parse", "HEAD"]).trim().to_string();
        std::fs::write(repo.folder().join("a.spec.ts"), "edited, not committed\n").unwrap();
        std::fs::write(repo.folder().join("notes.txt"), "untracked\n").unwrap();
        let status = repo.run(&["status", "--porcelain"]);
        assert!(is_dirty(&status));

        let root = repo.dir.join("worktrees");
        let worktree =
            add_worktree_in(&root, &repo.git, &repo.folder(), "3", "flake-", &head, 7).unwrap();

        assert_eq!(
            worktree,
            root.join("3").join(format!("flake-{}-7", &head[..12]))
        );
        assert_eq!(
            std::fs::read_to_string(worktree.join("a.spec.ts")).unwrap(),
            "committed\n"
        );
        assert!(!worktree.join("notes.txt").exists());
        // The checkout keeps its HEAD, its edit and its untracked file.
        assert_eq!(repo.run(&["rev-parse", "HEAD"]).trim(), head);
        assert_eq!(repo.run(&["status", "--porcelain"]), status);
        assert_eq!(
            std::fs::read_to_string(repo.folder().join("a.spec.ts")).unwrap(),
            "edited, not committed\n"
        );

        perform_cleanup(
            &Cleanup {
                git: repo.git.clone(),
                folder: repo.folder(),
                worktree: worktree.clone(),
                bisect: false,
            },
            &AtomicBool::new(false),
        );
        assert!(!worktree.exists());
        assert_eq!(repo.run(&["status", "--porcelain"]), status);
    }

    #[test]
    fn a_commit_the_checkout_does_not_have_asks_for_a_fetch() {
        let Some(repo) = Repo::new("missing") else {
            return;
        };
        let err = add_worktree_in(
            &repo.dir.join("worktrees"),
            &repo.git,
            &repo.folder(),
            "3",
            "flake-",
            "0123456789abcdef0123456789abcdef01234567",
            1,
        )
        .unwrap_err();
        assert!(err.contains("git fetch"), "{err}");
    }

    #[test]
    fn jobs_at_the_same_commit_each_get_their_own_worktree() {
        let Some(repo) = Repo::new("same-commit") else {
            return;
        };
        let head = repo.run(&["rev-parse", "HEAD"]).trim().to_string();
        let root = repo.dir.join("worktrees");
        let first = add_worktree_in(&root, &repo.git, &repo.folder(), "3", "", &head, 1).unwrap();
        let second = add_worktree_in(&root, &repo.git, &repo.folder(), "3", "", &head, 2).unwrap();
        assert_ne!(first, second);
        assert!(first.join("a.spec.ts").is_file());

        perform_cleanup(
            &Cleanup {
                git: repo.git.clone(),
                folder: repo.folder(),
                worktree: second.clone(),
                bisect: false,
            },
            &AtomicBool::new(false),
        );
        assert!(!second.exists());
        assert!(first.join("a.spec.ts").is_file());
    }

    #[test]
    fn leftover_worktrees_are_moved_aside_and_deleted() {
        let dir = std::env::temp_dir().join(format!("piwi-leftover-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("worktrees").join("3").join("abc-1")).unwrap();
        std::fs::create_dir_all(dir.join(format!("{DISCARDED_PREFIX}old"))).unwrap();
        std::fs::create_dir_all(dir.join(".data")).unwrap();

        discard_leftover_worktrees(&dir);
        assert!(!dir.join("worktrees").exists());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let left = || {
            std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect::<Vec<_>>()
        };
        while left() != [".data"] && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(left(), [".data"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_reporter_cli_comes_from_the_linked_folder_first() {
        let dir = std::env::temp_dir().join(format!("piwi-cli-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let folder = dir.join("folder");
        let worktree = dir.join("worktree");
        let install = |at: &Path| {
            let cli = at.join("node_modules").join(REPORTER_CLI);
            std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
            std::fs::write(&cli, "").unwrap();
            cli
        };
        std::fs::create_dir_all(&folder).unwrap();
        let in_worktree = install(&worktree);
        assert_eq!(resolve_reporter_cli(&folder, &worktree), Some(in_worktree));
        let in_folder = install(&folder);
        assert_eq!(resolve_reporter_cli(&folder, &worktree), Some(in_folder));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolves_a_tool_in_the_first_dir_that_holds_it() {
        let dir = std::env::temp_dir().join(format!("piwi-tool-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = dir.join("a");
        let b = dir.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("git"), "").unwrap();
        let candidates = vec!["git".to_string()];
        assert_eq!(
            resolve_tool_in(&[a.clone(), b.clone()], &candidates),
            Some(b.join("git"))
        );
        assert_eq!(resolve_tool_in(&[a], &candidates), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
