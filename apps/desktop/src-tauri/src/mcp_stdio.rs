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
// into another app's file. The token goes out only to `127.0.0.1`, over a
// connection from `connect_proving_token`: once the server on the port has
// proved it holds the token.
//
// The app must be running for the bridge to reach anything: the discovery file
// exists only while it serves. When it is absent the bridge answers requests
// with a JSON-RPC error saying so instead of hanging.
//
// A client of any MCP revision passes through: a `2026-07-28` request, which
// names its version in `_meta`, goes out with the headers that mirror its body
// (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`), and the JSON-RPC error a
// refusal of it carries (`UnsupportedProtocolVersion`, `HeaderMismatch`)
// reaches the client as the server wrote it. A `subscriptions/listen` is
// acknowledged here, since `/mcp` sends no change notification and its stream
// would hold the bridge's one connection.

use std::fmt::Display;
use std::io::{BufRead, Read, Write};
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

/// The `_meta` key a `2026-07-28` request names its protocol version in.
const PROTOCOL_VERSION_META: &str = "io.modelcontextprotocol/protocolVersion";
/// The `_meta` key every message of a subscription carries its id in.
const SUBSCRIPTION_ID_META: &str = "io.modelcontextprotocol/subscriptionId";

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
    let parsed = serde_json::from_str::<Value>(message).ok();
    if let Some(acknowledged) = parsed.as_ref().and_then(listen_acknowledgment) {
        return Some(acknowledged);
    }
    let notification = parsed
        .as_ref()
        .is_some_and(|value| value.is_object() && matches!(value.get("id"), None | Some(Value::Null)));
    match forward(discovery, wait, message) {
        Ok(_) if notification => None,
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
                message: "Piwi Desktop is not running — start it from the Start menu, the Dock or the app list, then reconnect this server"
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

/// The acknowledgment of a `2026-07-28` `subscriptions/listen` request, which the bridge answers itself: `/mcp` sends
/// no change notification, so the subscription honors none and stays open until the client cancels it or quits. None
/// for any other message.
fn listen_acknowledgment(message: &Value) -> Option<String> {
    if message.get("method").and_then(Value::as_str) != Some("subscriptions/listen") {
        return None;
    }
    message.pointer(&meta_pointer(PROTOCOL_VERSION_META))?.as_str()?;
    let id = message.get("id").filter(|id| id.is_string() || id.is_number())?;
    Some(
        json!({
            "jsonrpc": "2.0",
            "method": "notifications/subscriptions/acknowledged",
            "params": { "_meta": { SUBSCRIPTION_ID_META: id }, "notifications": {} },
        })
        .to_string(),
    )
}

/// The JSON pointer of a `_meta` key of a request's params (a `/` in the key escaped as `~1`).
fn meta_pointer(key: &str) -> String {
    format!("/params/_meta/{}", key.replace('~', "~0").replace('/', "~1"))
}

/// The header lines a `2026-07-28` request mirrors from its body, each ending in CRLF: `MCP-Protocol-Version` from its
/// `_meta`, `Mcp-Method`, and `Mcp-Name` for a call that names a tool, a prompt or a resource. Empty for a request of an
/// earlier revision, which names no version in `_meta`, and for a batch. A version or method a header cannot carry
/// as it is goes out without its header, which the server refuses.
fn mirrored_headers(body: &str) -> String {
    let Ok(message) = serde_json::from_str::<Value>(body) else {
        return String::new();
    };
    let Some(version) = message
        .pointer(&meta_pointer(PROTOCOL_VERSION_META))
        .and_then(Value::as_str)
    else {
        return String::new();
    };
    let method = message.get("method").and_then(Value::as_str);
    let mut headers = String::new();
    if is_plain_header_value(version) {
        headers.push_str(&format!("MCP-Protocol-Version: {version}\r\n"));
    }
    if let Some(method) = method.filter(|method| is_plain_header_value(method)) {
        headers.push_str(&format!("Mcp-Method: {method}\r\n"));
    }
    let named = match method {
        Some("tools/call") | Some("prompts/get") => message.pointer("/params/name"),
        Some("resources/read") => message.pointer("/params/uri"),
        _ => None,
    };
    if let Some(name) = named.and_then(Value::as_str) {
        headers.push_str(&format!("Mcp-Name: {}\r\n", header_value(name)));
    }
    headers
}

/// Whether a value goes in a header as it is: visible ASCII and spaces, no space at either end, and not the form of an
/// encoded value.
fn is_plain_header_value(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
        && value.trim() == value
        && !(value.starts_with("=?base64?") && value.ends_with("?="))
}

/// A value as a header carries it: as it is when it can be, else its UTF-8 in base64 between `=?base64?` and `?=`.
fn header_value(value: &str) -> String {
    if is_plain_header_value(value) {
        value.to_string()
    } else {
        format!("=?base64?{}?=", base64(value.as_bytes()))
    }
}

/// Standard base64, padded.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, byte)| acc | (u32::from(*byte) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((triple >> (18 - 6 * i)) & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
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

/// The only host the bridge sends the token to: the address the app publishes and
/// [`crate::connect_proving_token`] dials.
const LOOPBACK_HOST: &str = "127.0.0.1";

/// A failure to reach the app, before the message went out.
fn unreachable(endpoint: &Endpoint, detail: impl Display) -> PostError {
    PostError {
        message: format!(
            "cannot reach Piwi Desktop at http://{}:{} ({detail})",
            endpoint.host, endpoint.port
        ),
        retryable: true,
        sent: false,
    }
}

/// One request, one connection. HTTP/1.0 with `Connection: close` makes the
/// server end the body by closing the socket, so reading to EOF is the whole
/// response — no keep-alive or chunked framing to decode by hand.
///
/// The request goes on the connection [`crate::connect_proving_token`] proved: the token
/// goes out only on the stream whose server proved it holds it. A failed proof is
/// retryable and nothing was sent.
fn post(endpoint: &Endpoint, body: &str) -> Result<String, PostError> {
    if endpoint.host != LOOPBACK_HOST {
        return Err(PostError {
            message: format!(
                "the discovery file names {}, and the bridge sends the access token to {LOOPBACK_HOST} only",
                endpoint.host
            ),
            retryable: false,
            sent: false,
        });
    }
    let mut stream = crate::connect_proving_token(endpoint.port, &endpoint.token)
        .map_err(|e| unreachable(endpoint, e))?;
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));

    let head = format!(
        "POST /mcp HTTP/1.0\r\n\
         Host: {host}:{port}\r\n\
         Authorization: Bearer {token}\r\n\
         Content-Type: application/json\r\n\
         Accept: application/json\r\n\
         {mirrored}\
         Content-Length: {len}\r\n\
         Connection: close\r\n\r\n",
        host = endpoint.host,
        port = endpoint.port,
        token = endpoint.token,
        mirrored = mirrored_headers(body),
        len = body.len(),
    );
    stream.write_all(head.as_bytes()).map_err(|e| unreachable(endpoint, e))?;
    stream.write_all(body.as_bytes()).map_err(|e| unreachable(endpoint, e))?;
    stream.flush().map_err(|e| unreachable(endpoint, e))?;

    // From here the app has the whole message: a reply lost now may follow an
    // action already taken.
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| PostError {
        sent: true,
        ..unreachable(endpoint, e)
    })?;
    split_response(&raw)
}

/// Pull the JSON body out of a raw HTTP response, or describe the failure.
fn split_response(raw: &[u8]) -> Result<String, PostError> {
    let text = String::from_utf8_lossy(raw);
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return Err(PostError {
            message: "Piwi Desktop sent a malformed HTTP response".into(),
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
            message: "Piwi Desktop rejected the bridge's access token — reconnect Claude Desktop from the app's MCP page".into(),
            retryable: false,
            sent: true,
        }),
        // A refusal that carries a JSON-RPC error (an unsupported protocol version, headers that do not match) is the
        // server's answer to the client, which recovers from it.
        Some(code) if (400..500).contains(&code) && is_rpc_error(body) => Ok(body.to_string()),
        Some(code) => Err(PostError {
            message: format!("Piwi Desktop replied {code}"),
            retryable: false,
            sent: true,
        }),
        None => Err(PostError {
            message: "Piwi Desktop sent a malformed HTTP response".into(),
            retryable: true,
            sent: true,
        }),
    }
}

/// Whether a body is a JSON-RPC error response.
fn is_rpc_error(body: &str) -> bool {
    serde_json::from_str::<Value>(body).is_ok_and(|value| {
        value.get("jsonrpc").and_then(Value::as_str) == Some("2.0") && value.get("error").is_some_and(Value::is_object)
    })
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
    use std::net::{TcpListener, TcpStream};
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

    /// The access token the stub servers hold and the discovery files carry.
    const TOKEN: &str = "pd_test";

    /// Read one request: the head, then the announced body.
    fn read_request(stream: &mut TcpStream) -> String {
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
        String::from_utf8_lossy(&buf).to_string()
    }

    /// Answer one `/api/health` probe, with the proof of `TOKEN` or with none. Returns the probe.
    fn answer_probe(stream: &mut TcpStream, port: u16, proves: bool) -> String {
        let probe = read_request(stream);
        let proof = probe
            .lines()
            .find_map(|line| line.strip_prefix("x-piwi-desktop-challenge: "))
            .filter(|_| proves)
            .map(|challenge| {
                format!(
                    "x-piwi-desktop-proof: {}\r\n",
                    crate::proof_of(TOKEN, port, challenge)
                )
            })
            .unwrap_or_default();
        let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n{proof}\r\n{{}}").as_bytes());
        probe
    }

    /// A one-shot HTTP server that holds `TOKEN`: it proves it on the readiness probe, then hands
    /// back `response` on the same connection and reports the raw request it received after that. Enough to drive the
    /// bridge over a real socket.
    fn stub_server(response: &'static str) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub server");
        let port = listener.local_addr().expect("stub addr").port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            answer_probe(&mut stream, port, true);
            let request = read_request(&mut stream);
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
            drop(stream);
            request
        });
        (port, handle)
    }

    /// A server that restarts: it answers the first probe without the proof (another process on the
    /// port), the second with it, then serves one request. The handle yields the first probe and
    /// the request.
    fn restarting_server(
        response: &'static str,
    ) -> (u16, std::thread::JoinHandle<(String, String)>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub server");
        let port = listener.local_addr().expect("stub addr").port();
        let handle = std::thread::spawn(move || {
            let (mut first, _) = listener.accept().expect("accept the first probe");
            let squatted = answer_probe(&mut first, port, false);
            drop(first);
            let (mut stream, _) = listener.accept().expect("accept the second probe");
            answer_probe(&mut stream, port, true);
            let request = read_request(&mut stream);
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
            drop(stream);
            (squatted, request)
        });
        (port, handle)
    }

    fn discovery_for(port: u16) -> DiscoveryFile {
        DiscoveryFile::new(&format!(
            r#"{{"url":"http://127.0.0.1:{port}","token":"{TOKEN}"}}"#
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
        assert!(request.contains(&format!("Authorization: Bearer {TOKEN}\r\n")), "{request}");
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
    fn a_server_that_cannot_prove_the_token_is_never_sent_it() {
        let (port, squatter) = crate::tests::serve_as_squatter();
        let discovery = discovery_for(port);

        let out = run_pump(&discovery.0, "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"ping\"}\n");

        let seen = squatter.join().expect("squatter");
        assert!(seen.starts_with("GET /api/health "), "{seen}");
        assert!(!seen.to_ascii_lowercase().contains("authorization"), "{seen}");
        assert!(!seen.contains(TOKEN), "{seen}");
        let reply: Value = serde_json::from_str(out.trim()).expect("json reply");
        assert_eq!(reply["id"], 5);
        let message = reply["error"]["message"].as_str().expect("message");
        assert!(message.contains("cannot reach"), "{reply}");
    }

    #[test]
    fn a_failed_proof_is_retried_and_the_token_goes_to_the_server_that_proves_it() {
        let (port, server) = restarting_server("HTTP/1.1 200 OK\r\n\r\n{\"id\":6,\"result\":{}}");
        let discovery = discovery_for(port);

        let mut out = Vec::new();
        pump(
            &discovery.0,
            Duration::from_secs(5),
            BufReader::new("{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"ping\"}\n".as_bytes()),
            &mut out,
        );

        let (squatted, request) = server.join().expect("server");
        assert!(!squatted.to_ascii_lowercase().contains("authorization"), "{squatted}");
        assert!(request.contains(&format!("Authorization: Bearer {TOKEN}\r\n")), "{request}");
        assert_eq!(String::from_utf8(out).expect("utf8"), "{\"id\":6,\"result\":{}}\n");
    }

    #[test]
    fn a_tool_call_is_not_sent_to_a_server_that_has_not_proved_the_token() {
        // Nothing went out, so the call is retried like any other message.
        let (port, server) = restarting_server("HTTP/1.1 200 OK\r\n\r\n{\"id\":8,\"result\":{}}");
        let discovery = discovery_for(port);

        let mut out = Vec::new();
        pump(
            &discovery.0,
            Duration::from_secs(5),
            BufReader::new(
                "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"tools/call\",\"params\":{\"name\":\"page_act\"}}\n"
                    .as_bytes(),
            ),
            &mut out,
        );

        let (squatted, request) = server.join().expect("server");
        assert!(!squatted.contains("page_act"), "{squatted}");
        assert!(request.contains("page_act"), "{request}");
        assert_eq!(String::from_utf8(out).expect("utf8"), "{\"id\":8,\"result\":{}}\n");
    }

    #[test]
    fn a_host_other_than_loopback_is_refused_without_connecting() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.set_nonblocking(true).expect("non-blocking");
        let port = listener.local_addr().expect("addr").port();
        for host in ["localhost", "192.0.2.7", "[::1]"] {
            let discovery = DiscoveryFile::new(&format!(
                r#"{{"url":"http://{host}:{port}","token":"{TOKEN}"}}"#
            ));

            let out = run_pump(&discovery.0, "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"ping\"}\n");

            let reply: Value = serde_json::from_str(out.trim()).expect("json reply");
            let message = reply["error"]["message"].as_str().expect("message");
            assert!(message.contains(host) && message.contains("127.0.0.1"), "{reply}");
            assert!(listener.accept().is_err(), "{host} was dialed");
        }
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

    /// A `2026-07-28` request, its version and the client's capabilities in `_meta`.
    fn modern(id: u32, method: &str, params: &str) -> String {
        let meta = r#""_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}"#;
        let params = if params.is_empty() {
            format!("{{{meta}}}")
        } else {
            format!("{{{params},{meta}}}")
        };
        format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}","params":{params}}}"#)
    }

    #[test]
    fn base64_is_the_standard_padded_alphabet() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64("Hello, 世界".as_bytes()), "SGVsbG8sIOS4lueVjA==");
    }

    #[test]
    fn a_modern_request_mirrors_its_version_method_and_name_in_headers() {
        assert_eq!(
            mirrored_headers(&modern(1, "tools/call", r#""name":"run_list","arguments":{}"#)),
            "MCP-Protocol-Version: 2026-07-28\r\nMcp-Method: tools/call\r\nMcp-Name: run_list\r\n"
        );
        assert_eq!(
            mirrored_headers(&modern(2, "resources/read", r#""uri":"file:///a.json""#)),
            "MCP-Protocol-Version: 2026-07-28\r\nMcp-Method: resources/read\r\nMcp-Name: file:///a.json\r\n"
        );
        assert_eq!(
            mirrored_headers(&modern(3, "tools/list", "")),
            "MCP-Protocol-Version: 2026-07-28\r\nMcp-Method: tools/list\r\n"
        );
        // A name a header cannot carry as it is goes in base64, never as a raw line break.
        for (name, encoded) in [
            ("Hello, 世界", "=?base64?SGVsbG8sIOS4lueVjA==?="),
            ("line1\nline2", "=?base64?bGluZTEKbGluZTI=?="),
            (" padded ", "=?base64?IHBhZGRlZCA=?="),
            ("=?base64?literal?=", "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="),
        ] {
            let body = modern(4, "prompts/get", &format!(r#""name":{}"#, json!(name)));
            assert!(
                mirrored_headers(&body).ends_with(&format!("Mcp-Name: {encoded}\r\n")),
                "{name}"
            );
        }
    }

    #[test]
    fn an_earlier_revision_and_a_batch_mirror_nothing() {
        assert_eq!(
            mirrored_headers(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#),
            ""
        );
        assert_eq!(mirrored_headers(&format!("[{}]", modern(1, "tools/list", ""))), "");
        assert_eq!(mirrored_headers("not json"), "");
        // A method that would break the request's head goes out without its header.
        let injected = modern(1, "tools/list", "").replace("tools/list", "tools/list\\r\\nX-Evil: 1");
        assert!(!mirrored_headers(&injected).contains("X-Evil"));
    }

    #[test]
    fn a_json_rpc_refusal_reaches_the_client_and_any_other_status_is_an_error() {
        let refusal = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32022,"message":"Unsupported protocol version"}}"#;
        let raw = format!("HTTP/1.1 400 Bad Request\r\n\r\n{refusal}");
        assert_eq!(split_response(raw.as_bytes()).ok().as_deref(), Some(refusal));
        let not_found = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}"#;
        assert!(split_response(format!("HTTP/1.1 404 Not Found\r\n\r\n{not_found}").as_bytes()).is_ok());
        assert!(split_response(b"HTTP/1.1 400 Bad Request\r\n\r\n<html>").is_err());
        assert!(split_response(b"HTTP/1.1 502 Bad Gateway\r\n\r\n{\"jsonrpc\":\"2.0\",\"error\":{}}").is_err());
    }

    #[test]
    fn a_modern_request_goes_out_with_its_headers_and_its_refusal_comes_back() {
        let (port, server) = stub_server(
            "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{\"jsonrpc\":\"2.0\",\"id\":5,\"error\":{\"code\":-32020,\"message\":\"Header mismatch\"}}",
        );
        let discovery = discovery_for(port);

        let out = run_pump(
            &discovery.0,
            &format!("{}\n", modern(5, "tools/call", r#""name":"run_list""#)),
        );

        let request = server.join().expect("stub server");
        assert!(request.contains("MCP-Protocol-Version: 2026-07-28\r\n"), "{request}");
        assert!(request.contains("Mcp-Method: tools/call\r\n"), "{request}");
        assert!(request.contains("Mcp-Name: run_list\r\n"), "{request}");
        let reply: Value = serde_json::from_str(out.trim()).expect("json reply");
        assert_eq!(reply["id"], 5);
        assert_eq!(reply["error"]["code"], -32020);
    }

    #[test]
    fn a_refused_notification_is_still_never_answered() {
        let (port, server) = stub_server(
            "HTTP/1.1 400 Bad Request\r\n\r\n{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32022,\"message\":\"Unsupported protocol version\"}}",
        );
        let discovery = discovery_for(port);

        let out = run_pump(
            &discovery.0,
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
        );

        let _ = server.join();
        assert_eq!(out, "");
    }

    #[test]
    fn a_modern_subscription_is_acknowledged_without_reaching_the_app() {
        let out = run_pump(
            &DiscoveryFile::missing(),
            &format!(
                "{}\n",
                modern(
                    9,
                    "subscriptions/listen",
                    r#""notifications":{"toolsListChanged":true}"#
                )
            ),
        );

        let reply: Value = serde_json::from_str(out.trim()).expect("json reply");
        assert_eq!(
            reply,
            json!({
                "jsonrpc": "2.0",
                "method": "notifications/subscriptions/acknowledged",
                "params": { "_meta": { "io.modelcontextprotocol/subscriptionId": 9 }, "notifications": {} },
            })
        );
        // An earlier revision has no subscriptions/listen: it is forwarded, here to an app that is not running.
        let legacy = run_pump(
            &DiscoveryFile::missing(),
            "{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"subscriptions/listen\"}\n",
        );
        assert!(legacy.contains("not running"), "{legacy}");
    }
}
