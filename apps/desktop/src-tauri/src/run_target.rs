// The desktop app as a run target of one team instance (Run on my machine).
//
// The bundled server runs the request host and asks the person in the window;
// the shell keeps what must stay on this machine and starts the runs:
//
// - the instance's key, in the OS keychain, never in the window: the shell
//   takes it from the server once the device flow gave it, and hands it back
//   after each start of the server (`hand_kept_key`);
// - the folders linked to the instance's projects, per instance, in
//   `settings.json`, so connecting to an earlier instance finds them again;
// - the run after **Run**: the shell takes the request token and the command
//   from the server itself, writes the token to a file this user alone reads,
//   starts the folder's Playwright with it, tells the server the run started
//   and ended, and stops it when the requester stops it from the dashboard.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager as _};
use tauri_plugin_store::StoreExt as _;

use crate::mcp_clients::ServerInfo;
use crate::STORE_FILE;

/// Store key of the instance the app takes run requests from.
const INSTANCE_KEY: &str = "runTargetInstance";
/// Store key of `{ instance → { project id → folder } }`.
const LINKS_KEY: &str = "instanceLinks";
/// The keychain service Piwi Dashboard keeps the instance's key under.
const DESKTOP_KEYCHAIN_SERVICE: &str = "Piwi Desktop run requests";
/// The keychain service Piwi Runner keeps the instance's key under: the two apps are on the same machine, and each
/// holds its own key for the same instance.
const RUNNER_KEYCHAIN_SERVICE: &str = "Piwi Runner run requests";
/// The start of the name of each requested run's private folder in the temp dir, per app, so neither app's sweep
/// (`sweep_leftover_request_dirs`) reaches the other's.
const REQUEST_DIR_PREFIX: &str = if cfg!(feature = "runner") {
    "piwi-runner-request-"
} else {
    "piwi-request-"
};
/// How old a requested run's folder left in the temp dir by an earlier launch must be before the sweep at startup
/// removes it.
const LEFTOVER_REQUEST_DIR_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// The most characters a requested run's arguments may take, each counted with one separator, as the editor counts
/// them (`REQUESTED_RUN_ARGS_MAX_CHARS` in `packages/editor/src/request-run.ts`).
const REQUEST_ARGS_MAX_CHARS: usize = 24_000;
/// How long the server gets, as the app quits, to take the end of each requested run still held.
const QUIT_END_TIMEOUT: Duration = Duration::from_secs(2);
/// The keychain service the instance's key is kept under, its account the instance's URL.
const KEYCHAIN_SERVICE: &str = if cfg!(feature = "runner") {
    RUNNER_KEYCHAIN_SERVICE
} else {
    DESKTOP_KEYCHAIN_SERVICE
};

/// The key read from the keychain, so it is read once a launch.
#[derive(Default)]
pub struct KeptKey(Mutex<Option<(String, String)>>);

/// The run each requested run started, by request id, for a stop from the
/// dashboard, and whether the app is quitting.
#[derive(Default)]
pub struct RequestedRuns(Mutex<HashMap<String, RequestedRun>>, AtomicBool);

/// A requested run the shell is starting or running: its run id once spawned,
/// whether the dashboard stopped it before then, the linked folder it runs in
/// and its private folder once checked, and how it ended until the server has
/// taken that.
#[derive(Default)]
pub struct RequestedRun {
    run: Option<u32>,
    stop: bool,
    folder: Option<PathBuf>,
    dir: Option<PathBuf>,
    ended: Option<(Option<i32>, bool)>,
}

impl RequestedRuns {
    /// Take `folder` for request `id`, with its private folder `dir`, unless
    /// another requested run holds it. Answers whether a stop came for it
    /// meanwhile.
    fn hold_folder(&self, id: &str, folder: &Path, dir: &Path) -> Result<bool, String> {
        let mut runs = self.0.lock().unwrap();
        if runs.iter().any(|(other, run)| other != id && run.folder.as_deref() == Some(folder)) {
            return Err(FOLDER_BUSY.into());
        }
        let held = runs.entry(id.to_string()).or_default();
        held.folder = Some(folder.to_path_buf());
        held.dir = Some(dir.to_path_buf());
        Ok(held.stop)
    }

    /// Forget every requested run still held, removing each one's private
    /// folder, and hand each request id to `end` with how its run ended: a run
    /// with no end yet ends stopped. Called as the app quits.
    fn end_all(&self, mut end: impl FnMut(&str, Option<i32>, bool)) {
        let held: Vec<(String, RequestedRun)> = self.0.lock().unwrap().drain().collect();
        for (id, run) in held {
            if let Some(dir) = &run.dir {
                let _ = std::fs::remove_dir_all(dir);
            }
            let (code, stopped) = run.ended.unwrap_or((None, true));
            end(&id, code, stopped);
        }
    }

    /// The request ids held now, starting or running, which the server is
    /// told of after each start so it ends only the requests the shell lost.
    fn ids(&self) -> Vec<String> {
        let runs = self.0.lock().unwrap();
        let mut ids: Vec<String> =
            runs.iter().filter(|(_, run)| run.ended.is_none()).map(|(id, _)| id.clone()).collect();
        ids.sort();
        ids
    }

    /// How each held run ended that the server has not taken yet, by request
    /// id: its exit code and whether it was stopped.
    fn outcomes(&self) -> Vec<(String, Option<i32>, bool)> {
        let runs = self.0.lock().unwrap();
        let mut outcomes: Vec<_> = runs
            .iter()
            .filter_map(|(id, run)| run.ended.map(|(code, stopped)| (id.clone(), code, stopped)))
            .collect();
        outcomes.sort();
        outcomes
    }

    /// Keep how the run of request `id` ended until the server takes it; its
    /// folders are free from then on.
    fn end(&self, id: &str, code: Option<i32>, stopped: bool) {
        if let Some(held) = self.0.lock().unwrap().get_mut(id) {
            held.ended = Some((code, stopped));
            held.run = None;
            held.folder = None;
            held.dir = None;
        }
    }

    /// The server took how the run of request `id` ended: forget the request.
    /// A request whose run has not ended stays.
    fn told_ended(&self, id: &str) {
        let mut runs = self.0.lock().unwrap();
        if runs.get(id).is_some_and(|run| run.ended.is_some()) {
            runs.remove(id);
        }
    }

    /// Forget the ended requests the server names in the `ended` of its answer.
    fn told_ended_in(&self, answer: &Value) {
        for id in answer.get("ended").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            self.told_ended(id);
        }
    }

    /// The app is quitting: from now on the quit tells the server how the
    /// held runs ended (`end_all`).
    fn quit(&self) {
        let _held = self.0.lock().unwrap();
        self.1.store(true, Ordering::SeqCst);
    }

    /// Whether the app is quitting (`quit`).
    fn quitting(&self) -> bool {
        self.1.load(Ordering::SeqCst)
    }

    /// The private folders of the requested runs held now.
    fn dirs(&self) -> HashSet<PathBuf> {
        self.0.lock().unwrap().values().filter_map(|run| run.dir.clone()).collect()
    }

    /// Mark request `id` stopped and answer the run it started; `None` for a
    /// request still starting, whose run is stopped once it has an id, or one
    /// not held here.
    fn stop(&self, id: &str) -> Option<u32> {
        let mut runs = self.0.lock().unwrap();
        let held = runs.get_mut(id).filter(|held| held.ended.is_none())?;
        held.stop = true;
        held.run
    }
}

/// Tell the server how the run of request `id` ended, and forget the request
/// once it took that. Otherwise the shell keeps it, for the next server start
/// (`hand_kept_key`) or the quit (`end_all`).
fn tell_ended(
    server: &ServerInfo,
    runs: &RequestedRuns,
    id: &str,
    code: Option<i32>,
    stopped: bool,
) -> Result<(), String> {
    local_call(
        server,
        "POST",
        &format!("/api/desktop/run-target/requests/{id}/ended"),
        Some(&json!({ "code": code, "stopped": stopped })),
    )?;
    runs.told_ended(id);
    Ok(())
}

/// The ended runs for the server, as `PUT /key` hands them.
fn outcomes_json(runs: &RequestedRuns) -> Vec<Value> {
    runs.outcomes()
        .into_iter()
        .map(|(id, code, stopped)| json!({ "id": id, "code": code, "stopped": stopped }))
        .collect()
}

/// Why a requested run does not start in a folder another run is going in.
const FOLDER_BUSY: &str = "another run is going in the linked folder: run this one once it ends";

/// Whether a requested run's arguments stay within `REQUEST_ARGS_MAX_CHARS`,
/// counted in UTF-16 units as the editor counts them.
fn args_within_cap(args: &[String]) -> bool {
    args.iter().map(|arg| arg.encode_utf16().count() + 1).sum::<usize>() <= REQUEST_ARGS_MAX_CHARS
}

/// The app is quitting: a requested run that ends from now on is told to the
/// server by `end_requested_runs_on_quit` alone. Runs before the local runs
/// are stopped.
pub(crate) fn quit_requested_runs(app: &AppHandle) {
    if let Some(runs) = app.try_state::<RequestedRuns>() {
        runs.quit();
    }
}

/// The app is quitting: tell the server, while it is still up, that every
/// requested run it still holds ended, and remove their private folders. Runs
/// before the server stops (`shut_down`), after the local runs were stopped.
pub(crate) fn end_requested_runs_on_quit(app: &AppHandle) {
    let Some(runs) = app.try_state::<RequestedRuns>() else {
        return;
    };
    let server = server_info(app);
    runs.end_all(|id, code, stopped| {
        if let Some(server) = &server {
            let _ = local_call_within(
                server,
                "POST",
                &format!("/api/desktop/run-target/requests/{id}/ended"),
                Some(&json!({ "code": code, "stopped": stopped })),
                QUIT_END_TIMEOUT,
            );
        }
    });
}

/// Remove the requested runs' private folders an earlier launch left in the
/// temp dir: only this app's, only those older than `LEFTOVER_REQUEST_DIR_AGE`,
/// never one a requested run of this launch holds. On its own thread, at startup.
pub(crate) fn sweep_leftover_request_dirs(app: &AppHandle) {
    let in_use = app.try_state::<RequestedRuns>().map(|runs| runs.dirs()).unwrap_or_default();
    std::thread::spawn(move || {
        sweep_request_dirs(&std::env::temp_dir(), REQUEST_DIR_PREFIX, LEFTOVER_REQUEST_DIR_AGE, &in_use);
    });
}

/// Remove each folder in `root` named `prefix…` that is older than `age` and
/// not in `in_use`. A link or a file of that name is left alone.
fn sweep_request_dirs(root: &Path, prefix: &str, age: Duration, in_use: &HashSet<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with(prefix) {
            continue;
        }
        let Ok(meta) = entry.path().symlink_metadata() else {
            continue;
        };
        let old = meta
            .modified()
            .ok()
            .and_then(|at| now.duration_since(at).ok())
            .is_some_and(|since| since >= age);
        let path = entry.path();
        if meta.is_dir() && old && !in_use.contains(&path) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// A request id: 32 lowercase hex digits, as `@piwitests/core/run-request` writes it.
pub(crate) fn valid_request_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// An instance URL the server named: http(s), with no space or control character.
fn valid_instance(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://"))
        && url.len() <= 500
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn connected_instance(app: &AppHandle) -> Option<String> {
    app.store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(INSTANCE_KEY))
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|url| valid_instance(url))
}

fn all_links(app: &AppHandle) -> HashMap<String, HashMap<String, String>> {
    app.store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(LINKS_KEY))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// The folders linked for `instance`'s projects.
fn links_of(app: &AppHandle, instance: &str) -> HashMap<String, String> {
    all_links(app).remove(instance).unwrap_or_default()
}

fn write_links(app: &AppHandle, instance: &str, links: HashMap<String, String>) -> Result<(), String> {
    let mut all = all_links(app);
    if links.is_empty() {
        all.remove(instance);
    } else {
        all.insert(instance.to_string(), links);
    }
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(LINKS_KEY, json!(all));
    store.save().map_err(|e| e.to_string())
}

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
mod keychain {
    use super::KEYCHAIN_SERVICE;

    fn entry(instance: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, instance).map_err(|e| e.to_string())
    }

    pub fn keep(instance: &str, key: &str) -> Result<(), String> {
        entry(instance)?.set_password(key).map_err(|e| e.to_string())
    }

    pub fn read(instance: &str) -> Result<Option<String>, String> {
        match entry(instance)?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn forget(instance: &str) -> Result<(), String> {
        match entry(instance)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod keychain {
    const NONE: &str = "this system has no keychain the app can use";
    pub fn keep(_: &str, _: &str) -> Result<(), String> {
        Err(NONE.into())
    }
    pub fn read(_: &str) -> Result<Option<String>, String> {
        Err(NONE.into())
    }
    pub fn forget(_: &str) -> Result<(), String> {
        Ok(())
    }
}

fn server_info(app: &AppHandle) -> Option<ServerInfo> {
    app.try_state::<ServerInfo>().map(|server| ServerInfo {
        port: server.port,
        token: server.token.clone(),
    })
}

/// Call the bundled server with the app's token: `path` is built from validated
/// parts only. Answers the JSON body of a 2xx, or the server's message. The token
/// goes only to a server that first proves it holds it
/// ([`crate::connect_proving_token`]).
pub(crate) fn local_call(
    server: &ServerInfo,
    method: &str,
    path: &str,
    body: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    local_call_within(server, method, path, body, Duration::from_secs(60))
}

/// `local_call`, waiting at most `timeout` for each read of the answer.
fn local_call_within(
    server: &ServerInfo,
    method: &str,
    path: &str,
    body: Option<&serde_json::Value>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    use std::io::{Read, Write};
    let mut stream = crate::connect_proving_token(server.port, &server.token)?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    stream
        .write_all(local_request(server, method, path, body).as_bytes())
        .map_err(|e| e.to_string())?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).map_err(|e| e.to_string())?;
    let body = crate::repro::http_body(&response)?;
    if body.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_slice(body).map_err(|_| "the local server sent something other than JSON".to_string())
}

/// The request `local_call` sends. Every method that sends a body (all but GET and DELETE) says
/// it is JSON, with or without one, as the server's routes require.
fn local_request(server: &ServerInfo, method: &str, path: &str, body: Option<&serde_json::Value>) -> String {
    let payload = body.map(|b| b.to_string()).unwrap_or_default();
    let mut request = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nx-piwi-token: {}\r\nAccept: application/json\r\nConnection: close\r\n",
        server.port, server.token
    );
    if !matches!(method, "GET" | "DELETE") {
        request.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            payload.len()
        ));
    }
    request.push_str("\r\n");
    request.push_str(&payload);
    request
}

fn log(app: &AppHandle, line: &str) {
    if let Some(log) = app.try_state::<crate::LogFile>() {
        crate::append_log(&log.0, &format!("run requests: {line}"));
    }
}

/// Hand the server the kept key of the connected instance, with its folders,
/// the requested runs held (`running`), how the held runs that ended did end
/// (`ended`, forgotten once the server names them back) and the folders the
/// local runs are going in (`localRuns`): after each start of the server, and
/// whenever the folders change. Nothing without a connected instance, so the keychain is
/// read only then.
pub(crate) fn hand_kept_key(app: &AppHandle) {
    let Some(instance) = connected_instance(app) else {
        return;
    };
    let Some(server) = server_info(app) else {
        return;
    };
    let cached = app
        .try_state::<KeptKey>()
        .and_then(|kept| kept.0.lock().unwrap().clone())
        .filter(|(url, _)| *url == instance)
        .map(|(_, key)| key);
    let key = match cached {
        Some(key) => key,
        None => match keychain::read(&instance) {
            Ok(Some(key)) => {
                if let Some(kept) = app.try_state::<KeptKey>() {
                    *kept.0.lock().unwrap() = Some((instance.clone(), key.clone()));
                }
                key
            }
            Ok(None) => {
                log(app, "no key in the keychain for the connected instance");
                return;
            }
            Err(e) => {
                log(app, &format!("could not read the key from the keychain: {e}"));
                return;
            }
        },
    };
    let runs = app.try_state::<RequestedRuns>();
    let body = json!({
        "instance": instance,
        "key": key,
        "links": links_of(app, &instance),
        "running": runs.as_ref().map(|runs| runs.ids()).unwrap_or_default(),
        "ended": runs.as_ref().map(|runs| outcomes_json(runs)).unwrap_or_default(),
        "localRuns": local_runs(app),
    });
    match local_call(&server, "PUT", "/api/desktop/run-target/key", Some(&body)) {
        Ok(answer) => {
            if let Some(runs) = &runs {
                runs.told_ended_in(&answer);
            }
        }
        Err(e) => log(app, &format!("could not hand the key to the server: {e}")),
    }
}

/// The linked folders the local runs are going in, requested runs among them.
fn local_runs(app: &AppHandle) -> Vec<String> {
    let folders = app.try_state::<crate::runner::LocalRuns>().map(|runs| runs.folders()).unwrap_or_default();
    folders.iter().map(|folder| folder.to_string_lossy().into_owned()).collect()
}

/// Tell the server the folders the local runs are going in, after a local run
/// started or ended, so a request waiting for one of them is checked again
/// once it frees up. On its own thread, one call at a time, each sending the
/// folders as they are when it is made; nothing without a connected instance.
pub(crate) fn hand_local_runs(app: &AppHandle) {
    static SENDING: Mutex<()> = Mutex::new(());
    if connected_instance(app).is_none() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let _sending = SENDING.lock().unwrap_or_else(|e| e.into_inner());
        let Some(server) = server_info(&app) else {
            return;
        };
        let body = json!({ "folders": local_runs(&app) });
        if let Err(e) = local_call(&server, "PUT", "/api/desktop/run-target/local-runs", Some(&body)) {
            log(&app, &format!("could not tell the server the local runs: {e}"));
        }
    });
}

fn hand_links(app: &AppHandle, instance: &str) -> Result<(), String> {
    let server = server_info(app).ok_or("the local server is not running")?;
    let body = json!({ "links": links_of(app, instance) });
    local_call(&server, "PUT", "/api/desktop/run-target/links", Some(&body)).map(|_| ())
}

/// Keep the key the device flow just gave in the keychain, and connect with it.
#[tauri::command]
pub async fn desktop_keep_run_target_key(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let server = server_info(&app).ok_or("the local server is not running")?;
        let answer = local_call(&server, "POST", "/api/desktop/run-target/key", None)?;
        let instance = answer.get("instance").and_then(|v| v.as_str()).unwrap_or_default();
        let key = answer.get("key").and_then(|v| v.as_str()).unwrap_or_default();
        if !valid_instance(instance) || !key.starts_with("pd_") {
            return Err("the local server named no key to keep".to_string());
        }
        if let Some(previous) = connected_instance(&app).filter(|p| p != instance) {
            let _ = keychain::forget(&previous);
        }
        keychain::keep(instance, key).map_err(|e| format!("could not keep the key in the keychain: {e}"))?;
        let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
        store.set(INSTANCE_KEY, json!(instance));
        store.save().map_err(|e| e.to_string())?;
        if let Some(kept) = app.try_state::<KeptKey>() {
            *kept.0.lock().unwrap() = Some((instance.to_string(), key.to_string()));
        }
        hand_kept_key(&app);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Forget the connected instance on this machine: its key leaves the keychain
/// and the cache, and the instance leaves the store. The folders stay, for a
/// later connection to the same instance.
fn forget_kept_key(app: &AppHandle) -> Result<(), String> {
    if let Some(instance) = connected_instance(app) {
        keychain::forget(&instance).map_err(|e| format!("could not remove the key from the keychain: {e}"))?;
    }
    if let Some(kept) = app.try_state::<KeptKey>() {
        *kept.0.lock().unwrap() = None;
    }
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.delete(INSTANCE_KEY);
    store.save().map_err(|e| e.to_string())
}

/// Disconnect from the instance: the key leaves the keychain and the server.
/// The folders stay, for a later connection to the same instance.
#[tauri::command]
pub async fn desktop_forget_run_target(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        forget_kept_key(&app)?;
        if let Some(server) = server_info(&app) {
            local_call(&server, "DELETE", "/api/desktop/run-target/key", None)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The instance revoked the key of the connected instance: forget it here, so
/// the next start of the server does not hand it back. Nothing for another
/// instance than the connected one, whose key is not the one revoked.
fn key_revoked(app: &AppHandle, instance: &str) {
    if connected_instance(app).as_deref() != Some(instance) {
        return;
    }
    if let Err(e) = forget_kept_key(app) {
        log(app, &format!("could not forget the revoked key: {e}"));
    }
}

/// The folders linked for the connected instance's projects.
#[tauri::command]
pub fn desktop_request_folders(app: AppHandle) -> HashMap<String, String> {
    connected_instance(&app)
        .map(|instance| links_of(&app, &instance))
        .unwrap_or_default()
}

/// Pick the folder of one of the connected instance's projects. `None` when the
/// person cancels.
#[tauri::command]
pub async fn desktop_link_request_folder(app: AppHandle, project_id: String) -> Result<Option<String>, String> {
    if !crate::runner::valid_project_id(&project_id) {
        return Err("invalid project id".into());
    }
    let instance = connected_instance(&app).ok_or("no team instance is connected")?;
    let Some(folder) = crate::runner::desktop_pick_folder(app.clone()).await else {
        return Ok(None);
    };
    let mut links = links_of(&app, &instance);
    links.insert(project_id, folder.clone());
    write_links(&app, &instance, links)?;
    let handed = app.clone();
    tauri::async_runtime::spawn_blocking(move || hand_links(&handed, &instance))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Some(folder))
}

/// Unlink the folder of one of the connected instance's projects.
#[tauri::command]
pub async fn desktop_unlink_request_folder(app: AppHandle, project_id: String) -> Result<(), String> {
    if !crate::runner::valid_project_id(&project_id) {
        return Err("invalid project id".into());
    }
    let instance = connected_instance(&app).ok_or("no team instance is connected")?;
    let mut links = links_of(&app, &instance);
    links.remove(&project_id);
    write_links(&app, &instance, links)?;
    let handed = app.clone();
    tauri::async_runtime::spawn_blocking(move || hand_links(&handed, &instance))
        .await
        .map_err(|e| e.to_string())?
}

/// What the server answers the shell for a request after **Run**.
struct Launch {
    instance: String,
    token: String,
    project_id: String,
    /// The folder **Run** approved, which the run's folder must still be.
    folder: String,
    args: Vec<String>,
}

fn launch_of(server: &ServerInfo, request_id: &str) -> Result<Launch, String> {
    let answer = local_call(
        server,
        "POST",
        &format!("/api/desktop/run-target/requests/{request_id}/launch"),
        Some(&json!({})),
    )?;
    let text = |name: &str| answer.get(name).and_then(|v| v.as_str()).map(str::to_string);
    let instance = text("instance")
        .filter(|url| valid_instance(url))
        .ok_or("no instance to run for")?;
    let token = text("token")
        .filter(|t| t.len() == 68 && t.starts_with("pdq_") && t[4..].bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("no request token")?;
    let project_id = answer
        .get("projectId")
        .and_then(|v| v.as_u64())
        .map(|id| id.to_string())
        .ok_or("no project")?;
    let folder = text("folder").filter(|f| !f.is_empty()).ok_or("no folder")?;
    let args = answer
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .ok_or("no command")?;
    Ok(Launch {
        instance,
        token,
        project_id,
        folder,
        args,
    })
}

/// Tell the server a requested run started, or why it could not.
fn tell_started(server: &ServerInfo, request_id: &str, error: Option<&str>) {
    let body = match error {
        Some(error) => json!({ "error": error }),
        None => json!({}),
    };
    let _ = local_call(
        server,
        "POST",
        &format!("/api/desktop/run-target/requests/{request_id}/started"),
        Some(&body),
    );
}

/// Start the run of a request after **Run** in the window: the command and the
/// request token come from the server, the folder from this machine's links.
/// Returns the run id; its output arrives as `piwi:local-run` events.
#[tauri::command]
pub async fn desktop_run_requested_tests(app: AppHandle, request_id: String) -> Result<u32, String> {
    if !valid_request_id(&request_id) {
        return Err("invalid request id".into());
    }
    let server = server_info(&app).ok_or("the local server is not running")?;
    let asked = request_id.clone();
    let launch_server = ServerInfo {
        port: server.port,
        token: server.token.clone(),
    };
    // Held before the server hands the launch over, so a stop that arrives from then on is kept for it. A request
    // already held is being launched or is running: a second call leaves its entry alone.
    if let Some(runs) = app.try_state::<RequestedRuns>() {
        let mut held = runs.0.lock().unwrap();
        if held.contains_key(&request_id) {
            return Err("this request is already starting or running".into());
        }
        held.insert(request_id.clone(), RequestedRun::default());
    }
    let forget = |app: &AppHandle, request_id: &str| {
        if let Some(runs) = app.try_state::<RequestedRuns>() {
            runs.0.lock().unwrap().remove(request_id);
        }
    };
    let launch = match tauri::async_runtime::spawn_blocking(move || launch_of(&launch_server, &asked))
        .await
        .map_err(|e| e.to_string())
        .and_then(|launched| launched)
    {
        Ok(launch) => launch,
        Err(e) => {
            forget(&app, &request_id);
            return Err(e);
        }
    };

    let prepared = prepare(&app, &launch);
    let (folder, cli, dir, token_file) = match prepared {
        Ok(prepared) => prepared,
        Err(e) => {
            forget(&app, &request_id);
            tell_started(&server, &request_id, Some(&e));
            return Err(e);
        }
    };

    // One requested run at a time in a folder; a stop that came while the run was being prepared ends it before
    // anything runs.
    let held = match app.try_state::<RequestedRuns>() {
        Some(runs) => runs.hold_folder(&request_id, &folder, &dir),
        None => Ok(false),
    };
    let stopped_early = match held {
        Ok(stop) => stop,
        Err(e) => {
            forget(&app, &request_id);
            let _ = std::fs::remove_dir_all(&dir);
            tell_started(&server, &request_id, Some(&e));
            return Err(e);
        }
    };
    if stopped_early {
        let _ = std::fs::remove_dir_all(&dir);
        if let Some(runs) = app.try_state::<RequestedRuns>() {
            runs.end(&request_id, None, true);
            if let Err(e) = tell_ended(&server, &runs, &request_id, None, true) {
                log(&app, &format!("could not tell the server a requested run ended: {e}"));
            }
        }
        return Err("the request was stopped before its run started".into());
    }

    let envs = vec![
        ("PIWI_DESKTOP_APP", "off".to_string()),
        ("PIWI_REQUEST_TOKEN_FILE", token_file.to_string_lossy().to_string()),
        ("PIWI_REQUEST_INSTANCE", launch.instance.clone()),
    ];
    let ended_app = app.clone();
    let ended_request = request_id.clone();
    let ended_dir = dir.clone();
    // The run's end stays held until the server took it, so a quit in between still sends it (`end_all`), and
    // only the quit sends an end once it began.
    let spawned = crate::runner::spawn_tests(&app, &folder, &cli, launch.args, envs, move |code, stopped| {
        let _ = std::fs::remove_dir_all(&ended_dir);
        let Some(runs) = ended_app.try_state::<RequestedRuns>() else {
            return;
        };
        runs.end(&ended_request, code, stopped);
        if runs.quitting() {
            return;
        }
        let app = ended_app.clone();
        std::thread::spawn(move || {
            let (Some(server), Some(runs)) = (server_info(&app), app.try_state::<RequestedRuns>()) else {
                return;
            };
            if let Err(e) = tell_ended(&server, &runs, &ended_request, code, stopped) {
                log(&app, &format!("could not tell the server a requested run ended: {e}"));
            }
        });
    })
    .await;
    match spawned {
        Ok(id) => {
            let stop_now = app.try_state::<RequestedRuns>().is_some_and(|runs| {
                let mut runs = runs.0.lock().unwrap();
                match runs.get_mut(&request_id) {
                    Some(held) => {
                        held.run = Some(id);
                        held.stop
                    }
                    // It already ended.
                    None => false,
                }
            });
            if stop_now {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::runner::desktop_stop_local_tests(app, id).await;
                });
            }
            std::thread::spawn(move || tell_started(&server, &request_id, None));
            Ok(id)
        }
        Err(e) => {
            forget(&app, &request_id);
            let _ = std::fs::remove_dir_all(&dir);
            tell_started(&server, &request_id, Some(&e));
            Err(e)
        }
    }
}

/// The folder of a launch from `connected`, the instance the app is connected
/// to, checked against the folders linked for its projects.
fn launch_folder(launch: &Launch, connected: Option<&str>, links: &HashMap<String, String>) -> Result<PathBuf, String> {
    if connected != Some(launch.instance.as_str()) {
        return Err("the request is not from the connected instance".into());
    }
    if launch.args.is_empty() {
        return Err("the request names no test to run".into());
    }
    crate::runner::validate_args(&launch.args)?;
    if !args_within_cap(&launch.args) {
        return Err(format!(
            "the command is longer than {REQUEST_ARGS_MAX_CHARS} characters: ask for fewer tests"
        ));
    }
    let linked = links.get(&launch.project_id).ok_or("no folder is linked to this project")?;
    if *linked != launch.folder {
        return Err("the folder linked to this project changed since Run: answer the request again".into());
    }
    let folder = PathBuf::from(linked);
    if !folder.is_dir() {
        return Err("the linked folder no longer exists: pick it again".into());
    }
    Ok(std::fs::canonicalize(&folder).unwrap_or(folder))
}

/// The folder, its Playwright, and the token file of a launch, checked.
fn prepare(app: &AppHandle, launch: &Launch) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), String> {
    let folder = launch_folder(launch, connected_instance(app).as_deref(), &links_of(app, &launch.instance))?;
    if app.try_state::<crate::runner::LocalRuns>().is_some_and(|runs| runs.runs_in(&folder)) {
        return Err(FOLDER_BUSY.into());
    }
    let cli = crate::runner::resolve_playwright_cli(&folder)
        .ok_or("no Playwright installation found in the linked folder: run your package manager's install first")?;
    let dir = crate::repro::private_run_dir(REQUEST_DIR_PREFIX).map_err(|e| e.to_string())?;
    let token_file = dir.join("request-token");
    if let Err(e) = crate::private_fs::write_private(&token_file, launch.token.as_bytes()) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e.to_string());
    }
    Ok((folder, cli, dir, token_file))
}

/// The requester stopped a request from the dashboard: stop the run it started.
pub(crate) fn stop_requested_run(app: &AppHandle, request_id: &str) {
    if !valid_request_id(request_id) {
        return;
    }
    if let Some(run_id) = app.try_state::<RequestedRuns>().and_then(|runs| runs.stop(request_id)) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::runner::desktop_stop_local_tests(app, run_id).await;
        });
    }
}

/// A command of the server on the shell's notification stream.
#[derive(Debug, PartialEq)]
enum ServerCommand {
    /// Stop the run a request started; the id is checked where it is used.
    StopRun(String),
    /// The instance revoked the key it gave the connected app.
    KeyRevoked(String),
}

/// The command `data` carries, or `None` when it is a notification to show.
/// A command with a value that does not pass is read all the same, so it is
/// never shown as a notification.
fn server_command(data: &str) -> Option<ServerCommand> {
    let value = serde_json::from_str::<serde_json::Value>(data).ok()?;
    let text = |name: &str| value.get(name).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    match value.get("type")?.as_str()? {
        "requested-run-stop" => Some(ServerCommand::StopRun(text("requestId"))),
        "key-revoked" => Some(ServerCommand::KeyRevoked(text("instance"))),
        _ => None,
    }
}

/// A command of the server on the shell's notification stream: `true` when
/// `data` was one, which then is no notification to show.
pub(crate) fn take_server_command(app: &AppHandle, data: &str) -> bool {
    match server_command(data) {
        Some(ServerCommand::StopRun(id)) => stop_requested_run(app, &id),
        Some(ServerCommand::KeyRevoked(instance)) if valid_instance(&instance) => key_revoked(app, &instance),
        Some(ServerCommand::KeyRevoked(_)) => {}
        None => return false,
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_id_is_32_lowercase_hex_digits() {
        assert!(valid_request_id(&"a1".repeat(16)));
        assert!(!valid_request_id(&"A1".repeat(16)));
        assert!(!valid_request_id("../../etc/passwd"));
        assert!(!valid_request_id(&"a".repeat(31)));
    }

    #[test]
    fn the_server_tells_the_shell_to_stop_a_run_or_to_forget_a_key() {
        let id = "a1".repeat(16);
        assert_eq!(
            server_command(&format!(r#"{{"type":"requested-run-stop","requestId":"{id}"}}"#)),
            Some(ServerCommand::StopRun(id))
        );
        assert_eq!(
            server_command(r#"{"type":"key-revoked","instance":"https://piwi.example.com"}"#),
            Some(ServerCommand::KeyRevoked("https://piwi.example.com".into()))
        );
        assert_eq!(server_command(r#"{"type":"key-revoked"}"#), Some(ServerCommand::KeyRevoked(String::new())));
        assert_eq!(server_command(r#"{"type":"notification","title":"x"}"#), None);
        assert_eq!(server_command("not json"), None);
    }

    #[test]
    fn an_instance_is_an_http_url_with_no_space() {
        assert!(valid_instance("https://piwi.example.com"));
        assert!(valid_instance("http://localhost:7494/team"));
        assert!(!valid_instance("file:///etc"));
        assert!(!valid_instance("https://piwi.example.com\r\nHost: x"));
    }

    fn server_at(port: u16) -> ServerInfo {
        ServerInfo {
            port,
            token: "pd_abc".into(),
        }
    }

    #[test]
    fn every_post_and_put_says_it_is_json_with_a_body_or_without() {
        let body = serde_json::json!({ "a": 1 });
        let put = local_request(&server_at(1), "PUT", "/p", Some(&body));
        assert!(put.contains("\r\nContent-Type: application/json\r\n"), "{put}");
        assert!(put.contains("\r\nContent-Length: 7\r\n"), "{put}");
        assert!(put.ends_with("\r\n\r\n{\"a\":1}"), "{put}");
        let bodiless = local_request(&server_at(1), "POST", "/p", None);
        assert!(bodiless.contains("\r\nContent-Type: application/json\r\n"), "{bodiless}");
        assert!(bodiless.contains("\r\nContent-Length: 0\r\n"), "{bodiless}");
        for method in ["GET", "DELETE"] {
            let request = local_request(&server_at(1), method, "/p", None);
            assert!(!request.to_ascii_lowercase().contains("content-type"), "{request}");
        }
    }

    /// A server on a free port that answers the requests of one connection with `answer(request, port)`;
    /// the requests it saw.
    fn serve_requests(
        requests_to_answer: usize,
        answer: impl Fn(&str, u16) -> String + Send + 'static,
    ) -> (u16, std::thread::JoinHandle<Vec<String>>) {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::thread::spawn(move || {
            let mut requests = Vec::new();
            let (mut stream, _) = listener.accept().unwrap();
            for _ in 0..requests_to_answer {
                let request = crate::tests::read_request_from(&mut stream);
                stream.write_all(answer(&request, port).as_bytes()).unwrap();
                requests.push(request);
            }
            requests
        });
        (port, seen)
    }

    #[test]
    fn the_token_goes_only_to_a_server_that_proves_it_holds_it() {
        // A process that took the port answers the probe without a proof.
        let (port, seen) = serve_requests(1, |_, _| "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}".to_string());
        let error = local_call(&server_at(port), "POST", "/api/desktop/run-target/key", None).unwrap_err();
        assert_eq!(error, "the local server is not answering");
        let requests = seen.join().unwrap();
        assert_eq!(requests.len(), 1, "only the probe: {requests:?}");
        assert!(!requests[0].to_ascii_lowercase().contains("x-piwi-token"), "{requests:?}");
    }

    #[test]
    fn a_server_that_proves_it_holds_the_token_is_called() {
        let (port, seen) = serve_requests(2, |request, port| {
            if let Some(challenge) = request
                .lines()
                .find_map(|line| line.strip_prefix("x-piwi-desktop-challenge: "))
            {
                let proof = crate::proof_of("pd_abc", port, challenge);
                return format!("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nx-piwi-desktop-proof: {proof}\r\n\r\n{{}}");
            }
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{\"ok\":true}".to_string()
        });
        let answer = local_call(&server_at(port), "POST", "/api/desktop/run-target/key", None).unwrap();
        assert_eq!(answer, serde_json::json!({ "ok": true }));
        let requests = seen.join().unwrap();
        assert!(requests[1].starts_with("POST /api/desktop/run-target/key HTTP/1.0\r\n"), "{requests:?}");
        assert!(requests[1].contains("\r\nx-piwi-token: pd_abc\r\n"), "{requests:?}");
    }

    /// A fresh folder in the temp dir for one test, removed when it ends.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!("piwi-request-test-{label}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn quitting_ends_every_held_request_and_removes_its_folder() {
        let root = TempRoot::new("quit");
        let running = root.0.join("piwi-request-running");
        let ended = root.0.join("piwi-request-ended");
        for dir in [&running, &ended] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("request-token"), "pdq_").unwrap();
        }
        let runs = RequestedRuns::default();
        {
            let mut held = runs.0.lock().unwrap();
            let run = |dir: &PathBuf, ended| RequestedRun {
                run: Some(1),
                stop: false,
                folder: None,
                dir: Some(dir.clone()),
                ended,
            };
            held.insert("a".into(), run(&running, None));
            held.insert("b".into(), run(&ended, Some((Some(1), false))));
            held.insert("c".into(), RequestedRun::default());
        }

        let mut told = Vec::new();
        runs.end_all(|id, code, stopped| told.push((id.to_string(), code, stopped)));
        told.sort();

        assert_eq!(
            told,
            vec![
                ("a".to_string(), None, true),
                ("b".to_string(), Some(1), false),
                ("c".to_string(), None, true),
            ]
        );
        assert!(!running.exists());
        assert!(!ended.exists());
        assert!(runs.0.lock().unwrap().is_empty());
        let mut again = 0;
        runs.end_all(|_, _, _| again += 1);
        assert_eq!(again, 0);
    }

    #[test]
    fn the_sweep_removes_only_old_request_folders_no_run_holds() {
        let root = TempRoot::new("sweep");
        let make = |name: &str| {
            let dir = root.0.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("request-token"), "pdq_").unwrap();
            dir
        };
        let old = make("piwi-request-old");
        let held = make("piwi-request-held");
        let other = make("piwi-repro-old");
        let file = root.0.join("piwi-request-file");
        std::fs::write(&file, "").unwrap();
        let in_use = HashSet::from([held.clone()]);

        sweep_request_dirs(&root.0, "piwi-request-", Duration::from_secs(3600), &in_use);
        assert!(old.exists(), "a folder younger than the age is kept");

        sweep_request_dirs(&root.0, "piwi-request-", Duration::ZERO, &in_use);
        assert!(!old.exists());
        assert!(held.exists(), "a folder a run holds is kept");
        assert!(other.exists(), "another prefix is kept");
        assert!(file.exists(), "a file is kept");
    }

    #[cfg(unix)]
    #[test]
    fn the_sweep_does_not_follow_a_link() {
        let root = TempRoot::new("sweep-link");
        let target = root.0.join("target");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("keep"), "").unwrap();
        let link = root.0.join("piwi-request-link");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        sweep_request_dirs(&root.0, "piwi-request-", Duration::ZERO, &HashSet::new());
        assert!(target.join("keep").exists());
        assert!(link.symlink_metadata().is_ok());
    }

    #[test]
    fn each_app_sweeps_only_its_own_request_folders() {
        let other = if cfg!(feature = "runner") {
            "piwi-request-"
        } else {
            "piwi-runner-request-"
        };
        assert!(!other.starts_with(REQUEST_DIR_PREFIX));
        assert!(!REQUEST_DIR_PREFIX.starts_with(other));
    }

    #[test]
    fn a_folder_holds_one_requested_run_at_a_time() {
        let runs = RequestedRuns::default();
        let (shop, admin) = (Path::new("/work/shop"), Path::new("/work/admin"));
        runs.0.lock().unwrap().insert("a".into(), RequestedRun::default());
        runs.0.lock().unwrap().insert("b".into(), RequestedRun::default());
        assert_eq!(runs.hold_folder("a", shop, Path::new("/tmp/a")), Ok(false));
        assert_eq!(runs.hold_folder("b", shop, Path::new("/tmp/b")), Err(FOLDER_BUSY.to_string()));
        assert_eq!(runs.hold_folder("b", admin, Path::new("/tmp/b")), Ok(false));
        assert_eq!(runs.hold_folder("a", shop, Path::new("/tmp/a")), Ok(false), "its own folder again");

        runs.0.lock().unwrap().remove("a");
        runs.0.lock().unwrap().insert("c".into(), RequestedRun { stop: true, ..Default::default() });
        assert_eq!(runs.hold_folder("c", shop, Path::new("/tmp/c")), Ok(true), "a stop that came meanwhile");
        assert_eq!(runs.dirs(), HashSet::from([PathBuf::from("/tmp/b"), PathBuf::from("/tmp/c")]));
    }

    #[test]
    fn the_server_is_told_every_request_held_starting_or_running() {
        let runs = RequestedRuns::default();
        assert!(runs.ids().is_empty());
        runs.0.lock().unwrap().insert("b".into(), RequestedRun { run: Some(4), ..Default::default() });
        runs.0.lock().unwrap().insert("a".into(), RequestedRun::default());
        runs.0.lock().unwrap().insert("c".into(), RequestedRun { run: Some(5), ..Default::default() });
        runs.end("c", Some(1), false);
        assert_eq!(runs.ids(), ["a", "b"]);
        assert_eq!(runs.outcomes(), [("c".to_string(), Some(1), false)]);
        assert_eq!(outcomes_json(&runs), [serde_json::json!({ "id": "c", "code": 1, "stopped": false })]);
    }

    /// A server that proves it holds the token, then answers `status` and `body`.
    fn answering(status: &'static str, body: &'static str) -> (u16, std::thread::JoinHandle<Vec<String>>) {
        serve_requests(2, move |request, port| {
            if let Some(challenge) = request
                .lines()
                .find_map(|line| line.strip_prefix("x-piwi-desktop-challenge: "))
            {
                let proof = crate::proof_of("pd_abc", port, challenge);
                return format!("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nx-piwi-desktop-proof: {proof}\r\n\r\n{{}}");
            }
            format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{body}")
        })
    }

    fn ended_run(folder: &str) -> RequestedRuns {
        let runs = RequestedRuns::default();
        let held = RequestedRun {
            run: Some(4),
            folder: Some(PathBuf::from(folder)),
            dir: Some(PathBuf::from("/tmp/a")),
            ..Default::default()
        };
        runs.0.lock().unwrap().insert("a".into(), held);
        runs.end("a", Some(0), false);
        runs
    }

    #[test]
    fn a_run_s_end_stays_held_until_the_server_takes_it() {
        for refusal in ["500 Internal Server Error", "404 Not Found"] {
            let runs = ended_run("/work/shop");
            let (port, seen) = answering(refusal, r#"{"message":"no"}"#);
            assert!(tell_ended(&server_at(port), &runs, "a", Some(0), false).is_err());
            seen.join().unwrap();
            assert_eq!(runs.outcomes(), [("a".to_string(), Some(0), false)], "kept after a {refusal}");
            assert!(runs.ids().is_empty(), "an ended run is not running");
            assert!(runs.dirs().is_empty());
            assert_eq!(runs.stop("a"), None);
            assert!(!runs.0.lock().unwrap()["a"].stop);
            let free = runs.hold_folder("b", Path::new("/work/shop"), Path::new("/tmp/b"));
            assert_eq!(free, Ok(false), "its folder is free");
        }

        let runs = ended_run("/work/shop");
        let (port, seen) = answering("200 OK", r#"{"ok":true}"#);
        assert_eq!(tell_ended(&server_at(port), &runs, "a", Some(0), false), Ok(()));
        let requests = seen.join().unwrap();
        assert!(requests[1].starts_with("POST /api/desktop/run-target/requests/a/ended HTTP/1.0\r\n"), "{requests:?}");
        assert!(requests[1].ends_with(r#"{"code":0,"stopped":false}"#), "{requests:?}");
        assert!(runs.0.lock().unwrap().is_empty());
    }

    #[test]
    fn the_server_names_back_the_ends_it_took_with_the_key() {
        let runs = ended_run("/work/shop");
        runs.0.lock().unwrap().insert("b".into(), RequestedRun::default());
        runs.0.lock().unwrap().insert("c".into(), RequestedRun::default());
        runs.end("c", None, true);
        runs.told_ended_in(&serde_json::json!({ "ok": true, "ended": ["a", "b", 7] }));
        assert_eq!(runs.ids(), ["b"], "a run still going stays");
        assert_eq!(runs.outcomes(), [("c".to_string(), None, true)], "an end the server did not take stays");
        runs.told_ended_in(&serde_json::json!({ "ok": true }));
        assert_eq!(runs.outcomes().len(), 1);
    }

    #[test]
    fn a_requested_run_s_arguments_stay_within_the_cap() {
        let args = |len: usize| vec!["a".repeat(len)];
        assert!(args_within_cap(&args(REQUEST_ARGS_MAX_CHARS - 1)));
        assert!(!args_within_cap(&args(REQUEST_ARGS_MAX_CHARS)));
        assert!(!args_within_cap(&vec!["".to_string(); REQUEST_ARGS_MAX_CHARS + 1]));
        // Counted as the editor counts a JavaScript string: an emoji is two.
        assert!(!args_within_cap(&["😀".repeat(REQUEST_ARGS_MAX_CHARS / 2)]));
        assert!(args_within_cap(&["é".repeat(REQUEST_ARGS_MAX_CHARS - 1)]));
    }

    fn launch(folder: &Path, args: &[&str]) -> Launch {
        Launch {
            instance: "https://piwi.example.com".into(),
            token: format!("pdq_{}", "c".repeat(64)),
            project_id: "3".into(),
            folder: folder.to_string_lossy().to_string(),
            args: args.iter().map(|a| a.to_string()).collect(),
        }
    }

    #[test]
    fn a_launch_runs_only_in_the_folder_linked_to_its_project_on_the_connected_instance() {
        let root = TempRoot::new("launch");
        let shop = root.0.join("shop");
        std::fs::create_dir_all(&shop).unwrap();
        let connected = Some("https://piwi.example.com");
        let linked = HashMap::from([("3".to_string(), shop.to_string_lossy().to_string())]);
        let ok = launch(&shop, &["tests/cart.spec.ts:3"]);
        assert_eq!(launch_folder(&ok, connected, &linked), Ok(std::fs::canonicalize(&shop).unwrap()));

        let refused = |launch: &Launch, connected: Option<&str>, links: &HashMap<String, String>| {
            launch_folder(launch, connected, links).unwrap_err()
        };
        assert_eq!(refused(&ok, None, &linked), "the request is not from the connected instance");
        assert_eq!(
            refused(&ok, Some("https://other.example.com"), &linked),
            "the request is not from the connected instance"
        );
        assert_eq!(refused(&launch(&shop, &[]), connected, &linked), "the request names no test to run");
        assert_eq!(
            refused(&launch(&shop, &["--config=/tmp/x.ts"]), connected, &linked),
            "flag not allowed: --config"
        );
        assert_eq!(refused(&ok, connected, &HashMap::new()), "no folder is linked to this project");
        let elsewhere = HashMap::from([("3".to_string(), root.0.join("admin").to_string_lossy().to_string())]);
        assert_eq!(
            refused(&ok, connected, &elsewhere),
            "the folder linked to this project changed since Run: answer the request again"
        );
        let gone = root.0.join("gone");
        let linked_gone = HashMap::from([("3".to_string(), gone.to_string_lossy().to_string())]);
        assert_eq!(
            refused(&launch(&gone, &["tests/cart.spec.ts:3"]), connected, &linked_gone),
            "the linked folder no longer exists: pick it again"
        );
    }

    #[test]
    fn a_stop_marks_a_held_request_and_answers_its_run() {
        let runs = RequestedRuns::default();
        assert_eq!(runs.stop("unknown"), None);
        assert!(runs.0.lock().unwrap().is_empty(), "a stop for a request not held holds nothing");

        runs.0.lock().unwrap().insert("starting".into(), RequestedRun::default());
        runs.0.lock().unwrap().insert("running".into(), RequestedRun { run: Some(7), ..Default::default() });
        assert_eq!(runs.stop("starting"), None);
        assert_eq!(runs.stop("running"), Some(7));
        let held = runs.0.lock().unwrap();
        assert!(held["starting"].stop, "its run is stopped once it has an id");
        assert!(held["running"].stop);
    }

    #[test]
    fn a_command_with_a_value_that_does_not_pass_is_never_shown() {
        assert_eq!(
            server_command(r#"{"type":"requested-run-stop","requestId":"../../etc"}"#),
            Some(ServerCommand::StopRun("../../etc".into()))
        );
        assert_eq!(
            server_command(r#"{"type":"requested-run-stop"}"#),
            Some(ServerCommand::StopRun(String::new()))
        );
        assert_eq!(
            server_command(r#"{"type":"key-revoked","instance":"file:///etc"}"#),
            Some(ServerCommand::KeyRevoked("file:///etc".into()))
        );
        assert_eq!(server_command(r#"{"title":"no type"}"#), None);
        assert_eq!(server_command(r#"{"type":7}"#), None);
    }

    #[test]
    fn each_app_keeps_its_keys_under_its_own_keychain_service() {
        assert_ne!(DESKTOP_KEYCHAIN_SERVICE, RUNNER_KEYCHAIN_SERVICE);
        let own = if cfg!(feature = "runner") {
            RUNNER_KEYCHAIN_SERVICE
        } else {
            DESKTOP_KEYCHAIN_SERVICE
        };
        assert_eq!(KEYCHAIN_SERVICE, own);
    }
}
