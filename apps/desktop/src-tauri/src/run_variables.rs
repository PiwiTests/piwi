//! A project's run variables: the environment variables every Playwright process the shell starts for the project
//! gets. The shell reads them from its own server by project id (`GET /api/projects/:id/run-variables`) or from a
//! requested run's launch, never from the window, and checks them again with the rules of
//! `@piwitests/core/run-variables` before it sets them: any problem refuses the run, so a process never starts with
//! part of them or with a name core refuses. `apps/application/tests/unit/run-variables-shell.test.ts` holds the
//! refused names and prefixes here to core's.
//!
//! They go to the process as its environment, before the variables the shell sets itself, never through a shell line.

use serde_json::Value;

/// Run variables per project.
const MAX_RUN_VARIABLES: usize = 10;
/// Characters of a name.
const MAX_NAME_CHARS: usize = 64;
/// UTF-16 code units of a value, as JavaScript counts a string's length.
const MAX_VALUE_UNITS: usize = 500;

/// The names a run variable never sets: core's `REFUSED_RUN_VARIABLE_NAMES`.
pub(crate) const REFUSED_NAMES: &[&str] = &[
    "APPDATA",
    "ALL_PROXY",
    "BASHOPTS",
    "BROWSER",
    "CDPATH",
    "CLASSPATH",
    "COMSPEC",
    "DISPLAY",
    "EDITOR",
    "ENV",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "IFS",
    "JAVA_TOOL_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "LESSCLOSE",
    "LESSOPEN",
    "LOCALAPPDATA",
    "NO_PROXY",
    "PAGER",
    "PATH",
    "PATHEXT",
    "PROGRAMDATA",
    "PROMPT_COMMAND",
    "PS4",
    "PWDEBUG",
    "SHELL",
    "SHELLOPTS",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "VISUAL",
    "WAYLAND_DISPLAY",
    "WINDIR",
    "XAUTHORITY",
    "ZDOTDIR",
    "_JAVA_OPTIONS",
];

/// The prefixes of the names a run variable never sets: core's `REFUSED_RUN_VARIABLE_PREFIXES`.
pub(crate) const REFUSED_PREFIXES: &[&str] = &[
    "BASH_",
    "BUN_",
    "COREPACK_",
    "CORECLR_",
    "COR_",
    "DOTNET_",
    "DYLD_",
    "ELECTRON_",
    "GIT_",
    "LD_",
    "NODE_",
    "NPM_",
    "PERL",
    "PIWI_",
    "PLAYWRIGHT_",
    "PNPM_",
    "PW_",
    "PYTHON",
    "RUBY",
    "SSH_",
    "SSL_",
    "XDG_",
    "YARN_",
];

/// Whether a name is one a run variable never sets, whatever its case: Windows reads names without it.
pub(crate) fn is_refused_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    REFUSED_NAMES.contains(&upper.as_str())
        || REFUSED_PREFIXES
            .iter()
            .any(|prefix| upper.starts_with(prefix))
}

/// A name: capital letters, digits and `_`, starting with a letter or `_`, 64 characters at most.
fn is_variable_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_NAME_CHARS
        && (bytes[0].is_ascii_uppercase() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
}

/// A control, format or default-ignorable character: line breaks, NUL, bidi overrides, zero-width characters,
/// variation selectors and tags, as core's `HIDDEN_CHARACTER` refuses them.
fn is_hidden(c: char) -> bool {
    c.is_control()
        || matches!(
            c as u32,
            0x00AD
                | 0x034F
                | 0x0600..=0x0605
                | 0x061C
                | 0x06DD
                | 0x070F
                | 0x0890..=0x0891
                | 0x08E2
                | 0x115F..=0x1160
                | 0x17B4..=0x17B5
                | 0x180B..=0x180F
                | 0x200B..=0x200F
                | 0x2028..=0x202E
                | 0x2060..=0x206F
                | 0x3164
                | 0xFE00..=0xFE0F
                | 0xFEFF
                | 0xFFA0
                | 0xFFF0..=0xFFFB
                | 0x110BD
                | 0x110CD
                | 0x13430..=0x1343F
                | 0x1BCA0..=0x1BCA3
                | 0x1D173..=0x1D17A
                | 0xE0000..=0xE0FFF
        )
}

/// The run variables of `value` (a list of `{ name, value }`, null for none) as `(name, value)` pairs, in order, or
/// why they cannot be set: more than 10, a field other than the name and the value, a name set twice, a name core
/// refuses, or a value longer than 500 characters or with a hidden character.
pub(crate) fn checked_run_variables(value: &Value) -> Result<Vec<(String, String)>, String> {
    let items = match value {
        Value::Null => return Ok(Vec::new()),
        Value::Array(items) => items,
        _ => return Err("the run variables are not a list".into()),
    };
    if items.len() > MAX_RUN_VARIABLES {
        return Err(format!(
            "a project has at most {MAX_RUN_VARIABLES} run variables"
        ));
    }
    let mut checked: Vec<(String, String)> = Vec::with_capacity(items.len());
    for item in items {
        let Some(fields) = item.as_object() else {
            return Err("a run variable is not a name and a value".into());
        };
        if fields.keys().any(|key| key != "name" && key != "value") {
            return Err("a run variable has a field other than its name and its value".into());
        }
        let (Some(name), Some(text)) = (
            fields.get("name").and_then(Value::as_str),
            fields.get("value").and_then(Value::as_str),
        ) else {
            return Err("a run variable has no text name or value".into());
        };
        if !is_variable_name(name) {
            return Err(format!("{name:?} is not a variable name"));
        }
        if is_refused_name(name) {
            return Err(format!("{name} is not a variable a project can set"));
        }
        if text.encode_utf16().count() > MAX_VALUE_UNITS {
            return Err(format!(
                "the value of {name} is longer than {MAX_VALUE_UNITS} characters"
            ));
        }
        if text.chars().any(is_hidden) {
            return Err(format!(
                "the value of {name} holds a line break, a control or an invisible character"
            ));
        }
        if checked.iter().any(|(seen, _)| seen == name) {
            return Err(format!("{name} is set twice"));
        }
        checked.push((name.to_string(), text.to_string()));
    }
    Ok(checked)
}

/// The run variables of the bundled server's project `project_id` (digits only), checked. Errors when the server does
/// not answer them or a check fails, so the run does not start.
pub(crate) fn project_run_variables(
    server: &crate::mcp_clients::ServerInfo,
    project_id: &str,
) -> Result<Vec<(String, String)>, String> {
    if !crate::runner::valid_project_id(project_id) {
        return Err("not a project id".into());
    }
    let body =
        crate::repro::local_get_json(server, &format!("/api/projects/{project_id}/run-variables"))
            .map_err(|e| format!("the project's run variables could not be read: {e}"))?;
    checked_run_variables(body.get("runVariables").unwrap_or(&Value::Null))
        .map_err(|e| format!("the project's run variables were not set: {e}"))
}

/// [`project_run_variables`] off the async runtime, with the app's server. Errors without a server.
pub(crate) async fn read_project_run_variables(
    app: &tauri::AppHandle,
    project_id: &str,
) -> Result<Vec<(String, String)>, String> {
    use tauri::Manager;
    let server = {
        let Some(server) = app.try_state::<crate::mcp_clients::ServerInfo>() else {
            return Err(
                "the project's run variables could not be read: the app's server is not running"
                    .into(),
            );
        };
        crate::mcp_clients::ServerInfo {
            port: server.port,
            token: server.token.clone(),
        }
    };
    let project_id = project_id.to_string();
    tauri::async_runtime::spawn_blocking(move || project_run_variables(&server, &project_id))
        .await
        .map_err(|e| format!("the project's run variables could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn takes_a_list_of_names_and_values_in_order() {
        let list =
            json!([{ "name": "TENANT", "value": "acme" }, { "name": "_REGION_2", "value": "" }]);
        assert_eq!(
            checked_run_variables(&list).unwrap(),
            vec![
                ("TENANT".to_string(), "acme".to_string()),
                ("_REGION_2".to_string(), String::new())
            ]
        );
        assert!(checked_run_variables(&Value::Null).unwrap().is_empty());
        assert!(checked_run_variables(&json!([])).unwrap().is_empty());
    }

    #[test]
    fn refuses_a_name_that_changes_what_runs_or_where_results_go() {
        for name in [
            "PATH",
            "NODE_OPTIONS",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "PIWI_SERVER_URL",
            "PLAYWRIGHT_BROWSERS_PATH",
            "GIT_CONFIG_COUNT",
            "BASH_ENV",
            "NPM_CONFIG_SCRIPT_SHELL",
            "HOME",
            "COMSPEC",
            "HTTPS_PROXY",
        ] {
            let list = json!([{ "name": name, "value": "x" }]);
            let refused = checked_run_variables(&list).unwrap_err();
            assert!(
                refused.contains("not a variable a project can set"),
                "{name}: {refused}"
            );
        }
        assert!(is_refused_name("Path"));
        assert!(is_refused_name("node_options"));
        assert!(!is_refused_name("TENANT"));
    }

    #[test]
    fn refuses_what_core_refuses() {
        let refused = |list: Value| checked_run_variables(&list).is_err();
        assert!(refused(json!("TENANT=acme")));
        assert!(refused(json!([{ "name": "tenant", "value": "acme" }])));
        assert!(refused(json!([{ "name": "2TENANT", "value": "acme" }])));
        assert!(refused(json!([{ "name": "TEN-ANT", "value": "acme" }])));
        assert!(refused(
            json!([{ "name": "X".repeat(65), "value": "acme" }])
        ));
        assert!(refused(json!([{ "name": "TENANT", "value": 1 }])));
        assert!(refused(
            json!([{ "name": "TENANT", "value": "acme", "secret": true }])
        ));
        assert!(refused(
            json!([{ "name": "TENANT", "value": "a" }, { "name": "TENANT", "value": "b" }])
        ));
        assert!(refused(
            json!([{ "name": "TENANT", "value": "a".repeat(501) }])
        ));
        for hidden in [
            "a\nb",
            "a\u{0}b",
            "a\tb",
            "a\u{202E}b",
            "a\u{200B}b",
            "a\u{2028}b",
            "a\u{FE0F}b",
            "a\u{E0041}b",
        ] {
            assert!(
                refused(json!([{ "name": "TENANT", "value": hidden }])),
                "{hidden:?}"
            );
        }
        let eleven: Vec<Value> = (0..11)
            .map(|i| json!({ "name": format!("V{i}"), "value": "" }))
            .collect();
        assert!(refused(Value::Array(eleven.clone())));
        assert!(!refused(Value::Array(eleven[..10].to_vec())));
        assert!(!refused(
            json!([{ "name": "TENANT", "value": "a".repeat(500) }])
        ));
        assert!(!refused(
            json!([{ "name": "TENANT", "value": "it's $HOME; `id` | & \"é\"" }])
        ));
    }
}
