// The environment that makes the bundled server the hub of a Playwright run
// the shell starts: its run channel, which each worker of the run keeps a
// connection to, the run's name there, and where its tests' picks go. Pure, so
// it is tested on its own.

/// The name a run's workers give the bundled server on its run channel
/// (`PIWI_RUN_REF`): the shell's id for the run, which the window knows the run
/// by. `PIWI_ORIGIN_REF` keeps naming what the run was launched for.
pub(crate) fn run_ref(id: u32) -> String {
    format!("desktop-{id}")
}

/// Whether `value` reads as a run channel's address as the bundled server
/// names it, `<socket path>#<token>`: a path and a token of 16 to 256 letters,
/// digits, `_` and `-`, on one line.
fn is_run_channel(value: &str) -> bool {
    let Some((path, token)) = value.rsplit_once('#') else {
        return false;
    };
    !path.is_empty()
        && !value.contains(['\0', '\n', '\r'])
        && (16..=256).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Whether `value` reads as the address the bundled server takes a run's picks
/// at, as an editor's Send to editor pairing names its endpoint
/// (`http://127.0.0.1:<port>/<path>#<token>`): this machine's loopback, a port,
/// a path of letters, digits, `/`, `_` and `-`, and a token of 16 to 256
/// letters, digits, `_` and `-`.
fn is_picks_address(value: &str) -> bool {
    let Some((url, token)) = value.rsplit_once('#') else {
        return false;
    };
    let Some((port, path)) = url
        .strip_prefix("http://127.0.0.1:")
        .and_then(|rest| rest.split_once('/'))
    else {
        return false;
    };
    (1..=5).contains(&port.len())
        && port.bytes().all(|b| b.is_ascii_digit())
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'/' || b == b'_' || b == b'-')
        && (16..=256).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The environment that makes the bundled server the hub of run `id`: its run
/// channel (`PIWI_RUN_CHANNEL`), which each worker keeps a connection to, the
/// run's name there (`PIWI_RUN_REF`), and the address its tests' picks go to
/// (`PIWI_EDITOR_SEND`, the server's, which shows them in the window to copy),
/// when the server named one. None when the server named no channel, or
/// something that is not one: the run then goes as without a hub.
pub(crate) fn hub_env(
    channel: Option<&str>,
    picks: Option<&str>,
    id: u32,
) -> Vec<(&'static str, String)> {
    let Some(value) = channel.filter(|value| is_run_channel(value)) else {
        return Vec::new();
    };
    let mut env = vec![
        ("PIWI_RUN_CHANNEL", value.to_string()),
        ("PIWI_RUN_REF", run_ref(id)),
    ];
    if let Some(address) = picks.filter(|value| is_picks_address(value)) {
        env.push(("PIWI_EDITOR_SEND", address.to_string()));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "Ab3_-Ab3_-Ab3_-Ab3_-Ab3_-Ab3_-Ab";

    #[test]
    fn names_the_servers_channel_and_the_run_in_the_environment() {
        let channel = format!("/tmp/piwi-record-x1/channel.sock#{TOKEN}");
        assert_eq!(
            hub_env(Some(&channel), None, 7),
            vec![
                ("PIWI_RUN_CHANNEL", channel.clone()),
                ("PIWI_RUN_REF", "desktop-7".to_string()),
            ]
        );
        let pipe = format!(r"\\.\pipe\piwi-record-0a1b2c#{TOKEN}");
        assert_eq!(
            hub_env(Some(&pipe), None, 1)[0],
            ("PIWI_RUN_CHANNEL", pipe.clone())
        );
    }

    #[test]
    fn names_the_server_as_where_the_runs_picks_go() {
        let channel = format!("/tmp/piwi-record-x1/channel.sock#{TOKEN}");
        let picks = format!("http://127.0.0.1:4318/api/desktop/runs/picks#{TOKEN}");
        assert_eq!(
            hub_env(Some(&channel), Some(&picks), 2),
            vec![
                ("PIWI_RUN_CHANNEL", channel.clone()),
                ("PIWI_RUN_REF", "desktop-2".to_string()),
                ("PIWI_EDITOR_SEND", picks.clone()),
            ]
        );
        // Without a channel, no hub and no picks.
        assert!(hub_env(None, Some(&picks), 2).is_empty());
        for bad in [
            String::new(),
            format!("https://127.0.0.1:4318/api/desktop/runs/picks#{TOKEN}"),
            format!("http://localhost:4318/api/desktop/runs/picks#{TOKEN}"),
            format!("http://127.0.0.1.example.com:4318/picks#{TOKEN}"),
            format!("http://127.0.0.1:/picks#{TOKEN}"),
            format!("http://127.0.0.1:4318#{TOKEN}"),
            format!("http://127.0.0.1:4318/pi cks#{TOKEN}"),
            format!("http://127.0.0.1:4318/picks?to=elsewhere#{TOKEN}"),
            "http://127.0.0.1:4318/picks#short".to_string(),
            format!("http://127.0.0.1:4318/picks#{TOKEN}\n"),
        ] {
            assert_eq!(
                hub_env(Some(&channel), Some(&bad), 2).len(),
                2,
                "{bad:?} names no picks address"
            );
        }
    }

    #[test]
    fn names_a_run_as_the_hubs_commands_take_it() {
        // Letters, digits, `_` and `-`, 64 at most: what the hub and the reporter read.
        for id in [0, 1, u32::MAX] {
            let name = run_ref(id);
            assert!(name.len() <= 64);
            assert!(name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
        }
        assert_ne!(run_ref(1), run_ref(2));
    }

    #[test]
    fn names_no_hub_without_a_channel_or_with_something_else() {
        assert!(hub_env(None, None, 3).is_empty());
        for bad in [
            String::new(),
            "/tmp/channel.sock".to_string(),
            format!("#{TOKEN}"),
            "/tmp/channel.sock#short".to_string(),
            format!("/tmp/channel.sock#{TOKEN}!"),
            format!("/tmp/chan\nnel.sock#{TOKEN}"),
            format!("/tmp/chan\0nel.sock#{TOKEN}"),
            format!("/tmp/channel.sock#{}", "a".repeat(257)),
        ] {
            assert!(
                hub_env(Some(&bad), None, 3).is_empty(),
                "{bad:?} names no channel"
            );
        }
    }
}
