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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::json;
use tauri::{AppHandle, Manager as _};
use tauri_plugin_store::StoreExt as _;

use crate::mcp_clients::ServerInfo;
use crate::STORE_FILE;

/// Store key of the instance the app takes run requests from.
const INSTANCE_KEY: &str = "runTargetInstance";
/// Store key of `{ instance → { project id → folder } }`.
const LINKS_KEY: &str = "instanceLinks";
/// The keychain service the instance's key is kept under, its account the instance's URL.
const KEYCHAIN_SERVICE: &str = "Piwi Desktop run requests";

/// The key read from the keychain, so it is read once a launch.
#[derive(Default)]
pub struct KeptKey(Mutex<Option<(String, String)>>);

/// The run each requested run started, by request id, for a stop from the dashboard.
#[derive(Default)]
pub struct RequestedRuns(Mutex<HashMap<String, u32>>);

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
/// parts only. Answers the JSON body of a 2xx, or the server's message.
fn local_call(
    server: &ServerInfo,
    method: &str,
    path: &str,
    body: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", server.port)).map_err(|e| e.to_string())?;
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(60)));
    let payload = body.map(|b| b.to_string()).unwrap_or_default();
    let mut request = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nx-piwi-token: {}\r\nAccept: application/json\r\nConnection: close\r\n",
        server.port, server.token
    );
    if body.is_some() {
        request.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            payload.len()
        ));
    }
    request.push_str("\r\n");
    request.push_str(&payload);
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).map_err(|e| e.to_string())?;
    let body = crate::repro::http_body(&response)?;
    if body.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_slice(body).map_err(|_| "the local server sent something other than JSON".to_string())
}

fn log(app: &AppHandle, line: &str) {
    if let Some(log) = app.try_state::<crate::LogFile>() {
        crate::append_log(&log.0, &format!("run requests: {line}"));
    }
}

/// Hand the server the kept key of the connected instance, with its folders:
/// after each start of the server, and whenever the folders change. Nothing
/// without a connected instance, so the keychain is read only then.
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
    let body = json!({ "instance": instance, "key": key, "links": links_of(app, &instance) });
    if let Err(e) = local_call(&server, "PUT", "/api/desktop/run-target/key", Some(&body)) {
        log(app, &format!("could not hand the key to the server: {e}"));
    }
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
        let answer = local_call(&server, "GET", "/api/desktop/run-target/key", None)?;
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

/// Disconnect from the instance: the key leaves the keychain and the server.
/// The folders stay, for a later connection to the same instance.
#[tauri::command]
pub async fn desktop_forget_run_target(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(instance) = connected_instance(&app) {
            keychain::forget(&instance).map_err(|e| format!("could not remove the key from the keychain: {e}"))?;
        }
        if let Some(kept) = app.try_state::<KeptKey>() {
            *kept.0.lock().unwrap() = None;
        }
        let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
        store.delete(INSTANCE_KEY);
        store.save().map_err(|e| e.to_string())?;
        if let Some(server) = server_info(&app) {
            local_call(&server, "DELETE", "/api/desktop/run-target/key", None)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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
    let instance = text("instance").filter(|url| valid_instance(url)).ok_or("no instance to run for")?;
    let token = text("token")
        .filter(|t| t.len() == 68 && t.starts_with("pdq_") && t[4..].bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("no request token")?;
    let project_id = answer
        .get("projectId")
        .and_then(|v| v.as_u64())
        .map(|id| id.to_string())
        .ok_or("no project")?;
    let args = answer
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>())
        .ok_or("no command")?;
    Ok(Launch { instance, token, project_id, args })
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
    let launch = tauri::async_runtime::spawn_blocking(move || launch_of(&launch_server, &asked))
        .await
        .map_err(|e| e.to_string())??;

    let prepared = prepare(&app, &launch);
    let (folder, cli, dir, token_file) = match prepared {
        Ok(prepared) => prepared,
        Err(e) => {
            tell_started(&server, &request_id, Some(&e));
            return Err(e);
        }
    };

    let envs = vec![
        ("PIWI_DESKTOP_APP", "off".to_string()),
        ("PIWI_REQUEST_TOKEN_FILE", token_file.to_string_lossy().to_string()),
        ("PIWI_REQUEST_INSTANCE", launch.instance.clone()),
    ];
    let ended_app = app.clone();
    let ended_request = request_id.clone();
    let ended_dir = dir.clone();
    let spawned = crate::runner::spawn_tests(&app, &folder, &cli, launch.args, envs, move |code| {
        let _ = std::fs::remove_dir_all(&ended_dir);
        if let Some(runs) = ended_app.try_state::<RequestedRuns>() {
            runs.0.lock().unwrap().remove(&ended_request);
        }
        let app = ended_app.clone();
        std::thread::spawn(move || {
            if let Some(server) = server_info(&app) {
                let _ = local_call(
                    &server,
                    "POST",
                    &format!("/api/desktop/run-target/requests/{ended_request}/ended"),
                    Some(&json!({ "code": code })),
                );
            }
        });
    })
    .await;
    match spawned {
        Ok(id) => {
            if let Some(runs) = app.try_state::<RequestedRuns>() {
                runs.0.lock().unwrap().insert(request_id.clone(), id);
            }
            std::thread::spawn(move || tell_started(&server, &request_id, None));
            Ok(id)
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            tell_started(&server, &request_id, Some(&e));
            Err(e)
        }
    }
}

/// The folder, its Playwright, and the token file of a launch, checked.
fn prepare(app: &AppHandle, launch: &Launch) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), String> {
    if connected_instance(app).as_deref() != Some(launch.instance.as_str()) {
        return Err("the request is not from the connected instance".into());
    }
    crate::runner::validate_args(&launch.args)?;
    let folder = links_of(app, &launch.instance)
        .get(&launch.project_id)
        .map(PathBuf::from)
        .ok_or("no folder is linked to this project")?;
    if !folder.is_dir() {
        return Err("the linked folder no longer exists: pick it again".into());
    }
    let cli = crate::runner::resolve_playwright_cli(&folder)
        .ok_or("no Playwright installation found in the linked folder: run your package manager's install first")?;
    let dir = crate::repro::private_run_dir("piwi-request-").map_err(|e| e.to_string())?;
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
    let run = app
        .try_state::<RequestedRuns>()
        .and_then(|runs| runs.0.lock().unwrap().get(request_id).copied());
    if let Some(run_id) = run {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::runner::desktop_stop_local_tests(app, run_id).await;
        });
    }
}

/// A command of the server on the shell's notification stream: `true` when
/// `data` was one, which then is no notification to show.
pub(crate) fn take_server_command(app: &AppHandle, data: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
        return false;
    };
    if value.get("type").and_then(|t| t.as_str()) != Some("requested-run-stop") {
        return false;
    }
    if let Some(id) = value.get("requestId").and_then(|v| v.as_str()) {
        stop_requested_run(app, id);
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
    fn an_instance_is_an_http_url_with_no_space() {
        assert!(valid_instance("https://piwi.example.com"));
        assert!(valid_instance("http://localhost:7494/team"));
        assert!(!valid_instance("file:///etc"));
        assert!(!valid_instance("https://piwi.example.com\r\nHost: x"));
    }
}
