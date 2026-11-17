//! What the shell says (the tray menu, the start screen, the questions it asks), from Piwi Runner's catalogs
//! (`apps/runner/locales/<code>.json`), embedded at build: the window's catalogs, in Piwi Picker's shape, whose
//! `shell_` messages are the shell's. Piwi Runner speaks the language chosen in its window, else the system's; the
//! desktop app manages no language and speaks English. The start screen speaks the language Runner started in.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

/// The languages Piwi Runner ships, by its catalogs' codes.
pub(crate) const LANGUAGES: [&str; 5] = ["en", "de", "es", "fr", "pt_BR"];

const CATALOGS: [(&str, &str); 5] = [
    ("en", include_str!("../../../runner/locales/en.json")),
    ("de", include_str!("../../../runner/locales/de.json")),
    ("es", include_str!("../../../runner/locales/es.json")),
    ("fr", include_str!("../../../runner/locales/fr.json")),
    ("pt_BR", include_str!("../../../runner/locales/pt_BR.json")),
];

/// Where the settings keep the language chosen in the window; absent while Runner follows the system.
const LANGUAGE_KEY: &str = "language";

/// Event the shell sends the window when the language changes, with the language as it stands (`LanguageInfo`).
const LANGUAGE_EVENT: &str = "piwi:language";

#[derive(serde::Deserialize)]
struct CatalogEntry {
    message: String,
}

/// The messages of one catalog by key.
fn messages(catalog: &str) -> HashMap<String, String> {
    serde_json::from_str::<HashMap<String, CatalogEntry>>(catalog)
        .map(|entries| entries.into_iter().map(|(key, entry)| (key, entry.message)).collect())
        .unwrap_or_default()
}

/// A shipped language's code, or English for any other.
fn shipped(code: &str) -> &'static str {
    LANGUAGES.iter().find(|known| **known == code).copied().unwrap_or("en")
}

/// The shipped language a locale reads as (`fr-FR`, `fr_CA.UTF-8`): its language's catalog, Portuguese for `pt-BR`
/// alone, English for any other, as Piwi Picker reads a browser's language.
pub(crate) fn shipped_language(locale: &str) -> &'static str {
    let tag = locale.split(['.', '@']).next().unwrap_or("").replace('_', "-").to_ascii_lowercase();
    let mut parts = tag.split('-');
    match (parts.next().unwrap_or(""), parts.next()) {
        ("pt", Some("br")) => "pt_BR",
        ("de", _) => "de",
        ("es", _) => "es",
        ("fr", _) => "fr",
        _ => "en",
    }
}

/// The system's language, as a shipped one.
fn system_language() -> &'static str {
    shipped_language(&sys_locale::get_locale().unwrap_or_default())
}

/// The plural form `language` gives the count `n`: French and Portuguese put 0 with 1. A new language adds its rule
/// here, as `Intl.PluralRules` gives it.
fn plural_form(language: &str, n: usize) -> &'static str {
    let one = match language {
        "fr" | "pt_BR" => n <= 1,
        _ => n == 1,
    };
    if one {
        "one"
    } else {
        "other"
    }
}

/// The words of one language, English for a key its catalog lacks.
pub(crate) struct ShellWords {
    language: &'static str,
    messages: HashMap<String, String>,
}

impl ShellWords {
    /// The words of the shipped language `code`, English for any other.
    pub(crate) fn of(code: &str) -> Self {
        let language = shipped(code);
        let mut all = messages(CATALOGS[0].1);
        if let Some((_, catalog)) = CATALOGS.iter().find(|(known, _)| *known == language && language != "en") {
            all.extend(messages(catalog));
        }
        ShellWords { language, messages: all }
    }

    pub(crate) fn english() -> Self {
        Self::of("en")
    }

    /// The message `key` with each `$name$` the value `args` gives it (an absent one empty) and `$$` a dollar sign;
    /// the key itself when no catalog holds it.
    pub(crate) fn say(&self, key: &str, args: &[(&str, &str)]) -> String {
        let Some(message) = self.messages.get(key) else {
            return key.to_string();
        };
        let mut out = String::with_capacity(message.len());
        let mut rest = message.as_str();
        while let Some(start) = rest.find('$') {
            out.push_str(&rest[..start]);
            let after = &rest[start + 1..];
            if let Some(stripped) = after.strip_prefix('$') {
                out.push('$');
                rest = stripped;
                continue;
            }
            match after.find('$') {
                Some(end) if after[..end].chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && end > 0 => {
                    let name = &after[..end];
                    if let Some((_, value)) = args.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)) {
                        out.push_str(value);
                    }
                    rest = &after[end + 1..];
                }
                _ => {
                    out.push('$');
                    rest = after;
                }
            }
        }
        out.push_str(rest);
        out
    }

    /// The counted message `base` in the plural form the language gives `count`, its `$count$` the number.
    pub(crate) fn count(&self, base: &str, count: usize, args: &[(&str, &str)]) -> String {
        let number = count.to_string();
        let mut all: Vec<(&str, &str)> = args.to_vec();
        all.push(("count", &number));
        let form = format!("{base}_{}", plural_form(self.language, count));
        let key = if self.messages.contains_key(&form) { form } else { format!("{base}_other") };
        self.say(&key, &all)
    }
}

/// The language Piwi Runner speaks: the one chosen in its window, else the system's, with its words.
pub(crate) struct ShellLanguage {
    chosen: RwLock<Option<&'static str>>,
    words: RwLock<Arc<ShellWords>>,
    /// How many times the language was chosen since the launch: the window shows no answer older than one it showed.
    serial: AtomicU64,
}

impl ShellLanguage {
    /// The language as last chosen, else the system's.
    pub(crate) fn from_saved(app: &AppHandle) -> Self {
        // A saved language Runner does not ship follows the system's again.
        let chosen = app
            .store(crate::STORE_FILE)
            .ok()
            .and_then(|s| s.get(LANGUAGE_KEY))
            .and_then(|v| v.as_str().and_then(|code| LANGUAGES.iter().find(|known| **known == code).copied()));
        let words = ShellWords::of(chosen.unwrap_or_else(system_language));
        ShellLanguage {
            chosen: RwLock::new(chosen),
            words: RwLock::new(Arc::new(words)),
            serial: AtomicU64::new(0),
        }
    }

    fn info(&self) -> LanguageInfo {
        LanguageInfo {
            language: self.words.read().map(|w| w.language).unwrap_or("en"),
            chosen: self.chosen.read().map(|c| *c).unwrap_or(None),
            system: system_language(),
            serial: self.serial.load(Ordering::SeqCst),
        }
    }
}

/// The words the shell speaks now: Piwi Runner's language, English in an app that manages none.
pub(crate) fn shell_words<R: tauri::Runtime>(app: &AppHandle<R>) -> Arc<ShellWords> {
    app.try_state::<ShellLanguage>()
        .and_then(|language| language.words.read().ok().map(|w| Arc::clone(&w)))
        .unwrap_or_else(|| Arc::new(ShellWords::english()))
}

/// The language as the window shows it: the one on screen, the one chosen (none while it follows the system), the
/// system's, and the number of the choice it follows (`ShellLanguage::serial`).
#[derive(Clone, serde::Serialize)]
pub(crate) struct LanguageInfo {
    language: &'static str,
    chosen: Option<&'static str>,
    system: &'static str,
    serial: u64,
}

#[tauri::command]
pub(crate) fn desktop_get_language(app: AppHandle) -> LanguageInfo {
    app.try_state::<ShellLanguage>().map(|l| l.info()).unwrap_or(LanguageInfo {
        language: "en",
        chosen: None,
        system: system_language(),
        serial: 0,
    })
}

/// Chooses the language, or follows the system's again (`None`): saved, said by the tray and the shell's next words
/// (the start screen's once Runner starts again), and told to the window (`piwi:language`). Refuses a language Runner
/// does not ship.
#[tauri::command]
pub(crate) fn desktop_set_language(app: AppHandle, language: Option<String>) -> Result<LanguageInfo, String> {
    let chosen = match language.as_deref() {
        None => None,
        Some(code) if LANGUAGES.contains(&code) => Some(shipped(code)),
        Some(_) => return Err("Piwi Runner has no catalog for this language.".to_string()),
    };
    let state = app.try_state::<ShellLanguage>().ok_or("The shell keeps no language.")?;
    if let Ok(store) = app.store(crate::STORE_FILE) {
        match chosen {
            Some(code) => store.set(LANGUAGE_KEY, json!(code)),
            None => {
                store.delete(LANGUAGE_KEY);
            }
        }
        let _ = store.save();
    }
    if let Ok(mut current) = state.chosen.write() {
        *current = chosen;
    }
    if let Ok(mut words) = state.words.write() {
        *words = Arc::new(ShellWords::of(chosen.unwrap_or_else(system_language)));
    }
    state.serial.fetch_add(1, Ordering::SeqCst);
    crate::runner_app::relabel_tray(&app);
    let info = state.info();
    let _ = app.emit(LANGUAGE_EVENT, info.clone());
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::{shipped_language, ShellWords, CATALOGS, LANGUAGES};

    #[test]
    fn a_locale_reads_as_a_shipped_language() {
        assert_eq!(shipped_language("fr-FR"), "fr");
        assert_eq!(shipped_language("fr_CA.UTF-8"), "fr");
        assert_eq!(shipped_language("de-AT"), "de");
        assert_eq!(shipped_language("es-419"), "es");
        assert_eq!(shipped_language("pt-BR"), "pt_BR");
        assert_eq!(shipped_language("pt_BR.UTF-8"), "pt_BR");
        assert_eq!(shipped_language("pt-PT"), "en");
        assert_eq!(shipped_language("ja-JP"), "en");
        assert_eq!(shipped_language(""), "en");
    }

    #[test]
    fn fills_placeholders_by_name_and_counts_by_the_language() {
        let english = ShellWords::english();
        assert_eq!(english.say("shell_quitQuestion", &[("app", "Piwi Runner")]), "Quit Piwi Runner?");
        assert_eq!(
            english.count("shell_runsGoingQuit", 1, &[]),
            "1 local test run is still running: quitting stops it."
        );
        assert_eq!(
            english.count("shell_runsGoingQuit", 2, &[]),
            "2 local test runs are still running: quitting stops them."
        );
        let french = ShellWords::of("fr");
        assert_eq!(french.count("shell_runsGoingQuit", 0, &[]), french.say("shell_runsGoingQuit_one", &[("count", "0")]));
        assert_ne!(french.say("shell_quit", &[("app", "Piwi Runner")]), "Quit Piwi Runner");
    }

    #[test]
    fn keeps_a_dollar_sign_and_an_unknown_key() {
        let words = ShellWords::english();
        assert_eq!(words.say("shell_nowhere", &[]), "shell_nowhere");
        assert_eq!(super::ShellWords::of("xx").say("shell_showLogs", &[]), "Show logs");
    }

    /// Every key the crate says (`say("…"` and `count("…"` with a literal key), from its own source.
    fn keys_said() -> Vec<String> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut keys = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().map_or(true, |e| e != "rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            for call in ["say(\"", "count(\""] {
                for (at, _) in text.match_indices(call) {
                    let rest = &text[at + call.len()..];
                    let key: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
                    if rest[key.len()..].starts_with('"') && !key.is_empty() && key != "shell_nowhere" {
                        keys.push(key);
                    }
                }
            }
        }
        keys.sort();
        keys.dedup();
        keys
    }

    #[test]
    fn every_key_the_shell_says_is_in_the_english_catalog() {
        let english = super::messages(CATALOGS[0].1);
        let said = keys_said();
        assert!(said.len() > 20, "{said:?}");
        for key in said {
            assert!(
                english.contains_key(&key) || english.contains_key(&format!("{key}_other")),
                "{key} is in no catalog"
            );
        }
    }

    #[test]
    fn ships_the_languages_of_runners_catalogs() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../runner/locales");
        let mut codes: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| {
                let name = entry.ok()?.file_name().into_string().ok()?;
                name.strip_suffix(".json").map(str::to_string)
            })
            .collect();
        codes.sort();
        let mut shipped: Vec<String> = LANGUAGES.iter().map(|c| c.to_string()).collect();
        shipped.sort();
        assert_eq!(codes, shipped);
    }

    #[test]
    fn ships_a_catalog_for_each_language_with_every_shell_message() {
        let english = super::messages(CATALOGS[0].1);
        for code in LANGUAGES {
            let (_, catalog) = CATALOGS.iter().find(|(known, _)| *known == code).unwrap();
            let messages = super::messages(catalog);
            for key in english.keys().filter(|k| k.starts_with("shell_")) {
                let base = key.trim_end_matches("_one").trim_end_matches("_other");
                assert!(
                    messages.contains_key(key) || (base != key && messages.contains_key(&format!("{base}_other"))),
                    "{code}: {key}"
                );
            }
        }
    }
}
