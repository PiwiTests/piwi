//! Environments: the deployment of the application a run the shell starts goes against (Local, Staging, Production).
//! The window names the environment a run is for by its id, among the desktop project's own or, for a folder also
//! linked to a team project (Run on my machine), the team project's, with the instance and the team project it read it
//! from, and the key of a protected one the person confirmed the run against ([`EnvironmentPick`]). The shell reads the
//! run variables the run gets and the environment from its own server, or from the team instance with the target key,
//! at each run and never from the window, refuses a team pick whose folder is now linked elsewhere and a protected
//! environment the pick does not confirm by its current key, checks them again with the rules of
//! `@piwitests/core/environments` and `@piwitests/core/run-variables`, and applies them ([`RunSettings`]): the run
//! variables, then `PIWI_ENVIRONMENT` set to the environment's key, as the process's environment before the shell's
//! own variables, never through a shell line, and for a protected environment a `--grep-invert` built as core's
//! `requiredTagsGrepInvert` builds it, which limits the run to the tests carrying one of its required tags, beside the
//! setup and teardown projects they depend on, which Playwright runs whole.
//! `apps/application/tests/unit/environments-shell.test.ts` holds the limits and the pattern here to core's.
//!
//! An environment may name the env file its config loads (`.env.staging`): the shell lists those a linked folder holds
//! for its check ([`env_files_in`]), and copies the one of the environment from the linked folder into a worktree
//! before its test runs ([`copy_env_file`]), a plain file only, never through a link. It never reads it otherwise.

use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager as _};

use crate::run_variables::{
    checked_run_variables_within, is_hidden, value_problem, MAX_MERGED_RUN_VARIABLES,
    MAX_RUN_VARIABLES,
};

/// The variable a run started for an environment gets, holding its key: core's `ENVIRONMENT_VARIABLE`.
pub(crate) const ENVIRONMENT_VARIABLE: &str = "PIWI_ENVIRONMENT";
/// UTF-16 code units of a key, as JavaScript counts a string's length.
const MAX_KEY_UNITS: usize = 80;
/// UTF-16 code units of an environment's name.
const MAX_ENVIRONMENT_NAME_UNITS: usize = 80;
/// Required tags of a protected environment.
const MAX_REQUIRED_TAGS: usize = 10;
/// Characters of a required tag after its `@`.
const MAX_TAG_CHARS: usize = 63;
/// Characters of an env file's name.
const MAX_ENV_FILE_CHARS: usize = 64;
/// The largest id JavaScript reads exactly (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_ID: u64 = (1 << 53) - 1;
/// The `--grep-invert` pattern before the required tags, joined by `|`: core's `requiredTagsGrepInvert`.
const GREP_INVERT_START: &str = r"^(?!.*(?:^|\s)(?:";
/// The `--grep-invert` pattern after the required tags.
const GREP_INVERT_END: &str = r")(?:\s|$))";
/// The most env files of a linked folder its check lists.
const MAX_ENV_FILES_LISTED: usize = 50;
/// The largest env file the shell copies into a worktree.
const MAX_ENV_FILE_BYTES: u64 = 1024 * 1024;
/// How long a read of the team instance may take.
const TEAM_TIMEOUT: Duration = Duration::from_secs(15);

/// The environment a run is for, as the window names it: an id of the desktop project's environments, or with `team`
/// of the environments of the team project the project's folder is also linked to, named by its instance and id as the
/// window read them. `confirmed` is the key of a protected environment the person confirmed this run against.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentPick {
    pub id: u64,
    #[serde(default)]
    pub team: bool,
    #[serde(default)]
    pub instance: Option<String>,
    #[serde(default)]
    pub team_project: Option<u64>,
    #[serde(default)]
    pub confirmed: Option<String>,
}

/// What the shell applies of the environment a run is for, as core's `EnvironmentForRun` holds it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentForRun {
    pub id: u64,
    pub key: String,
    pub name: String,
    pub protected: bool,
    /// The tags a protected environment's runs are limited to; empty for another environment.
    pub required_tags: Vec<String>,
    /// The file the config loads for this environment, copied into a worktree.
    pub env_file: Option<String>,
}

/// What a run gets: the run variables, the project's with the environment's merged over them, and the environment.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RunSettings {
    pub variables: Vec<(String, String)>,
    pub environment: Option<EnvironmentForRun>,
}

impl RunSettings {
    /// The variables the process gets, in order: the run variables, then `PIWI_ENVIRONMENT` with the environment's key.
    pub(crate) fn envs(&self) -> Vec<(String, String)> {
        let mut envs = self.variables.clone();
        if let Some(environment) = &self.environment {
            envs.push((ENVIRONMENT_VARIABLE.to_string(), environment.key.clone()));
        }
        envs
    }

    /// The arguments the shell adds to Playwright's: for a protected environment, the `--grep-invert` that limits the
    /// run to the tests carrying one of its required tags, beside the setup and teardown projects they depend on, which
    /// Playwright runs whole.
    pub(crate) fn args(&self) -> Vec<String> {
        match &self.environment {
            Some(environment) if environment.protected => {
                vec![format!(
                    "--grep-invert={}",
                    required_tags_grep_invert(&environment.required_tags)
                )]
            }
            _ => Vec::new(),
        }
    }

    /// Refuses a protected environment for `what`, which never runs against one, saying `why`: `piwi flake` cannot be
    /// kept to the required tags, a bisect would judge each step on no test, a bug report's spec carries no such tag.
    pub(crate) fn refuse_protected(&self, what: &str, why: &str) -> Result<(), String> {
        match &self.environment {
            Some(environment) if environment.protected => Err(format!(
                "{what} never runs against a protected environment ({}): {why}",
                environment.name
            )),
            _ => Ok(()),
        }
    }

    /// Refuses a protected environment the person did not confirm this run against: the pick names its key as it was
    /// shown to them, and it must be the key the shell read.
    pub(crate) fn check_confirmed(&self, pick: Option<&EnvironmentPick>) -> Result<(), String> {
        match &self.environment {
            Some(environment)
                if environment.protected
                    && pick.and_then(|pick| pick.confirmed.as_deref()) != Some(environment.key.as_str()) =>
            {
                Err(format!(
                    "{} is protected: confirm the run against it in the window, which shows what it is limited to",
                    environment.name
                ))
            }
            _ => Ok(()),
        }
    }
}

/// What a `--list --reporter=json` of Playwright answered: how many tests it selects, and its first error.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ListedTests {
    pub count: usize,
    pub error: Option<String>,
}

/// The tests of a JSON report a `--list` printed (output printed before the JSON, a config that logs, is skipped): the
/// specs with at least one test, in every suite, and the report's first error. None when no report can be read.
pub(crate) fn listed_tests(stdout: &str) -> Option<ListedTests> {
    let start = stdout
        .find("\n{")
        .map(|i| i + 1)
        .or_else(|| stdout.starts_with('{').then_some(0))?;
    let report: Value = serde_json::from_str(stdout[start..].trim()).ok()?;
    fn count(suites: Option<&Value>) -> usize {
        suites.and_then(Value::as_array).map_or(0, |suites| {
            suites
                .iter()
                .map(|suite| {
                    let specs = suite
                        .get("specs")
                        .and_then(Value::as_array)
                        .map_or(0, |specs| {
                            specs
                                .iter()
                                .filter(|spec| {
                                    spec.get("tests")
                                        .and_then(Value::as_array)
                                        .is_some_and(|tests| !tests.is_empty())
                                })
                                .count()
                        });
                    specs + count(suite.get("suites"))
                })
                .sum()
        })
    }
    let error = report
        .get("errors")
        .and_then(Value::as_array)
        .and_then(|errors| errors.first())
        .and_then(|error| error.get("message").and_then(Value::as_str))
        .map(|message| message.lines().next().unwrap_or_default().to_string());
    Some(ListedTests {
        count: count(report.get("suites")),
        error,
    })
}

/// The `--grep-invert` pattern that leaves out every test whose title and tags hold none of `tags` as a word: core's
/// `requiredTagsGrepInvert(tags)`. The tags are checked ([`tag_ok`]), so none needs escaping.
pub(crate) fn required_tags_grep_invert(tags: &[String]) -> String {
    format!("{GREP_INVERT_START}{}{GREP_INVERT_END}", tags.join("|"))
}

/// A required tag: `@` then 1 to 63 ASCII letters, digits, `_` or `-`.
fn tag_ok(tag: &str) -> bool {
    tag.strip_prefix('@').is_some_and(|rest| {
        !rest.is_empty()
            && rest.len() <= MAX_TAG_CHARS
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

/// Whether `name` is an env file's name: `.env`, then `.`-separated parts of ASCII letters, digits, `_` or `-`
/// (`.env.staging`), 64 characters at most, never a folder.
pub(crate) fn env_file_ok(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(".env") else {
        return false;
    };
    name.len() <= MAX_ENV_FILE_CHARS
        && (rest.is_empty()
            || rest.strip_prefix('.').is_some_and(|parts| {
                parts.split('.').all(|part| {
                    !part.is_empty()
                        && part
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                })
            }))
}

/// Why `key` cannot be an environment's key, or None: 1 to 80 characters a run variable's value may hold.
fn key_problem(key: &str) -> Option<String> {
    if key.is_empty() {
        return Some("the environment has no key".into());
    }
    if key.encode_utf16().count() > MAX_KEY_UNITS {
        return Some(format!(
            "the environment's key is longer than {MAX_KEY_UNITS} characters"
        ));
    }
    value_problem(ENVIRONMENT_VARIABLE, key)
}

/// Why `name` cannot be an environment's name, or None: 1 to 80 characters, not only spaces, no hidden character.
fn name_problem(name: &str) -> Option<String> {
    if name.trim().is_empty() {
        return Some("the environment has no name".into());
    }
    if name.encode_utf16().count() > MAX_ENVIRONMENT_NAME_UNITS {
        return Some(format!(
            "the environment's name is longer than {MAX_ENVIRONMENT_NAME_UNITS} characters"
        ));
    }
    if name.chars().any(is_hidden) {
        return Some(
            "the environment's name holds a line break, a control or an invisible character".into(),
        );
    }
    None
}

/// The environment of `value` as core's `parseEnvironmentForRun` reads it: null for none, else an object with a
/// numeric id, a key, a name, whether it is protected, its required tags (at least one when protected) and an env file
/// name or null. Any problem refuses it: a run never starts for an environment it cannot apply whole.
pub(crate) fn checked_environment(value: &Value) -> Result<Option<EnvironmentForRun>, String> {
    let fields = match value {
        Value::Null => return Ok(None),
        Value::Object(fields) => fields,
        _ => return Err("the environment is not an object".into()),
    };
    let id = fields
        .get("id")
        .and_then(Value::as_u64)
        .filter(|id| (1..=MAX_SAFE_ID).contains(id))
        .ok_or("the environment has no id")?;
    let key = fields
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(problem) = key_problem(key) {
        return Err(problem);
    }
    let name = fields
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(problem) = name_problem(name) {
        return Err(problem);
    }
    let protected = fields
        .get("protected")
        .and_then(Value::as_bool)
        .ok_or("the environment does not say whether it is protected")?;
    let tags: Vec<String> = match fields.get("requiredTags") {
        Some(Value::Array(tags)) if tags.len() <= MAX_REQUIRED_TAGS => tags
            .iter()
            .map(|tag| tag.as_str().map(str::to_string))
            .collect::<Option<Vec<_>>>()
            .ok_or(format!(
                "the required tags must be a list of at most {MAX_REQUIRED_TAGS} texts"
            ))?,
        _ => {
            return Err(format!(
                "the required tags must be a list of at most {MAX_REQUIRED_TAGS} texts"
            ))
        }
    };
    if let Some(tag) = tags.iter().find(|tag| !tag_ok(tag)) {
        return Err(format!(
            "{tag:?} is not a tag: @ then letters, digits, _ or -"
        ));
    }
    if protected && tags.is_empty() {
        return Err("a protected environment needs a required tag".into());
    }
    let env_file = match fields.get("envFile") {
        None | Some(Value::Null) => None,
        Some(Value::String(file)) if env_file_ok(file) => Some(file.clone()),
        Some(_) => return Err("the environment's env file is not an env file name".into()),
    };
    Ok(Some(EnvironmentForRun {
        id,
        key: key.to_string(),
        name: name.to_string(),
        protected,
        required_tags: if protected { tags } else { Vec::new() },
        env_file,
    }))
}

/// The run settings of an answer that names them (`{ runVariables, environment }`), checked: the environment, and the
/// run variables, at most 10 without an environment and 20 with one, none when the answer names none.
pub(crate) fn checked_settings(answer: &Value) -> Result<RunSettings, String> {
    let environment = checked_environment(answer.get("environment").unwrap_or(&Value::Null))
        .map_err(|e| format!("the environment was not applied: {e}"))?;
    let limit = if environment.is_some() {
        MAX_MERGED_RUN_VARIABLES
    } else {
        MAX_RUN_VARIABLES
    };
    let variables =
        checked_run_variables_within(answer.get("runVariables").unwrap_or(&Value::Null), limit)
            .map_err(|e| format!("the run variables were not set: {e}"))?;
    Ok(RunSettings {
        variables,
        environment,
    })
}

/// The run settings of a run-variables answer, checked ([`checked_settings`]): it names the run variables, and the
/// environment it names is the one picked (none without a pick).
pub(crate) fn checked_run_settings(
    answer: &Value,
    pick: Option<&EnvironmentPick>,
) -> Result<RunSettings, String> {
    if answer.get("runVariables").is_none() {
        return Err("the run variables could not be read: the server did not name them".into());
    }
    let settings = checked_settings(answer)?;
    match (&settings.environment, pick) {
        (None, None) => Ok(settings),
        (Some(environment), Some(pick)) if environment.id == pick.id => Ok(settings),
        _ => Err("the server answered another environment than the one picked".into()),
    }
}

/// A pick the window sent, with an id JavaScript reads exactly.
fn checked_pick(pick: Option<EnvironmentPick>) -> Result<Option<EnvironmentPick>, String> {
    match pick {
        Some(pick) if pick.id == 0 || pick.id > MAX_SAFE_ID => Err("not an environment id".into()),
        pick => Ok(pick),
    }
}

/// Refuses a team pick read from another team project than the one the folder is linked to now, on the connected
/// instance: the instance or the link changed since the window read it, and the same id there is another environment.
fn check_team_pick(
    pick: &EnvironmentPick,
    instance: &str,
    team_project: u64,
) -> Result<(), String> {
    if pick.instance.as_deref() == Some(instance) && pick.team_project == Some(team_project) {
        Ok(())
    } else {
        Err(
            "the folder's team project changed since the environment was picked: pick it again"
                .into(),
        )
    }
}

/// The run settings a run of the project `project_id` for `pick` starts with ([`read_run_settings`]), with a
/// protected environment refused unless the person confirmed this run against it ([`RunSettings::check_confirmed`]).
pub(crate) async fn read_settings_for_run(
    app: &AppHandle,
    project_id: &str,
    pick: Option<EnvironmentPick>,
) -> Result<RunSettings, String> {
    let settings = read_run_settings(app, project_id, pick.clone()).await?;
    settings.check_confirmed(pick.as_ref())?;
    Ok(settings)
}

/// The run settings of the bundled server's project `project_id` (digits only) for `pick`, read from its own server
/// (`GET /api/projects/:id/run-variables?environment=<id>`), or for a team environment from the team instance the
/// project's linked folder is also linked to (`GET /api/run-targets/projects/:id/run-variables?environment=<id>`, with
/// the target key), and checked. Errors when it does not answer them or a check fails, so the run does not start.
pub(crate) async fn read_run_settings(
    app: &AppHandle,
    project_id: &str,
    pick: Option<EnvironmentPick>,
) -> Result<RunSettings, String> {
    if !crate::runner::valid_project_id(project_id) {
        return Err("not a project id".into());
    }
    let pick = checked_pick(pick)?;
    if let Some(pick) = pick.as_ref().filter(|pick| pick.team) {
        let team = TeamLink::of(app, project_id)?;
        check_team_pick(pick, &team.instance, team.project_id)?;
        let answer = team
            .get_json(&format!(
                "/api/run-targets/projects/{}/run-variables?environment={}",
                team.project_id, pick.id
            ))
            .await
            .map_err(|e| format!("the team environment could not be read: {e}"))?;
        return checked_run_settings(&answer, Some(pick));
    }
    let server = server_info(app)
        .ok_or("the run variables could not be read: the app's server is not running")?;
    let path = match &pick {
        Some(pick) => format!(
            "/api/projects/{project_id}/run-variables?environment={}",
            pick.id
        ),
        None => format!("/api/projects/{project_id}/run-variables"),
    };
    let answer =
        tauri::async_runtime::spawn_blocking(move || crate::repro::local_get_json(&server, &path))
            .await
            .map_err(|e| format!("the run variables could not be read: {e}"))?
            .map_err(|e| format!("the run variables could not be read: {e}"))?;
    checked_run_settings(&answer, pick.as_ref())
}

fn server_info(app: &AppHandle) -> Option<crate::mcp_clients::ServerInfo> {
    app.try_state::<crate::mcp_clients::ServerInfo>()
        .map(|server| crate::mcp_clients::ServerInfo {
            port: server.port,
            token: server.token.clone(),
        })
}

/// The team project a desktop project's linked folder is also linked to, on the connected instance, with the key this
/// app keeps for it.
struct TeamLink {
    instance: String,
    project_id: u64,
    key: String,
}

impl TeamLink {
    /// The team link of the desktop project `project_id`. Errors when its folder is linked to no team project, or no
    /// key is kept for the instance.
    fn of(app: &AppHandle, project_id: &str) -> Result<Self, String> {
        let folder = crate::runner::linked_folder(app, project_id)
            .ok_or("no folder is linked to this project")?;
        let (instance, team_project) =
            crate::run_target::team_project_of_folder(app, Path::new(&folder.path)).ok_or(
                "the project's folder is linked to no project of the team instance the app is connected to",
            )?;
        let key = crate::run_target::kept_key(app, &instance)
            .map_err(|e| format!("the key of the team instance could not be read: {e}"))?
            .ok_or("the app keeps no key for the team instance: connect to it again")?;
        Ok(TeamLink {
            instance,
            project_id: team_project,
            key,
        })
    }

    /// The host the window names the team instance by.
    fn host(&self) -> String {
        let rest = self
            .instance
            .split_once("://")
            .map_or(self.instance.as_str(), |(_, rest)| rest);
        rest.split('/').next().unwrap_or(rest).to_string()
    }

    /// GET a JSON document of the team instance with the target key. `path` is built from validated parts only. No
    /// redirect is followed, so the key goes to the instance alone.
    async fn get_json(&self, path: &str) -> Result<Value, String> {
        // reqwest is built with rustls and no crypto provider of its own; this installs ring's, as the updater uses.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .timeout(TEAM_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        let url = format!("{}{path}", self.instance.trim_end_matches('/'));
        let response = client
            .get(url)
            .bearer_auth(&self.key)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|_| format!("{} cannot be reached", self.host()))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|_| format!("{} cannot be reached", self.host()))?;
        if !status.is_success() {
            let message = serde_json::from_slice::<Value>(&body)
                .ok()
                .and_then(|body| {
                    body.get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .filter(|message| !message.is_empty());
            return Err(match message {
                Some(message) => format!("{} answered: {message}", self.host()),
                None => format!("{} answered {}", self.host(), status.as_u16()),
            });
        }
        serde_json::from_slice(&body)
            .map_err(|_| format!("{} sent something other than JSON", self.host()))
    }
}

/// An environment of the team project, as the pickers offer it.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamEnvironment {
    #[serde(flatten)]
    environment: EnvironmentForRun,
    /// The other labels its runs report.
    aliases: Vec<String>,
    /// Whether the application under test is built from the run's checkout.
    app_from_checkout: bool,
}

/// The environments of the team project a desktop project's folder is also linked to.
#[derive(Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamEnvironments {
    /// The team instance; None when the folder is linked to no team project.
    instance: Option<String>,
    /// The team project's id on the instance.
    project_id: Option<u64>,
    /// Its environments that are not archived, in the instance's order, each checked.
    environments: Vec<TeamEnvironment>,
    /// Why they cannot be picked now: the instance cannot be reached, refused, or no key is kept for it.
    problem: Option<String>,
}

/// The environments of a team project's list (`{ environments }`), each checked: an archived one, or one that does not
/// pass, is left out.
fn team_environments_of(answer: &Value) -> Vec<TeamEnvironment> {
    let Some(listed) = answer.get("environments").and_then(Value::as_array) else {
        return Vec::new();
    };
    listed
        .iter()
        .filter(|record| record.get("archived").and_then(Value::as_bool) != Some(true))
        .filter_map(|record| {
            let environment = checked_environment(record).ok().flatten()?;
            let aliases = record
                .get("aliases")
                .and_then(Value::as_array)
                .map(|aliases| {
                    aliases
                        .iter()
                        .filter_map(Value::as_str)
                        .filter(|alias| {
                            !alias.is_empty() && alias.encode_utf16().count() <= MAX_KEY_UNITS
                        })
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            Some(TeamEnvironment {
                environment,
                aliases,
                app_from_checkout: record.get("appFromCheckout").and_then(Value::as_bool)
                    == Some(true),
            })
        })
        .collect()
}

/// The environments of the team project the desktop project `project_id`'s folder is also linked to, read from the
/// team instance with the target key now, never kept: the pickers offer them beside the project's own. Without such a
/// link, no instance; when the instance cannot be read, the reason.
#[tauri::command]
pub async fn desktop_team_environments(
    app: AppHandle,
    project_id: String,
) -> Result<TeamEnvironments, String> {
    if !crate::runner::valid_project_id(&project_id) {
        return Err("not a project id".into());
    }
    let Some(folder) = crate::runner::linked_folder(&app, &project_id) else {
        return Ok(TeamEnvironments::default());
    };
    let Some((instance, team_project)) =
        crate::run_target::team_project_of_folder(&app, Path::new(&folder.path))
    else {
        return Ok(TeamEnvironments::default());
    };
    let mut answer = TeamEnvironments {
        instance: Some(instance),
        project_id: Some(team_project),
        ..TeamEnvironments::default()
    };
    let team = match TeamLink::of(&app, &project_id) {
        Ok(team) => team,
        Err(e) => {
            answer.problem = Some(e);
            return Ok(answer);
        }
    };
    match team
        .get_json(&format!(
            "/api/run-targets/projects/{}/environments",
            team.project_id
        ))
        .await
    {
        Ok(listed) => answer.environments = team_environments_of(&listed),
        Err(e) => answer.problem = Some(e),
    }
    Ok(answer)
}

/// What a run of the desktop project `project_id` for `environment` gets, as the shell reads it when the run starts
/// ([`read_run_settings`]): the window shows it in the commands it shows.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSettingsView {
    run_variables: Vec<Value>,
    environment: Option<EnvironmentForRun>,
}

/// The run variables and the environment a run of the desktop project `project_id` for `environment` gets.
#[tauri::command]
pub async fn desktop_environment_run_settings(
    app: AppHandle,
    project_id: String,
    environment: Option<EnvironmentPick>,
) -> Result<RunSettingsView, String> {
    let settings = read_run_settings(&app, &project_id, environment).await?;
    Ok(RunSettingsView {
        run_variables: settings
            .variables
            .iter()
            .map(|(name, value)| serde_json::json!({ "name": name, "value": value }))
            .collect(),
        environment: settings.environment,
    })
}

/// The env files a linked folder holds at its root, by name, sorted: plain files whose name passes [`env_file_ok`],
/// never a link. Their content is never read.
pub(crate) fn env_files_in(folder: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| env_file_ok(name))
        .collect();
    names.sort();
    names.truncate(MAX_ENV_FILES_LISTED);
    names
}

/// What [`copy_env_file`] did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EnvFileCopy {
    /// The worktree has a copy of the linked folder's file.
    Copied,
    /// The linked folder holds no such file.
    Missing,
    /// The worktree's checkout already holds a file of that name, which is kept.
    Kept,
}

/// Copy the env file `name` from the linked folder `folder` into the worktree `worktree`, readable by its owner only:
/// a plain file of at most 1 MB, never through a link, the name checked again ([`env_file_ok`]). A file of that name the
/// checkout holds is kept. The copy goes with the worktree.
pub(crate) fn copy_env_file(
    folder: &Path,
    worktree: &Path,
    name: &str,
) -> Result<EnvFileCopy, String> {
    use std::io::Read as _;
    if !env_file_ok(name) {
        return Err(format!("{name:?} is not an env file name"));
    }
    let source = folder.join(name);
    let seen = match std::fs::symlink_metadata(&source) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(EnvFileCopy::Missing),
        Err(e) => return Err(format!("{name} could not be read: {e}")),
    };
    if !seen.file_type().is_file() {
        return Err(format!(
            "{name} in the linked folder is not a plain file: it is not copied"
        ));
    }
    if std::fs::symlink_metadata(worktree.join(name)).is_ok() {
        return Ok(EnvFileCopy::Kept);
    }
    let file =
        std::fs::File::open(&source).map_err(|e| format!("{name} could not be read: {e}"))?;
    let opened = file
        .metadata()
        .map_err(|e| format!("{name} could not be read: {e}"))?;
    if !opened.is_file() || !same_file(&seen, &opened) {
        return Err(format!(
            "{name} in the linked folder changed as it was read: it is not copied"
        ));
    }
    let mut contents = Vec::new();
    file.take(MAX_ENV_FILE_BYTES + 1)
        .read_to_end(&mut contents)
        .map_err(|e| format!("{name} could not be read: {e}"))?;
    if contents.len() as u64 > MAX_ENV_FILE_BYTES {
        return Err(format!("{name} is larger than 1 MB: it is not copied"));
    }
    match crate::private_fs::create_private_new(&worktree.join(name), &contents) {
        Ok(true) => Ok(EnvFileCopy::Copied),
        Ok(false) => Ok(EnvFileCopy::Kept),
        Err(e) => Err(format!("{name} could not be copied into the worktree: {e}")),
    }
}

/// Whether the file seen at a path and the file opened there are the same one.
#[cfg(unix)]
fn same_file(seen: &std::fs::Metadata, opened: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    seen.dev() == opened.dev() && seen.ino() == opened.ino()
}

#[cfg(not(unix))]
fn same_file(seen: &std::fs::Metadata, opened: &std::fs::Metadata) -> bool {
    seen.len() == opened.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn staging() -> Value {
        json!({ "id": 3, "key": "staging", "name": "Staging", "protected": false, "requiredTags": [], "envFile": ".env.staging" })
    }

    fn production() -> Value {
        json!({ "id": 4, "key": "production", "name": "Production", "protected": true, "requiredTags": ["@smoke", "@read-only"], "envFile": null })
    }

    #[test]
    fn reads_the_environment_a_run_is_for() {
        assert_eq!(checked_environment(&Value::Null).unwrap(), None);
        assert_eq!(
            checked_environment(&staging()).unwrap(),
            Some(EnvironmentForRun {
                id: 3,
                key: "staging".into(),
                name: "Staging".into(),
                protected: false,
                required_tags: vec![],
                env_file: Some(".env.staging".into()),
            })
        );
        let unprotected_with_tags = json!({ "id": 3, "key": "staging", "name": "Staging", "protected": false, "requiredTags": ["@smoke"] });
        assert_eq!(
            checked_environment(&unprotected_with_tags)
                .unwrap()
                .unwrap()
                .required_tags,
            Vec::<String>::new()
        );
    }

    #[test]
    fn refuses_an_environment_core_refuses() {
        let with = |field: &str, value: Value| {
            let mut environment = production();
            environment[field] = value;
            checked_environment(&environment)
        };
        assert!(checked_environment(&json!("staging")).is_err());
        assert!(with("id", json!(0)).is_err());
        assert!(with("id", json!("4")).is_err());
        assert!(with("id", json!(9_007_199_254_740_992u64)).is_err());
        assert!(with("key", json!("")).is_err());
        assert!(with("key", json!("x".repeat(81))).is_err());
        assert!(with("key", json!("x".repeat(80))).is_ok());
        assert!(with("key", json!("prod;rm")).is_err());
        assert!(with("key", json!("$HOME")).is_err());
        assert!(with("key", json!(" prod")).is_err());
        assert!(with("name", json!("  ")).is_err());
        assert!(with("name", json!("Pro\u{202E}d")).is_err());
        assert!(with("name", json!("x".repeat(81))).is_err());
        assert!(with("protected", json!("yes")).is_err());
        assert!(with("requiredTags", json!([])).is_err());
        assert!(with("requiredTags", json!("@smoke")).is_err());
        assert!(with("requiredTags", json!(["smoke"])).is_err());
        assert!(with("requiredTags", json!(["@smoke|.*"])).is_err());
        assert!(with("requiredTags", json!([format!("@{}", "a".repeat(64))])).is_err());
        assert!(with("requiredTags", json!([format!("@{}", "a".repeat(63))])).is_ok());
        let eleven: Vec<String> = (0..11).map(|i| format!("@t{i}")).collect();
        assert!(with("requiredTags", json!(eleven)).is_err());
        assert!(with("envFile", json!("../.env")).is_err());
        assert!(with("envFile", json!(".env/staging")).is_err());
        assert!(with("envFile", json!(1)).is_err());
    }

    #[test]
    fn an_env_file_is_a_name_never_a_folder() {
        for ok in [".env", ".env.staging", ".env.eu-west_2.local"] {
            assert!(env_file_ok(ok), "{ok}");
        }
        for refused in [
            "", "env", ".envrc", ".env.", ".env..x", ".env/x", "../.env", ".env.a b", ".env.é",
            ".env\\x",
        ] {
            assert!(!env_file_ok(refused), "{refused}");
        }
        assert!(env_file_ok(&format!(".env.{}", "a".repeat(59))));
        assert!(!env_file_ok(&format!(".env.{}", "a".repeat(60))));
    }

    #[test]
    fn a_protected_environment_keeps_the_run_to_its_required_tags() {
        let settings = checked_run_settings(
            &json!({ "runVariables": [{ "name": "TEST_ENV", "value": "production" }], "environment": production() }),
            Some(&EnvironmentPick { id: 4, team: false, ..Default::default() }),
        )
        .unwrap();
        assert_eq!(
            settings.envs(),
            vec![
                ("TEST_ENV".to_string(), "production".to_string()),
                ("PIWI_ENVIRONMENT".to_string(), "production".to_string())
            ]
        );
        assert_eq!(
            settings.args(),
            vec![r"--grep-invert=^(?!.*(?:^|\s)(?:@smoke|@read-only)(?:\s|$))".to_string()]
        );
        assert!(settings.refuse_protected("Flake Lab", "why").is_err());
        // The shell adds it; the window can never pass one.
        assert!(crate::runner::validate_args(&settings.args()).is_err());

        let staging = checked_run_settings(
            &json!({ "runVariables": [], "environment": staging() }),
            Some(&EnvironmentPick {
                id: 3,
                team: true,
                ..Default::default()
            }),
        )
        .unwrap();
        assert!(staging.args().is_empty());
        assert!(staging.refuse_protected("Flake Lab", "why").is_ok());
        assert_eq!(
            staging.envs(),
            vec![("PIWI_ENVIRONMENT".to_string(), "staging".to_string())]
        );
    }

    #[test]
    fn the_environment_answered_is_the_one_picked() {
        let none = checked_run_settings(&json!({ "runVariables": [], "environment": null }), None)
            .unwrap();
        assert_eq!(none, RunSettings::default());
        assert!(none.envs().is_empty() && none.args().is_empty());
        assert!(checked_run_settings(
            &json!({ "runVariables": [], "environment": staging() }),
            None
        )
        .is_err());
        assert!(checked_run_settings(
            &json!({ "runVariables": [], "environment": null }),
            Some(&EnvironmentPick {
                id: 3,
                team: false,
                ..Default::default()
            })
        )
        .is_err());
        assert!(checked_run_settings(
            &json!({ "runVariables": [], "environment": staging() }),
            Some(&EnvironmentPick {
                id: 4,
                team: false,
                ..Default::default()
            })
        )
        .is_err());
        assert!(checked_run_settings(&json!({ "environment": null }), None).is_err());
    }

    #[test]
    fn an_environment_s_run_gets_twenty_variables_and_a_project_s_ten() {
        let list = |count: usize| -> Value {
            Value::Array(
                (0..count)
                    .map(|i| json!({ "name": format!("V{i}"), "value": "x" }))
                    .collect(),
            )
        };
        let pick = Some(&EnvironmentPick {
            id: 3,
            team: false,
            ..Default::default()
        });
        assert!(checked_run_settings(
            &json!({ "runVariables": list(20), "environment": staging() }),
            pick
        )
        .is_ok());
        assert!(checked_run_settings(
            &json!({ "runVariables": list(21), "environment": staging() }),
            pick
        )
        .is_err());
        assert!(checked_run_settings(
            &json!({ "runVariables": list(10), "environment": null }),
            None
        )
        .is_ok());
        assert!(checked_run_settings(
            &json!({ "runVariables": list(11), "environment": null }),
            None
        )
        .is_err());
        let refused = json!({ "runVariables": [{ "name": "PIWI_ENVIRONMENT", "value": "x" }], "environment": staging() });
        assert!(checked_run_settings(&refused, pick).is_err());
    }

    #[test]
    fn a_protected_environment_runs_only_once_confirmed_by_its_key() {
        let settings =
            checked_settings(&json!({ "runVariables": [], "environment": production() })).unwrap();
        let pick = |confirmed: Option<&str>| EnvironmentPick {
            id: 4,
            confirmed: confirmed.map(str::to_string),
            ..Default::default()
        };
        assert!(settings.check_confirmed(None).is_err());
        assert!(settings.check_confirmed(Some(&pick(None))).is_err());
        assert!(settings.check_confirmed(Some(&pick(Some("prod")))).is_err());
        assert!(settings
            .check_confirmed(Some(&pick(Some("production"))))
            .is_ok());
        let staging =
            checked_settings(&json!({ "runVariables": [], "environment": staging() })).unwrap();
        assert!(staging.check_confirmed(Some(&pick(None))).is_ok());
        assert!(RunSettings::default().check_confirmed(None).is_ok());
        let refused = settings
            .refuse_protected("A bisect", "each step would run no test")
            .unwrap_err();
        assert_eq!(
            refused,
            "A bisect never runs against a protected environment (Production): each step would run no test"
        );
    }

    #[test]
    fn a_team_pick_names_the_instance_and_project_the_folder_is_linked_to_now() {
        let pick = EnvironmentPick {
            id: 3,
            team: true,
            instance: Some("https://piwi.example.com".into()),
            team_project: Some(12),
            confirmed: None,
        };
        assert!(check_team_pick(&pick, "https://piwi.example.com", 12).is_ok());
        assert!(check_team_pick(&pick, "https://other.example.com", 12).is_err());
        assert!(check_team_pick(&pick, "https://piwi.example.com", 13).is_err());
        let unnamed = EnvironmentPick {
            id: 3,
            team: true,
            ..Default::default()
        };
        assert!(check_team_pick(&unnamed, "https://piwi.example.com", 12).is_err());
    }

    #[test]
    fn counts_the_tests_a_listing_selects() {
        let report = r#"{"config":{},"suites":[{"title":"a.spec.ts","specs":[{"title":"one","tests":[{}]},{"title":"two","tests":[]}],"suites":[{"title":"group","specs":[{"title":"three","tests":[{},{}]}]}]}],"errors":[]}"#;
        assert_eq!(
            listed_tests(&format!("config says hello\n{report}")),
            Some(ListedTests {
                count: 2,
                error: None
            })
        );
        assert_eq!(
            listed_tests(r#"{"suites":[],"errors":[{"message":"Error: No tests found\nmore"}]}"#),
            Some(ListedTests {
                count: 0,
                error: Some("Error: No tests found".into())
            })
        );
        assert_eq!(listed_tests("Error: Cannot find module"), None);
    }

    #[test]
    fn a_pick_has_an_id_and_says_whether_it_is_the_team_s() {
        let pick: EnvironmentPick = serde_json::from_value(json!({ "id": 3 })).unwrap();
        assert_eq!(
            pick,
            EnvironmentPick {
                id: 3,
                team: false,
                ..Default::default()
            }
        );
        let team: EnvironmentPick = serde_json::from_value(json!({
            "id": 3, "team": true, "instance": "https://piwi.example.com", "teamProject": 12, "confirmed": null
        }))
        .unwrap();
        assert_eq!(team.team_project, Some(12));
        assert!(serde_json::from_value::<EnvironmentPick>(json!({ "id": 3, "key": "x" })).is_err());
        assert!(checked_pick(Some(EnvironmentPick {
            id: 0,
            team: false,
            ..Default::default()
        }))
        .is_err());
        assert!(checked_pick(None).unwrap().is_none());
    }

    #[test]
    fn lists_the_team_project_s_environments_that_pass() {
        let mut archived = staging();
        archived["archived"] = json!(true);
        let mut with_aliases = staging();
        with_aliases["aliases"] = json!(["stg", 3, "pr-*"]);
        with_aliases["appFromCheckout"] = json!(true);
        let listed = team_environments_of(&json!({ "environments": [
            with_aliases,
            archived,
            { "id": 9, "key": "bad key;", "name": "Bad", "protected": false, "requiredTags": [] },
            production(),
        ] }));
        assert_eq!(listed.len(), 2);
        assert_eq!(
            listed[0].aliases,
            vec!["stg".to_string(), "pr-*".to_string()]
        );
        assert!(listed[0].app_from_checkout);
        assert!(listed[1].environment.protected);
        assert!(team_environments_of(&json!({})).is_empty());
    }

    struct Dir(std::path::PathBuf);

    impl Dir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "piwi-environments-{label}-{}",
                crate::random_hex_32()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Dir(dir)
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lists_the_env_files_a_folder_holds_never_a_folder() {
        let folder = Dir::new("list");
        std::fs::write(folder.0.join(".env.staging"), "A=1").unwrap();
        std::fs::write(folder.0.join(".env"), "A=1").unwrap();
        std::fs::write(folder.0.join(".envrc"), "A=1").unwrap();
        std::fs::create_dir(folder.0.join(".env.dir")).unwrap();
        assert_eq!(
            env_files_in(&folder.0),
            vec![".env".to_string(), ".env.staging".to_string()]
        );
        assert!(env_files_in(&folder.0.join("missing")).is_empty());
    }

    #[test]
    fn copies_the_env_file_into_the_worktree_once() {
        let folder = Dir::new("from");
        let worktree = Dir::new("to");
        assert_eq!(
            copy_env_file(&folder.0, &worktree.0, ".env.staging").unwrap(),
            EnvFileCopy::Missing
        );
        std::fs::write(folder.0.join(".env.staging"), "SECRET=1").unwrap();
        assert_eq!(
            copy_env_file(&folder.0, &worktree.0, ".env.staging").unwrap(),
            EnvFileCopy::Copied
        );
        assert_eq!(
            std::fs::read_to_string(worktree.0.join(".env.staging")).unwrap(),
            "SECRET=1"
        );
        std::fs::write(folder.0.join(".env.staging"), "SECRET=2").unwrap();
        assert_eq!(
            copy_env_file(&folder.0, &worktree.0, ".env.staging").unwrap(),
            EnvFileCopy::Kept
        );
        assert_eq!(
            std::fs::read_to_string(worktree.0.join(".env.staging")).unwrap(),
            "SECRET=1"
        );
        assert!(copy_env_file(&folder.0, &worktree.0, "../.env").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn never_copies_through_a_link() {
        let folder = Dir::new("link");
        let worktree = Dir::new("link-to");
        let elsewhere = Dir::new("elsewhere");
        std::fs::write(elsewhere.0.join("secret"), "KEY=1").unwrap();
        std::os::unix::fs::symlink(elsewhere.0.join("secret"), folder.0.join(".env.staging"))
            .unwrap();
        assert!(copy_env_file(&folder.0, &worktree.0, ".env.staging").is_err());
        assert!(!worktree.0.join(".env.staging").exists());
        assert!(env_files_in(&folder.0).is_empty());
    }
}
