//! A project's run variables: the environment variables every Playwright process the shell starts for the project
//! gets, with an environment's merged over them. The shell reads them from its own server by project id
//! (`GET /api/projects/:id/run-variables`), from the team instance for an environment of the team project the folder
//! is also linked to, or from a requested run's launch, never from the window ([`crate::environments`]), and checks them
//! again with the rules of `@piwitests/core/run-variables` before it sets them: any problem refuses the run, so a
//! process never starts with part of them or with a name core refuses.
//! `apps/application/tests/unit/run-variables-shell.test.ts` holds the refused names, prefixes and limits here to
//! core's.
//!
//! They go to the process as its environment, before the variables the shell sets itself, never through a shell line.

use serde_json::Value;

/// Run variables per project, and per environment.
pub(crate) const MAX_RUN_VARIABLES: usize = 10;
/// Run variables a run gets for an environment: its project's and the environment's together.
pub(crate) const MAX_MERGED_RUN_VARIABLES: usize = 20;
/// Characters of a name.
const MAX_NAME_CHARS: usize = 64;
/// UTF-16 code units of a value, as JavaScript counts a string's length.
const MAX_VALUE_UNITS: usize = 500;

/// The names a run variable never sets: core's `REFUSED_RUN_VARIABLE_NAMES`.
pub(crate) const REFUSED_NAMES: &[&str] = &[
    "AGENT_JOBNAME",
    "ALL_PROXY",
    "APPDATA",
    "AUTO_PROXY",
    "BASHOPTS",
    "BROWSER",
    "BUILD_BUILDID",
    "BUILD_BUILDNUMBER",
    "BUILD_ID",
    "BUILD_NUMBER",
    "BUILD_URL",
    "CDPATH",
    "CHANGE_ID",
    "CHANGE_TARGET",
    "CI",
    "CIRCLECI",
    "CLASSPATH",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMW6432",
    "COMSPEC",
    "DEBUG_FILE",
    "DESTDIR",
    "DISPLAY",
    "EDITOR",
    "EGID",
    "EUID",
    "FORCE_COLOR",
    "GCONV_PATH",
    "GID",
    "GLIBC_TUNABLES",
    "GRADLE_OPTS",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOSTALIASES",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "IFS",
    "JAVA_OPTS",
    "JAVA_TOOL_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "JENKINS_URL",
    "JOB_NAME",
    "LESSCLOSE",
    "LESSOPEN",
    "LOCALAPPDATA",
    "LOCALDOMAIN",
    "LOCPATH",
    "MAVEN_OPTS",
    "NLSPATH",
    "NO_COLOR",
    "NO_PROXY",
    "PAGER",
    "PATH",
    "PATHEXT",
    "PPID",
    "PREFIX",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMW6432",
    "PROMPT_COMMAND",
    "PS0",
    "PS1",
    "PS2",
    "PS3",
    "PS4",
    "PSEXECUTIONPOLICYPREFERENCE",
    "PSMODULEPATH",
    "PWDEBUG",
    "RESOLV_HOST_CONF",
    "RES_OPTIONS",
    "RUSTC_WRAPPER",
    "SHELL",
    "SHELLOPTS",
    "SOCKS_SERVER",
    "SSLKEYLOGFILE",
    "STTY",
    "SYSTEMROOT",
    "SYSTEM_JOBID",
    "SYSTEM_PULLREQUEST_PULLREQUESTNUMBER",
    "SYSTEM_PULLREQUEST_TARGETBRANCH",
    "SYSTEM_TEAMFOUNDATIONSERVERURI",
    "SYSTEM_TEAMPROJECT",
    "TEMP",
    "TF_BUILD",
    "TMP",
    "TMPDIR",
    "UID",
    "USERNAME",
    "USERPROFILE",
    "VISUAL",
    "WAYLAND_DISPLAY",
    "WINDIR",
    "XAUTHORITY",
    "ZDOTDIR",
    "_",
    "_JAVA_OPTIONS",
];

/// The prefixes of the names a run variable never sets: core's `REFUSED_RUN_VARIABLE_PREFIXES`.
pub(crate) const REFUSED_PREFIXES: &[&str] = &[
    "APPVEYOR_",
    "BASH_",
    "BITBUCKET_",
    "BUILDKITE_",
    "BUN_",
    "CIRCLE_",
    "CI_",
    "CODEBUILD_",
    "COMPLUS_",
    "CORECLR_",
    "COREPACK_",
    "COR_",
    "DBUS_",
    "DOTNET_",
    "DRONE_",
    "DYLD_",
    "ELECTRON_",
    "ESBUILD_",
    "GIO_",
    "GITHUB_",
    "GITLAB_",
    "GIT_",
    "GST_",
    "GTK_",
    "LD_",
    "LIBGL_",
    "MESA_",
    "NAPI_RS_",
    "NODE_",
    "NPM_",
    "OPENSSL_",
    "PERL",
    "PIWI_",
    "PLAYWRIGHT_",
    "PNPM_",
    "PWTEST_",
    "PW_",
    "PYTHON",
    "QT_",
    "RUBY",
    "RUNNER_",
    "SEMAPHORE_",
    "SSH_",
    "SSL_",
    "TEAMCITY_",
    "TRAVIS",
    "VK_",
    "XDG_",
    "YARN_",
    "__",
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
pub(crate) fn is_hidden(c: char) -> bool {
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

/// A value made of letters and digits of any script, spaces and `_ - . , : / @ + =`, with no space at either end and
/// not starting with `//`: core's `PLAIN_VALUE`, or narrower for a combining mark Rust does not count as alphabetic.
pub(crate) fn is_plain_value(value: &str) -> bool {
    value.chars().all(|c| c.is_alphanumeric() || " _.,:/@+=-".contains(c))
        && value.trim() == value
        && !value.starts_with("//")
}

/// Why `text` cannot be the value of the variable `name`, or None when it can: empty, longer than 500 characters, with
/// a character other than letters, digits, spaces and `_ - . , : / @ + =`, a space at either end, starting with `//`,
/// or with a hidden character, as core's `runVariableValueProblem` refuses it.
pub(crate) fn value_problem(name: &str, text: &str) -> Option<String> {
    if text.is_empty() {
        return Some(format!("the value of {name} is empty"));
    }
    if text.encode_utf16().count() > MAX_VALUE_UNITS {
        return Some(format!(
            "the value of {name} is longer than {MAX_VALUE_UNITS} characters"
        ));
    }
    if !is_plain_value(text) {
        return Some(format!(
            "the value of {name} must be letters, digits, spaces and _ - . , : / @ + = only"
        ));
    }
    if text.chars().any(is_hidden) {
        return Some(format!(
            "the value of {name} holds a line break, a control or an invisible character"
        ));
    }
    None
}

/// The run variables of `value` (a list of `{ name, value }`, null for none) as `(name, value)` pairs, in order, or
/// why they cannot be set: more than 10, a field other than the name and the value, a name set twice, a name core
/// refuses, or a value that is empty, longer than 500 characters or with a hidden character.
#[cfg(test)]
pub(crate) fn checked_run_variables(value: &Value) -> Result<Vec<(String, String)>, String> {
    checked_run_variables_within(value, MAX_RUN_VARIABLES)
}

/// [`checked_run_variables`], with at most `limit` variables: a project's or an environment's 10, or the 20 a run
/// gets for an environment ([`MAX_MERGED_RUN_VARIABLES`]).
pub(crate) fn checked_run_variables_within(
    value: &Value,
    limit: usize,
) -> Result<Vec<(String, String)>, String> {
    let items = match value {
        Value::Null => return Ok(Vec::new()),
        Value::Array(items) => items,
        _ => return Err("the run variables are not a list".into()),
    };
    if items.len() > limit {
        return Err(format!("a run gets at most {limit} run variables"));
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
        if let Some(problem) = value_problem(name, text) {
            return Err(problem);
        }
        if checked.iter().any(|(seen, _)| seen == name) {
            return Err(format!("{name} is set twice"));
        }
        checked.push((name.to_string(), text.to_string()));
    }
    Ok(checked)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn takes_a_list_of_names_and_values_in_order() {
        let list =
            json!([{ "name": "TENANT", "value": "acme" }, { "name": "_REGION_2", "value": "eu" }]);
        assert_eq!(
            checked_run_variables(&list).unwrap(),
            vec![
                ("TENANT".to_string(), "acme".to_string()),
                ("_REGION_2".to_string(), "eu".to_string())
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
            "STTY",
            "OPENSSL_CONF",
            "GITHUB_ACTIONS",
            "_",
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
        assert!(refused(json!([{ "name": "TENANT", "value": "" }])));
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
            .map(|i| json!({ "name": format!("V{i}"), "value": "x" }))
            .collect();
        assert!(refused(Value::Array(eleven.clone())));
        assert!(!refused(Value::Array(eleven[..10].to_vec())));
        assert!(checked_run_variables_within(
            &Value::Array(eleven.clone()),
            MAX_MERGED_RUN_VARIABLES
        )
        .is_ok());
        let twenty_one: Vec<Value> = (0..21)
            .map(|i| json!({ "name": format!("V{i}"), "value": "x" }))
            .collect();
        assert!(checked_run_variables_within(
            &Value::Array(twenty_one.clone()),
            MAX_MERGED_RUN_VARIABLES
        )
        .is_err());
        assert!(checked_run_variables_within(
            &Value::Array(twenty_one[..20].to_vec()),
            MAX_MERGED_RUN_VARIABLES
        )
        .is_ok());
        assert!(!refused(
            json!([{ "name": "TENANT", "value": "a".repeat(500) }])
        ));
        assert!(!refused(
            json!([{ "name": "TENANT", "value": "https://acme.example.com:8443/app" }])
        ));
        assert!(!refused(
            json!([{ "name": "TENANT", "value": "Société Générale, eu-west 2 = a+b@c_d" }])
        ));
        for value in [
            "$HOME",
            "${env:GITHUB_TOKEN}",
            "\\\\host\\share\\x.cnf",
            "//host/share/x",
            "it's",
            "a\"b",
            "a`id`",
            "a;b",
            " acme",
        ] {
            assert!(refused(json!([{ "name": "TENANT", "value": value }])), "{value:?}");
        }
    }
}
