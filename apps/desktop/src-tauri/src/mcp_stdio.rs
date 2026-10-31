// MCP stdio bridge — this executable, run as `piwi-desktop mcp-stdio`.
//
// Claude Desktop loads only **stdio** servers from `claude_desktop_config.json`:
// an entry carrying a `url` is refused on startup ("the following entries in
// claude_desktop_config.json are not valid MCP server configurations and were
// ignored"). A remote endpoint therefore has to arrive behind a local command,
// and this module is that command — no Node, no `npx`, nothing to install.
//
// It pumps newline-delimited JSON-RPC: every line read from stdin is POSTed to
// the running app's `/mcp` endpoint and the reply is written back as one line on
// stdout. The address and token are read from the reporter discovery file
// (`~/.piwi/desktop.json`) on each message rather than baked into the client's
// config, so the entry survives a port change and no credential is ever copied
// into another app's file.
//
// The app must be running for the bridge to reach anything: the discovery file
// exists only while it serves. When it is absent the bridge answers requests
// with a JSON-RPC error saying so instead of hanging.

use std::io::{BufRead, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::{DISCOVERY_DIR, DISCOVERY_FILE};

/// The argument that puts this executable into bridge mode.
pub const STDIO_ARG: &str = "mcp-stdio";

/// How long one message keeps retrying while the app is unreachable. Long
/// enough to cover a dashboard that is still booting, short enough that a
/// client waiting on `initialize` gets a clear error instead of a hang.
const UNREACHABLE_DEADLINE: Duration = Duration::from_secs(8);
const RETRY_DELAY: Duration = Duration::from_millis(250);
/// Generous: a tool call can run an AI diagnosis on the other side.
const IO_TIMEOUT: Duration = Duration::from_secs(180);

/// JSON-RPC internal error — what a failure to reach the app is reported as.
const RPC_INTERNAL_ERROR: i32 = -32603;

/// True when this process was launched as the bridge rather than the app.
pub fn is_bridge_arg(arg: &str) -> bool {
    arg == STDIO_ARG || arg == "--mcp-stdio"
}

/// Where the app publishes its address and token.
fn discovery_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(DISCOVERY_DIR).join(DISCOVERY_FILE))
}

/// The user's home directory. Resolved from the environment because the bridge
/// runs outside Tauri (no `AppHandle`), and it is spawned by the MCP client, so
/// it inherits that client's user environment.
fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            return Some(PathBuf::from(profile));
        }
        let drive = std::env::var_os("HOMEDRIVE")?;
        let path = std::env::var_os("HOMEPATH")?;
        let mut home = PathBuf::from(drive);
        home.push(PathBuf::from(path));
        Some(home)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// Run the bridge until stdin closes (the client shutting the server down).
pub fn run_bridge() {
    let Some(discovery) = discovery_path() else {
        // Without a home directory there is no way to find the app at all.
        let _ = writeln!(
            std::io::stderr(),
            "piwi mcp bridge: could not resolve the home directory"
        );
        return;
    };
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    pump(&discovery, UNREACHABLE_DEADLINE, stdin.lock(), stdout.lock());
}

/// The live connection details, as published by the running app.
#[derive(Debug, PartialEq)]
struct Endpoint {
    host: String,
    port: u16,
    token: String,
}

/// A failed POST. `retryable` separates "the app is not there yet" (worth
/// waiting for) from "the app answered and said no" (not worth repeating).
/// `sent` says the whole message went out before the reply was lost: the app
/// may have acted on it.
struct PostError {
    message: String,
    retryable: bool,
    sent: bool,
}

/// Read one line of JSON-RPC, answer with at most one line back. `wait` is how
/// long a message keeps trying while the app is unreachable.
fn pump(discovery: &Path, wait: Duration, input: impl BufRead, mut out: impl Write) {
    for line in input.lines() {
        // A read error means the pipe is gone — the client has quit.
        let Ok(line) = line else { break };
        let message = line.trim();
        if message.is_empty() {
            continue;
        }
        if let Some(reply) = handle_message(discovery, wait, message) {
            if writeln!(out, "{reply}").is_err() || out.flush().is_err() {
                break;
            }
        }
    }
}

/// The reply to write back, if any. Notifications carry no id and get no
/// response — neither from the server nor from an error here.
fn handle_message(discovery: &Path, wait: Duration, message: &str) -> Option<String> {
    match forward(discovery, wait, message) {
        Ok(body) => {
            let body = body.trim();
            // The endpoint answers a notification with an empty body (or a bare
            // `null`); the stdio transport expects nothing on the wire for it.
            if body.is_empty() || body == "null" {
                None
            } else {
                Some(single_line(body))
            }
        }
        Err(detail) => error_reply(message, &detail),
    }
}

/// POST the message to the app, waiting out a dashboard that is not up yet.
fn forward(discovery: &Path, wait: Duration, message: &str) -> Result<String, String> {
    let deadline = Instant::now() + wait;
    // A tool call the app may have run is never sent again: a click on a
    // stopped page played twice is not the click the agent asked for.
    let replays = !is_tool_call(message);
    loop {
        let attempt = match read_endpoint(discovery) {
            Some(endpoint) => post(&endpoint, message),
            None => Err(PostError {
                message: "Piwi Dashboard is not running — start the app, then reconnect this server"
                    .into(),
                retryable: true,
                sent: false,
            }),
        };
        match attempt {
            Ok(body) => return Ok(body),
            Err(err) if err.retryable && err.sent && !replays => {
                return Err(format!(
                    "{} — the tool call may have run, so the bridge does not send it again",
                    err.message
                ));
            }
            Err(err) if err.retryable && Instant::now() + RETRY_DELAY < deadline => {
                std::thread::sleep(RETRY_DELAY);
            }
            Err(err) => return Err(err.message),
        }
    }
}

/// Whether the message is a JSON-RPC `tools/call`, which may act on a run.
fn is_tool_call(message: &str) -> bool {
    serde_json::from_str::<Value>(message)
        .ok()
        .and_then(|parsed| parsed.get("method").and_then(Value::as_str).map(|m| m == "tools/call"))
        .unwrap_or(false)
}

fn read_endpoint(discovery: &Path) -> Option<Endpoint> {
    let raw = std::fs::read_to_string(discovery).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let (host, port) = split_http_url(parsed.get("url")?.as_str()?)?;
    Some(Endpoint {
        host,
        port,
        token: parsed.get("token")?.as_str()?.to_string(),
    })
}

/// `http://127.0.0.1:3000` → `("127.0.0.1", 3000)`. The app only ever publishes
/// a plain-http loopback origin, so nothing more elaborate is accepted.
fn split_http_url(url: &str) -> Option<(String, u16)> {
    let authority = url.strip_prefix("http://")?.split('/').next()?;
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() => Some((host.to_string(), port.parse().ok()?)),
        Some(_) => None,
        None if !authority.is_empty() => Some((authority.to_string(), 80)),
        None => None,
    }
}

/// One request, one connection. HTTP/1.0 with `Connection: close` makes the
/// server end the body by closing the socket, so reading to EOF is the whole
/// response — no keep-alive or chunked framing to decode by hand.
fn post(endpoint: &Endpoint, body: &str) -> Result<String, PostError> {
    let unreachable = |e: std::io::Error| PostError {
        message: format!(
            "cannot reach Piwi Dashboard at http://{}:{} ({e})",
            endpoint.host, endpoint.port
        ),
        retryable: true,
        sent: false,
    };
    let mut stream =
        TcpStream::connect((endpoint.host.as_str(), endpoint.port)).map_err(unreachable)?;
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));

    let head = format!(
        "POST /mcp HTTP/1.0\r\n\
         Host: {host}:{port}\r\n\
         Authorization: Bearer {token}\r\n\
         Content-Type: application/json\r\n\
         Accept: application/json\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\r\n",
        host = endpoint.host,
        port = endpoint.port,
        token = endpoint.token,
        len = body.len(),
    );
    stream.write_all(head.as_bytes()).map_err(unreachable)?;
    stream.write_all(body.as_bytes()).map_err(unreachable)?;
    stream.flush().map_err(unreachable)?;

    // From here the app has the whole message: a reply lost now may follow an
    // action already taken.
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| PostError {
        sent: true,
        ..unreachable(e)
    })?;
    split_response(&raw)
}

/// Pull the JSON body out of a raw HTTP response, or describe the failure.
fn split_response(raw: &[u8]) -> Result<String, PostError> {
    let text = String::from_utf8_lossy(raw);
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return Err(PostError {
            message: "Piwi Dashboard sent a malformed HTTP response".into(),
            // An empty or truncated response means the connection died mid-flight.
            retryable: true,
            sent: true,
        });
    };
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok());
    match status {
        Some(code) if (200..300).contains(&code) => Ok(body.to_string()),
        Some(401) | Some(403) => Err(PostError {
            message: "Piwi Dashboard rejected the bridge's access token — reconnect Claude Desktop from the app's MCP page".into(),
            retryable: false,
            sent: true,
        }),
        Some(code) => Err(PostError {
            message: format!("Piwi Dashboard replied {code}"),
            retryable: false,
            sent: true,
        }),
        None => Err(PostError {
            message: "Piwi Dashboard sent a malformed HTTP response".into(),
            retryable: true,
            sent: true,
        }),
    }
}

/// Collapse a body onto one line: the transport frames messages by newline, and
/// raw newlines in JSON are only ever whitespace between tokens (a newline
/// inside a string is escaped), so dropping them cannot corrupt the payload.
fn single_line(body: &str) -> String {
    body.replace(['\r', '\n'], "")
}

/// Turn a failure into a JSON-RPC error carrying the request's own id. Anything
/// without an id is a notification (or unparsable) and gets no reply at all.
fn error_reply(message: &str, detail: &str) -> Option<String> {
    let id = serde_json::from_str::<Value>(message)
        .ok()?
        .get("id")?
        .clone();
    if id.is_null() {
        return None;
    }
    Some(
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": RPC_INTERNAL_ERROR, "message": detail },
        })
        .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::BufReader;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A discovery file under the OS temp dir, removed when the test ends.
    struct DiscoveryFile(PathBuf);

    impl DiscoveryFile {
        fn new(contents: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "piwi-bridge-{}-{unique}.json",
                std::process::id()
            ));
            std::fs::write(&path, contents).expect("write discovery file");
            Self(path)
        }

        /// A path where no discovery file exists (the app is not running).
        fn missing() -> PathBuf {
            std::env::temp_dir().join("piwi-bridge-no-such-file.json")
        }
    }

    impl Drop for DiscoveryFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// A one-shot HTTP server: hands back `response` and reports the raw request
    /// it received. Enough to drive the bridge over a real socket.
    fn stub_server(response: &'static str) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub server");
        let port = listener.local_addr().expect("stub addr").port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            // The client half-closes only at the end, so read exactly the
            // announced body rather than to EOF.
            let mut buf = Vec::new();
            let mut byte = [0u8; 1];
            loop {
                match stream.read(&mut byte) {
                    Ok(0) => break,
                    Ok(_) => buf.push(byte[0]),
                    Err(_) => break,
                }
                let text = String::from_utf8_lossy(&buf);
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let len: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("Content-Length: "))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    if body.len() >= len {
                        break;
                    }
                }
            }
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
            drop(stream);
            String::from_utf8_lossy(&buf).to_string()
        });
        (port, handle)
    }

    fn discovery_for(port: u16) -> DiscoveryFile {
        DiscoveryFile::new(&format!(
            r#"{{"url":"http://127.0.0.1:{port}","token":"pd_test"}}"#
        ))
    }

    /// Drive the bridge over one input, with a wait short enough that the
    /// unreachable-app cases still exercise a retry without stalling the suite.
    fn run_pump(discovery: &Path, input: &str) -> String {
        let mut out = Vec::new();
        pump(
            discovery,
            Duration::from_millis(400),
            BufReader::new(input.as_bytes()),
            &mut out,
        );
        String::from_utf8(out).expect("utf8 output")
    }

    #[test]
    fn bridge_arg_matches_both_spellings() {
        assert!(is_bridge_arg("mcp-stdio"));
        assert!(is_bridge_arg("--mcp-stdio"));
        assert!(!is_bridge_arg("--hidden"));
    }

    #[test]
    fn urls_split_into_host_and_port() {
        assert_eq!(
            split_http_url("http://127.0.0.1:3000"),
            Some(("127.0.0.1".to_string(), 3000))
        );
        assert_eq!(
            split_http_url("http://127.0.0.1:51234/"),
            Some(("127.0.0.1".to_string(), 51234))
        );
        assert_eq!(
            split_http_url("http://localhost"),
            Some(("localhost".to_string(), 80))
        );
        assert_eq!(split_http_url("https://example.com"), None);
        assert_eq!(split_http_url("http://127.0.0.1:port"), None);
    }

    #[test]
    fn endpoint_comes_from_the_discovery_file() {
        let file = DiscoveryFile::new(r#"{"url":"http://127.0.0.1:4321","token":"pd_abc"}"#);
        assert_eq!(
            read_endpoint(&file.0),
            Some(Endpoint {
                host: "127.0.0.1".into(),
                port: 4321,
                token: "pd_abc".into(),
            })
        );
        assert_eq!(read_endpoint(&DiscoveryFile::missing()), None);
        let broken = DiscoveryFile::new("not json");
        assert_eq!(read_endpoint(&broken.0), None);
    }

    #[test]
    fn a_request_is_proxied_with_the_bearer_token_and_answered_on_one_line() {
        let (port, server) = stub_server(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[]}}",
        );
        let discovery = discovery_for(port);

        let out = run_pump(&discovery.0, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n");

        let request = server.join().expect("stub server");
        assert!(request.starts_with("POST /mcp HTTP/1.0\r\n"), "{request}");
        assert!(request.contains("Authorization: Bearer pd_test\r\n"), "{request}");
        assert!(request.ends_with("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"), "{request}");
        assert_eq!(out, "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[]}}\n");
    }

    #[test]
    fn a_pretty_printed_reply_is_flattened_onto_one_line() {
        let (port, server) = stub_server("HTTP/1.1 200 OK\r\n\r\n{\n  \"id\": 1\n}");
        let discovery = discovery_for(port);

        let out = run_pump(&discovery.0, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n");

        let _ = server.join();
        assert_eq!(out, "{  \"id\": 1}\n");
    }

    #[test]
    fn a_notification_is_forwarded_but_never_answered() {
        let (port, server) = stub_server("HTTP/1.1 200 OK\r\n\r\n");
        let discovery = discovery_for(port);

        let out = run_pump(
            &discovery.0,
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
        );

        let request = server.join().expect("stub server");
        assert!(request.contains("notifications/initialized"));
        assert_eq!(out, "");
    }

    #[test]
    fn a_bare_null_body_is_not_written_back() {
        let (port, server) = stub_server("HTTP/1.1 200 OK\r\n\r\nnull");
        let discovery = discovery_for(port);

        let out = run_pump(
            &discovery.0,
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\"}\n",
        );

        let _ = server.join();
        assert_eq!(out, "");
    }

    #[test]
    fn a_request_gets_a_json_rpc_error_when_the_app_is_not_running() {
        let out = run_pump(
            &DiscoveryFile::missing(),
            "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"initialize\"}\n",
        );

        let reply: Value = serde_json::from_str(out.trim()).expect("json reply");
        assert_eq!(reply["id"], 7);
        assert_eq!(reply["error"]["code"], RPC_INTERNAL_ERROR);
        assert!(
            reply["error"]["message"]
                .as_str()
                .expect("message")
                .contains("not running"),
            "{reply}"
        );
    }

    #[test]
    fn a_rejected_token_is_reported_without_retrying() {
        let (port, server) = stub_server("HTTP/1.1 401 Unauthorized\r\n\r\n{\"error\":\"nope\"}");
        let discovery = discovery_for(port);

        // The stub answers once: a retry would hang on a closed listener, so
        // getting a reply at all proves the refusal was taken as final.
        let out = run_pump(&discovery.0, "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n");

        let _ = server.join();
        let reply: Value = serde_json::from_str(out.trim()).expect("json reply");
        assert_eq!(reply["id"], 2);
        assert!(
            reply["error"]["message"]
                .as_str()
                .expect("message")
                .contains("access token"),
            "{reply}"
        );
    }

    #[test]
    fn a_tool_call_whose_reply_is_lost_is_not_sent_again() {
        // The stub reads the call, then closes with no reply: the app may have
        // run it. A retry would meet a closed listener and say it cannot reach
        // the app; the reply proves the call went out once.
        let (port, server) = stub_server("");
        let discovery = discovery_for(port);

        let out = run_pump(
            &discovery.0,
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"page_act\"}}\n",
        );

        let request = server.join().expect("stub server");
        assert!(request.contains("page_act"));
        let reply: Value = serde_json::from_str(out.trim()).expect("json reply");
        assert_eq!(reply["id"], 4);
        let message = reply["error"]["message"].as_str().expect("message");
        assert!(message.contains("may have run"), "{reply}");
        assert!(!message.contains("cannot reach"), "{reply}");
    }

    #[test]
    fn only_a_tool_call_is_told_apart() {
        assert!(is_tool_call("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\"}"));
        assert!(!is_tool_call("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"));
        assert!(!is_tool_call("not json"));
    }

    #[test]
    fn blank_lines_and_unparsable_input_never_produce_a_reply() {
        assert_eq!(run_pump(&DiscoveryFile::missing(), "\n  \n"), "");
        assert_eq!(run_pump(&DiscoveryFile::missing(), "not json\n"), "");
        // A notification cannot be answered even when forwarding failed.
        assert_eq!(
            run_pump(&DiscoveryFile::missing(), "{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}\n"),
            ""
        );
    }

    #[test]
    fn responses_are_classified_by_status() {
        assert_eq!(
            split_response(b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}")
                .map_err(|e| e.message)
                .expect("ok body"),
            "{\"ok\":true}"
        );
        let err = split_response(b"HTTP/1.1 500 Internal Server Error\r\n\r\nboom")
            .err()
            .expect("error");
        assert!(err.message.contains("500"));
        assert!(!err.retryable);
        let truncated = split_response(b"").err().expect("error");
        assert!(truncated.retryable);
        // The app had the whole message: it may have acted on it.
        assert!(truncated.sent);
    }
}
