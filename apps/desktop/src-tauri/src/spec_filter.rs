//! The test filters of a run the shell starts in a folder it knows, anchored at that folder.

/// The options of `ALLOWED_FLAGS` that take a value, which an argument may give apart (`--project x`, `-G x`).
pub(crate) const VALUE_FLAGS: [&str; 9] = [
    "--trace",
    "--repeat-each",
    "--project",
    "--grep",
    "-G",
    "--workers",
    "--retries",
    "--max-failures",
    "--timeout",
];

/// The options of `ALLOWED_FLAGS` whose value is optional: Playwright takes the next argument as their value when it
/// is no option (`--shuffle 42`).
const OPTIONAL_VALUE_FLAGS: [&str; 1] = ["--shuffle"];

/// The ASCII characters Node's `pathToFileURL` may percent-encode in a Windows path, which a filter of the `file:` URL
/// matches written either way.
const URL_ENCODED: &str = " \"#%<>?[]^`{|}~";

/// `args` with each test filter anchored at `folder`, the folder Playwright runs in as its `process.cwd()` spells it.
///
/// A test filter is an argument that is neither an option nor an option's value. The app writes it relative to the
/// config's folder, as `specPattern` does (`tests/cart.spec.ts:12`). It becomes the spec's whole path, anchored at both
/// ends, its `:line` kept (`^/repo/tests/cart.spec.ts$:12`), so it never takes a spec whose path ends as its own
/// (`e2e/tests/cart.spec.ts`, `tests/cart.spec.tsx`). With `windows`, the path's `file:` URL is an alternative: Playwright
/// up to 1.62 tests a filter there against the native path and the `file:` URL, never the `/`-separated path. A filter
/// already anchored (`^…`, or a `/…/` regular expression) is left as it is.
pub(crate) fn anchored_filters(folder: &str, args: &[String], windows: bool) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut value_next = false;
    let mut optional_value_next = false;
    for arg in args {
        if value_next || (optional_value_next && !arg.starts_with('-')) {
            value_next = false;
            optional_value_next = false;
            out.push(arg.clone());
        } else if arg.starts_with('-') {
            let apart = !arg.contains('=');
            value_next = apart && VALUE_FLAGS.contains(&arg.as_str());
            optional_value_next = apart && OPTIONAL_VALUE_FLAGS.contains(&arg.as_str());
            out.push(arg.clone());
        } else if arg.starts_with('^') || arg.starts_with('/') {
            out.push(arg.clone());
        } else {
            out.push(anchored(folder, arg, windows));
        }
    }
    out
}

/// One filter anchored at `folder` (see [`anchored_filters`]).
fn anchored(folder: &str, filter: &str, windows: bool) -> String {
    let (file, location) = split_location(filter);
    let folder = folder.replace('\\', "/");
    let folder = folder.trim_end_matches('/');
    let spelled = format!("{}/{file}", escape(folder));
    if !windows {
        return format!("^{spelled}${location}");
    }
    let url = format!("{}/{}", url_pattern(&file_url(folder)), url_file(file));
    format!("^(?:{spelled}|{url})${location}")
}

/// A location filter's file and its `:line` (and `:column`), as Playwright splits them.
fn split_location(arg: &str) -> (&str, &str) {
    let mut end = arg.len();
    for _ in 0..2 {
        let head = &arg[..end];
        let digits = head.len() - head.trim_end_matches(|c: char| c.is_ascii_digit()).len();
        if digits == 0 || !head[..head.len() - digits].ends_with(':') {
            break;
        }
        end = head.len() - digits - 1;
    }
    (&arg[..end], &arg[end..])
}

/// A path's characters as a regular expression reads them literally.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A `/`-separated Windows folder as its `file:` URL, before encoding: `C:/w` gives `file:///C:/w`, a share's
/// `//host/share` gives `file://host/share`.
fn file_url(folder: &str) -> String {
    if folder.starts_with("//") {
        format!("file:{folder}")
    } else {
        format!("file:///{folder}")
    }
}

/// A literal character of a `file:` URL's path as a regular expression: itself where Node never encodes it, either
/// itself or its percent-encoding where it may, its percent-encoded bytes for a control or a non-ASCII character.
fn url_char(c: char, literal: &str) -> String {
    let encoded = || {
        let mut bytes = [0u8; 4];
        c.encode_utf8(&mut bytes)
            .bytes()
            .map(|b| format!("%{b:02X}"))
            .collect::<String>()
    };
    if !c.is_ascii() || c.is_ascii_control() {
        encoded()
    } else if URL_ENCODED.contains(c) {
        format!("(?:{literal}|{})", encoded())
    } else {
        literal.to_string()
    }
}

/// A folder's `file:` URL, unencoded, as a regular expression that matches it as Node's `pathToFileURL` writes it.
fn url_pattern(url: &str) -> String {
    url.chars()
        .map(|c| url_char(c, &escape(&c.to_string())))
        .collect()
}

/// A `.` of the app's filter in its `file:` URL. `specPattern` writes a `.` for a `.` and for each character it cannot
/// keep: `$` and `!`, which the URL keeps, `%`, `^`, a backtick and `"`, which Node writes as one percent-encoded byte,
/// and the curly quotes `“ ” „`, as three.
const URL_ANY_CHAR: &str = "(?:.|%[0-9A-F]{2}|%E2%80%9[CDE])";

/// The app's relative filter (`specPattern`'s regular expression) as a regular expression of its `file:` URL: each
/// literal character as [`url_char`] writes it, each `[c]` class as its character, each `.` as [`URL_ANY_CHAR`].
fn url_file(filter: &str) -> String {
    let chars: Vec<char> = filter.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' && i + 2 < chars.len() && chars[i + 2] == ']' {
            let c = chars[i + 1];
            out.push_str(&url_char(c, &format!("[{c}]")));
            i += 3;
        } else if chars[i] == '.' {
            out.push_str(URL_ANY_CHAR);
            i += 1;
        } else {
            let c = chars[i];
            out.push_str(&url_char(c, &c.to_string()));
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn one(folder: &str, filter: &str, windows: bool) -> String {
        anchored_filters(folder, &args(&[filter]), windows).remove(0)
    }

    #[test]
    fn anchors_each_filter_at_the_folder_and_leaves_the_options() {
        let out = anchored_filters(
            "/repo/",
            &args(&[
                "tests/a.spec.ts:12",
                "tests/b.spec.ts",
                "--project",
                "chromium",
                "--grep=pays",
                "--headed",
            ]),
            false,
        );
        assert_eq!(
            out,
            args(&[
                "^/repo/tests/a.spec.ts$:12",
                "^/repo/tests/b.spec.ts$",
                "--project",
                "chromium",
                "--grep=pays",
                "--headed"
            ])
        );
    }

    #[test]
    fn leaves_the_value_of_a_short_option_and_a_shuffle_seed_given_apart() {
        let out = anchored_filters(
            "/repo",
            &args(&[
                "-G",
                "slow",
                "--shuffle",
                "42",
                "tests/a.spec.ts",
                "--shuffle",
                "-x",
                "tests/b.spec.ts",
                "--shuffle=7",
                "tests/c.spec.ts",
            ]),
            false,
        );
        assert_eq!(
            out,
            args(&[
                "-G",
                "slow",
                "--shuffle",
                "42",
                "^/repo/tests/a.spec.ts$",
                "--shuffle",
                "-x",
                "^/repo/tests/b.spec.ts$",
                "--shuffle=7",
                "^/repo/tests/c.spec.ts$",
            ])
        );
    }

    #[test]
    fn escapes_the_folder_and_keeps_the_apps_own_pattern() {
        assert_eq!(
            one(
                "/home/me/shop (old)+1.x",
                "app/[(]auth[)]/a.spec.ts:3:7",
                false
            ),
            r"^/home/me/shop \(old\)\+1\.x/app/[(]auth[)]/a.spec.ts$:3:7"
        );
    }

    #[test]
    fn leaves_an_anchored_filter_as_it_is() {
        let given = args(&["/^\\/repo\\/a\\.spec\\.ts$/:3", "^/repo/b.spec.ts$"]);
        assert_eq!(anchored_filters("/repo", &given, false), given);
    }

    /// A spec's file name in a `file:` URL filter: each `.` as [`URL_ANY_CHAR`].
    fn url_name(name: &str) -> String {
        name.replace('.', URL_ANY_CHAR)
    }

    #[test]
    fn on_windows_the_file_url_is_an_alternative() {
        assert_eq!(
            one(r"C:\Users\Jo Ann\shop", "my tests/a.spec.ts:3", true),
            format!(
                "^(?:C:/Users/Jo Ann/shop/my tests/a.spec.ts\
                 |file:///C:/Users/Jo(?: |%20)Ann/shop/my(?: |%20)tests/{})$:3",
                url_name("a.spec.ts")
            )
        );
    }

    #[test]
    fn on_windows_a_non_ascii_character_is_its_bytes_and_a_class_either_way() {
        assert_eq!(
            one(r"C:\w\é", "tests/[{]x[}] ü.spec.ts", true),
            format!(
                "^(?:C:/w/é/tests/[{{]x[}}] ü.spec.ts\
                 |file:///C:/w/%C3%A9/tests/(?:[{{]|%7B)x(?:[}}]|%7D)(?: |%20)%C3%BC{})$",
                url_name(".spec.ts")
            )
        );
    }

    #[test]
    fn on_windows_a_share_is_a_url_of_its_host() {
        assert_eq!(
            one(r"\\host\share\shop", "a.spec.ts", true),
            format!(
                "^(?://host/share/shop/a.spec.ts|file://host/share/shop/{})$",
                url_name("a.spec.ts")
            )
        );
    }

    /// Whether the filter the shell makes of `filter` in `C:\r` takes the spec at `url`, as Playwright tests a filter's
    /// regular expression, its `:line` set apart. JavaScript reads the class `[[]` as the character `[`, which Rust's
    /// `regex` writes `[\[]`.
    fn takes_url(filter: &str, url: &str) -> bool {
        let anchored = one(r"C:\r", filter, true);
        let (pattern, _) = split_location(&anchored);
        regex::Regex::new(&pattern.replace("[[]", r"[\[]")).unwrap().is_match(url)
    }

    #[test]
    fn on_windows_the_file_url_matches_each_character_node_encodes() {
        // `specPattern`'s filter of each spec, and the URL `pathToFileURL(p, { windows: true })` writes for it in `C:\r`.
        let cases = [
            ("tests/[[]id].spec.ts:4", "file:///C:/r/tests/%5Bid%5D.spec.ts"),
            ("tests/#1.spec.ts", "file:///C:/r/tests/%231.spec.ts"),
            ("tests/100..spec.ts", "file:///C:/r/tests/100%25.spec.ts"),
            ("tests/a.b.c~d.spec.ts", "file:///C:/r/tests/a%5Eb%60c%7Ed.spec.ts"),
            ("tests/.q..spec.ts", "file:///C:/r/tests/%E2%80%9Cq%E2%80%9D.spec.ts"),
            ("my tests/[{]a[}] é.spec.ts", "file:///C:/r/my%20tests/%7Ba%7D%20%C3%A9.spec.ts"),
            ("tests/.x..spec.ts", "file:///C:/r/tests/$x!.spec.ts"),
        ];
        for (filter, url) in cases {
            assert!(takes_url(filter, url), "{filter} misses {url}");
        }
    }

    #[test]
    fn on_windows_the_file_url_takes_no_other_spec() {
        assert!(!takes_url("tests/#1.spec.ts", "file:///C:/r/e2e/tests/%231.spec.ts"));
        assert!(!takes_url("tests/#1.spec.ts", "file:///C:/r/tests/%231.spec.tsx"));
        assert!(!takes_url("tests/[[]id].spec.ts", "file:///C:/r/tests/%5Bid%5D%5D.spec.ts"));
        assert!(!takes_url("tests/100..spec.ts", "file:///C:/r/tests/100%25%25.spec.ts"));
    }

    #[test]
    fn splits_a_line_and_a_column() {
        assert_eq!(split_location("a.spec.ts:12:5"), ("a.spec.ts", ":12:5"));
        assert_eq!(split_location("a.spec.ts:12"), ("a.spec.ts", ":12"));
        assert_eq!(split_location("a.spec.ts"), ("a.spec.ts", ""));
        assert_eq!(split_location("v1:2/a.spec.ts"), ("v1:2/a.spec.ts", ""));
    }
}
