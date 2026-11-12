// The dashboard window's session with the sidecar.
//
// The window holds the sidecar's cookie, so it stays on a sidecar page only while the process behind the port
// is the one that proved it holds the token. When the sidecar exits, every window on its origin leaves it: the
// dashboard window goes to the bundled splash and the others close. The session loads again, with a fresh
// bootstrap, only after the restarted process proves the token. A proof that never comes leaves the window on
// the splash with its status set.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::mcp_clients::ServerInfo;
use crate::{bootstrap_url, health_ok, main_window_may_navigate, show_splash_status, LinkedPage, ServerGaveUp};

/// What the dashboard window shows and when, for the sidecar behind it. Managed by the app.
pub(crate) struct Session {
    splash: Option<tauri::Url>,
    opened: AtomicBool,
    live: AtomicBool,
    restarts: AtomicU64,
    /// Held while `restarts` and `live` change together: a proof's check and the store of `live` that follows it
    /// (`begin_session`), and the bump and clear of an exit or a give-up. A clear can never fall between a check
    /// and the store it guards.
    turn: Mutex<()>,
    status: Mutex<Option<&'static str>>,
}

impl Session {
    /// `window_url` is where the dashboard window starts: its bundled splash.
    pub(crate) fn new(window_url: Option<tauri::Url>, dev_url: Option<&tauri::Url>) -> Self {
        Self {
            splash: window_url.filter(|url| is_splash_page(url, dev_url)),
            opened: AtomicBool::new(false),
            live: AtomicBool::new(false),
            restarts: AtomicU64::new(0),
            turn: Mutex::new(()),
            status: Mutex::new(None),
        }
    }

    /// The window loads the sidecar's session from here on.
    pub(crate) fn mark_opened(&self) {
        self.opened.store(true, Ordering::SeqCst);
    }

    /// Whether the window may be on the sidecar's origin: set only once a proof held for the load of its session,
    /// cleared when the sidecar exits or the supervisor gives up.
    pub(crate) fn is_live(&self) -> bool {
        self.live.load(Ordering::SeqCst)
    }

    /// The port a navigation of the dashboard window may reach the sidecar on: none while the session is not live.
    pub(crate) fn sidecar_port(&self, port: Option<u16>) -> Option<u16> {
        port.filter(|_| self.is_live())
    }

    /// The status line the splash shows; written again whenever the splash loads.
    pub(crate) fn set_status(&self, text: Option<&'static str>) {
        *self.status.lock().unwrap_or_else(PoisonError::into_inner) = text;
    }

    pub(crate) fn status(&self) -> Option<&'static str> {
        *self.status.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The number of sidecar exits so far: a proof belongs to the generation read once the session counts the exits.
    pub(crate) fn generation(&self) -> u64 {
        self.restarts.load(Ordering::SeqCst)
    }

    /// The turn, taken even after a panic under it poisoned the lock: it guards no data, only the order of a check and
    /// a store, and a supervisor that panicked on it would never restart the sidecar.
    fn lock_turn(&self) -> MutexGuard<'_, ()> {
        self.turn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The sidecar exited: the session is no longer live. Returns the number of this exit.
    fn exited(&self) -> u64 {
        let _turn = self.lock_turn();
        self.live.store(false, Ordering::SeqCst);
        self.restarts.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// The supervisor gave up: the session is no longer live, and a proof read before this stands no more. Returns
    /// whether a session was opened.
    fn gave_up(&self) -> bool {
        let _turn = self.lock_turn();
        self.live.store(false, Ordering::SeqCst);
        self.restarts.fetch_add(1, Ordering::SeqCst);
        self.opened.load(Ordering::SeqCst)
    }

    /// Mark the session live if `holds` says the proof stands, in one turn with the exits and the give-up: one that
    /// lands first makes the proof stale, one that lands after clears the flag. `holds` must not wait on the session.
    fn go_live_if(&self, holds: &ProofHolds) -> bool {
        let _turn = self.lock_turn();
        let stands = holds();
        if stands {
            self.set_status(None);
            self.live.store(true, Ordering::SeqCst);
        }
        stands
    }

    /// Whether no sidecar exit came after `generation` was read.
    fn unchanged_since(&self, generation: u64) -> bool {
        self.generation() == generation
    }
}

/// Whether a proof still stands, asked on the thread that navigates the window (it must not wait on the session):
/// false once the sidecar exited after the proof's generation was read, the supervisor gave up, or the app is
/// quitting.
pub(crate) type ProofHolds = Arc<dyn Fn() -> bool + Send + Sync>;

/// Begin the session `then` loads, only if `holds` still says the proof stands when the thread that navigates runs it:
/// the window may be on the sidecar's origin from here until the session ends.
fn begin_session(session: Option<&Session>, holds: &ProofHolds, then: impl FnOnce()) {
    let begun = match session {
        Some(session) => session.go_live_if(holds),
        None => holds(),
    };
    if begun {
        then();
    }
}

/// The generation a proof is held to (see `proof_holds` and `await_first_proof`); 0 without a session.
pub(crate) fn generation_of(app: &AppHandle) -> u64 {
    app.try_state::<Session>().map_or(0, |session| session.generation())
}

/// A proof of the sidecar that ran at `generation` stands until it exits again, the supervisor gives up, or the app
/// quits.
pub(crate) fn proof_holds(app: &AppHandle, generation: u64, quitting: Arc<AtomicBool>) -> ProofHolds {
    let app = app.clone();
    Arc::new(move || {
        app.try_state::<Session>().is_some_and(|session| session.unchanged_since(generation))
            && !app.state::<ServerGaveUp>().0.load(Ordering::SeqCst)
            && !quitting.load(Ordering::SeqCst)
    })
}

/// Whether `url` is one of the app's own pages the window can wait on: not a sidecar page, `about:` or a
/// non-web scheme.
fn is_splash_page(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    matches!(url.scheme(), "tauri" | "http" | "https") && main_window_may_navigate(url, None, dev_url)
}

/// What the dashboard window and its siblings do for the session.
pub(crate) trait SessionWindows {
    /// A `piwi://` link waits for the next dashboard page from now on, not for the page of the sidecar that exited.
    fn hold_links(&self);
    /// Every window on the sidecar's origin leaves it, and the splash shows `text`.
    fn leave_server(&self, text: &'static str);
    /// The splash shows `text`; with `reveal`, the window comes up too.
    fn show_splash(&self, text: &'static str, reveal: bool);
    /// The dashboard window loads the sidecar's session from `bootstrap_url`, unless `holds` says on the thread that
    /// navigates that the proof no longer stands: the sidecar may have exited since it passed.
    fn load_session(&self, bootstrap_url: String, holds: ProofHolds);
}

impl SessionWindows for AppHandle {
    fn hold_links(&self) {
        if let Some(linked) = self.try_state::<LinkedPage>() {
            linked.page_unloads();
        }
    }

    fn leave_server(&self, text: &'static str) {
        let handle = self.clone();
        let _ = self.run_on_main_thread(move || {
            for (label, window) in handle.webview_windows() {
                if label != "main" {
                    let _ = window.close();
                }
            }
            if let Some(window) = handle.get_webview_window("main") {
                let splash = handle
                    .try_state::<Session>()
                    .and_then(|session| session.splash.clone())
                    .unwrap_or_else(|| tauri::Url::parse("about:blank").expect("about:blank is a URL"));
                let _ = window.navigate(splash);
            }
            // The server's runs, and their stops, are gone with it, as is its run channel.
            crate::refresh_tray_stop(&handle, 0);
        });
        crate::withdraw_discovery_hub(self);
        show_splash_status(self, text, false);
    }

    fn show_splash(&self, text: &'static str, reveal: bool) {
        show_splash_status(self, text, reveal);
    }

    fn load_session(&self, bootstrap_url: String, holds: ProofHolds) {
        let handle = self.clone();
        let _ = self.run_on_main_thread(move || {
            let session = handle.try_state::<Session>();
            begin_session(session.as_deref(), &holds, || {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.eval(&format!("window.location.replace('{bootstrap_url}')"));
                }
                // The server proved its token: the discovery file names it as the hub of a terminal's runs.
                crate::publish_discovery_hub(&handle, holds.clone());
            });
        });
    }
}

/// How often the wait for a proof asks, and when it says the wait is long.
pub(crate) struct ProofPace {
    pub(crate) slow_after: Duration,
    pub(crate) poll: Duration,
    pub(crate) slow_poll: Duration,
}

/// Ask the server on `port` for the proof of `token` until it gives it. False once `stop` says to give up.
/// `on_slow` runs once, when the wait passes `pace.slow_after`.
pub(crate) fn wait_for_proof(
    port: u16,
    token: &str,
    pace: &ProofPace,
    stop: impl Fn() -> bool,
    mut on_slow: impl FnMut(),
) -> bool {
    let started = Instant::now();
    let mut slow = false;
    loop {
        if health_ok(port, token) {
            return true;
        }
        if stop() {
            return false;
        }
        if !slow && started.elapsed() >= pace.slow_after {
            slow = true;
            on_slow();
        }
        std::thread::sleep(if slow { pace.slow_poll } else { pace.poll });
    }
}

/// Wait for the first proof of the sidecar and settle which process it belongs to. A passing proof marks the session
/// opened, so a sidecar that exits after it is the restart's to bring back (`server_stopped`, `server_restarted`);
/// the generation is read after that, and a second proof must pass at it. A sidecar that exited before the first proof
/// leaves the generation of the process that proved last, and the wait goes on. Returns the generation the proof
/// belongs to, or None once `stop` says to give up.
pub(crate) fn await_first_proof(
    port: u16,
    token: &str,
    pace: &ProofPace,
    generation: impl Fn() -> u64,
    mark_opened: impl Fn(),
    stop: impl Fn() -> bool,
    mut on_slow: impl FnMut(),
) -> Option<u64> {
    loop {
        if !wait_for_proof(port, token, pace, &stop, &mut on_slow) {
            return None;
        }
        mark_opened();
        let at = generation();
        if health_ok(port, token) {
            return Some(at);
        }
        if stop() {
            return None;
        }
    }
}

/// The texts the splash shows for a server that is stopped, slow to come back, or gone.
#[derive(Clone, Copy)]
pub(crate) struct SplashTexts {
    pub(crate) restarting: &'static str,
    pub(crate) slow: &'static str,
    pub(crate) stopped: &'static str,
}

/// The sidecar the window has a session with.
#[derive(Clone)]
pub(crate) struct ServerSession {
    pub(crate) port: u16,
    pub(crate) token: String,
    pub(crate) texts: SplashTexts,
    pub(crate) pace: &'static ProofPace,
}

/// The sidecar exited and will be restarted: windows on its origin leave it, once a session was opened. Returns
/// the number of this restart.
pub(crate) fn server_stopped(app: &AppHandle, server: &ServerSession) -> u64 {
    let session = app.try_state::<Session>();
    stopped_for_restart(app, session.as_deref(), server.texts.restarting)
}

/// The session ends first, so no page of the sidecar that exited takes a link or is sent one; then links wait for the
/// next dashboard page, and the windows leave the sidecar's origin once a session was opened.
fn stopped_for_restart<W: SessionWindows>(windows: &W, session: Option<&Session>, text: &'static str) -> u64 {
    let restart = session.map_or(0, Session::exited);
    windows.hold_links();
    if session.is_some_and(|session| session.opened.load(Ordering::SeqCst)) {
        windows.leave_server(text);
    }
    restart
}

/// The supervisor gives up on the sidecar: windows on its origin leave it, once a session was opened, and the splash
/// says the server stopped.
pub(crate) fn server_gave_up(app: &AppHandle, server: &ServerSession) {
    let opened = app.try_state::<Session>().is_some_and(|session| session.gave_up());
    stopped_for_good(app, opened, server.texts.stopped);
}

/// Links wait, every window on the sidecar's origin leaves it when a session was opened, and the splash says `text`
/// with the window up.
fn stopped_for_good<W: SessionWindows>(windows: &W, opened: bool, text: &'static str) {
    windows.hold_links();
    if opened {
        windows.leave_server(text);
    }
    windows.show_splash(text, true);
}

/// The sidecar started again: once it proves the token, the window loads a new session. A restart that comes
/// first, a quit, or the supervisor giving up ends the wait.
pub(crate) fn server_restarted(app: &AppHandle, server: ServerSession, restart: u64, quitting: Arc<AtomicBool>) {
    let opened = app.try_state::<Session>().is_some_and(|s| s.opened.load(Ordering::SeqCst));
    if !opened {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(session) = app.try_state::<Session>() else {
            return;
        };
        let superseded = || !session.unchanged_since(restart);
        let gave_up = || app.state::<ServerGaveUp>().0.load(Ordering::SeqCst);
        let holds = proof_holds(&app, restart, quitting.clone());
        let proved = resume_session(&app, &server, |windows| windows.show_splash(server.texts.slow, false), holds);
        say_stopped(&app, server.texts.stopped, proved, superseded(), quitting.load(Ordering::SeqCst), gave_up());
    });
}

/// A wait for a restarted server's proof ended without one: when it ended because the supervisor gave up, the splash
/// says the server stopped and the window comes up, since a restart in progress is not news but this is. Nothing is
/// said when a later restart took over the wait or the app is quitting.
fn say_stopped<W: SessionWindows>(
    windows: &W,
    text: &'static str,
    proved: bool,
    superseded: bool,
    quitting: bool,
    gave_up: bool,
) {
    if !proved && !superseded && !quitting && gave_up {
        windows.show_splash(text, true);
    }
}

/// Wait for the restarted server's proof, then load its session. A server that never proves gets no session, and the
/// wait ends once `holds` says the proof it waits for no longer can stand. A server that proved the token but gives
/// no session code after a few tries (`session_url_retrying`) leaves the window on the stopped splash, shown, while
/// the proof still holds.
pub(crate) fn resume_session<W: SessionWindows>(
    windows: &W,
    server: &ServerSession,
    on_slow: impl Fn(&W),
    holds: ProofHolds,
) -> bool {
    let stop = {
        let holds = holds.clone();
        move || !holds()
    };
    let proved = wait_for_proof(server.port, &server.token, server.pace, stop, || on_slow(windows));
    if proved {
        // The session code is asked over a connection that proved the token; no code, no session.
        let stop = {
            let holds = holds.clone();
            move || !holds()
        };
        return match session_url_retrying(server.port, &server.token, None, server.pace, stop) {
            Ok(url) => {
                windows.load_session(url, holds);
                true
            }
            Err(_) => {
                if holds() {
                    windows.show_splash(server.texts.stopped, true);
                }
                false
            }
        };
    }
    proved
}

/// The window's first session, once the sidecar proved the token at startup: the session code is asked a few times
/// (`session_url_retrying`), and the tries end once `holds` says the proof can no longer stand. A sidecar that exits
/// meanwhile is the supervisor's to restart, with its own "restarting" text, so the stopped splash is shown, with the
/// window up, only while the proof still holds. Returns the error that left the window without a session.
pub(crate) fn open_first_session<W: SessionWindows>(
    windows: &W,
    server: &ServerSession,
    page: Option<&str>,
    holds: ProofHolds,
) -> Result<(), String> {
    let stop = {
        let holds = holds.clone();
        move || !holds()
    };
    match session_url_retrying(server.port, &server.token, page, server.pace, stop) {
        Ok(url) => {
            windows.load_session(url, holds);
            Ok(())
        }
        Err(error) => {
            if holds() {
                windows.show_splash(server.texts.stopped, true);
            }
            Err(error)
        }
    }
}

/// How many times a session code is asked for before the server is taken to give none: a server that proved the
/// token can still fail one request.
const SESSION_CODE_TRIES: usize = 4;

/// `session_url`, asked again after `pace.poll` when the server gave no code, up to `SESSION_CODE_TRIES` times in
/// all, and not again once `stop` says so. The last error is returned. Each ask is over a connection that proves
/// the token, so a process that took the port gets none.
pub(crate) fn session_url_retrying(
    port: u16,
    token: &str,
    page: Option<&str>,
    pace: &ProofPace,
    stop: impl Fn() -> bool,
) -> Result<String, String> {
    let mut tries = 0;
    loop {
        match session_url(port, token, page) {
            Ok(url) => return Ok(url),
            Err(error) => {
                tries += 1;
                if tries >= SESSION_CODE_TRIES || stop() {
                    return Err(error);
                }
            }
        }
        std::thread::sleep(pace.poll);
    }
}

/// The path the shell asks a session code from.
const SESSION_CODE_PATH: &str = "/api/desktop/run-target/session-code";

/// The URL that signs the window in: the server gives the shell a single-use session code over a
/// connection that proved the token (`connect_proving_token`), and the URL holds that code, never the token.
pub(crate) fn session_url(port: u16, token: &str, page: Option<&str>) -> Result<String, String> {
    let server = ServerInfo { port, token: token.to_string() };
    let answer = crate::run_target::local_call(&server, "POST", SESSION_CODE_PATH, Some(&serde_json::json!({})))?;
    let code = answer
        .get("code")
        .and_then(|code| code.as_str())
        .filter(|code| is_session_code(code))
        .ok_or("the local server gave no session code")?;
    Ok(bootstrap_url(port, code, page))
}

/// A session code is `pds_` and 64 hex digits.
fn is_session_code(code: &str) -> bool {
    code.strip_prefix("pds_").is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::io::Write;
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use crate::tests::read_request_from;
    use crate::{main_window_may_navigate, proof_of};

    const PACE: ProofPace = ProofPace {
        slow_after: Duration::from_millis(20),
        poll: Duration::from_millis(5),
        slow_poll: Duration::from_millis(5),
    };

    fn server(port: u16, token: &str) -> ServerSession {
        ServerSession {
            port,
            token: token.to_string(),
            texts: SplashTexts { restarting: "restarting", slow: "slow", stopped: "stopped" },
            pace: &PACE,
        }
    }

    /// Records what the windows were told, in order. A session load waits in `loads` until `run_main_thread`, as
    /// the real one waits for the thread that navigates the window.
    #[derive(Default)]
    struct Recorder {
        told: RefCell<Vec<String>>,
        loads: RefCell<Vec<(String, ProofHolds)>>,
        /// When set, the session whose state a hold of links records.
        session: Option<Arc<Session>>,
    }

    impl Recorder {
        fn run_main_thread(&self) {
            for (url, holds) in self.loads.borrow_mut().drain(..) {
                if holds() {
                    self.told.borrow_mut().push(format!("session: {url}"));
                }
            }
        }
    }

    fn always() -> ProofHolds {
        Arc::new(|| true)
    }

    impl SessionWindows for Recorder {
        fn hold_links(&self) {
            let told = match &self.session {
                Some(session) => format!("hold links, live: {}", session.is_live()),
                None => "hold links".to_string(),
            };
            self.told.borrow_mut().push(told);
        }
        fn leave_server(&self, text: &'static str) {
            self.told.borrow_mut().push(format!("leave: {text}"));
        }
        fn show_splash(&self, text: &'static str, reveal: bool) {
            self.told.borrow_mut().push(format!("splash: {text}{}", if reveal { " (revealed)" } else { "" }));
        }
        fn load_session(&self, bootstrap_url: String, holds: ProofHolds) {
            self.loads.borrow_mut().push((bootstrap_url, holds));
        }
    }

    /// The session code the test servers give.
    const CODE: &str = "pds_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// A server that answers every request on its port with `token`'s proof for that request, or a wrong one, and
    /// gives `CODE` to the request after a proof it keeps the connection for.
    fn serve_health(token: &'static str, honest: bool) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || answer_proofs(listener, token, honest));
        port
    }

    /// A server that refuses the first `refusals` requests for a session code and gives `CODE` to the rest; the
    /// count is the number of requests for a code it has seen.
    fn serve_codes_after(token: &'static str, refusals: usize) -> (u16, Arc<AtomicUsize>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let asked = Arc::new(AtomicUsize::new(0));
        let counted = asked.clone();
        std::thread::spawn(move || answer_proofs_with(listener, token, true, refusals, counted));
        (port, asked)
    }

    fn answer_proofs(listener: std::net::TcpListener, token: &'static str, honest: bool) {
        answer_proofs_with(listener, token, honest, 0, Arc::new(AtomicUsize::new(0)));
    }

    fn answer_proofs_with(
        listener: std::net::TcpListener,
        token: &'static str,
        honest: bool,
        refusals: usize,
        asked: Arc<AtomicUsize>,
    ) {
        let port = listener.local_addr().unwrap().port();
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let request = read_request_from(&mut stream);
            let challenge = request
                .lines()
                .find_map(|l| l.strip_prefix("x-piwi-desktop-challenge: "))
                .unwrap_or_default()
                .to_string();
            let proof = if honest { proof_of(token, port, &challenge) } else { proof_of("other", port, &challenge) };
            if request.starts_with("GET /api/health HTTP/1.1") {
                // The proof the shell keeps its connection for, then the session code asked on it.
                let _ = stream.write_all(
                    format!("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nx-piwi-desktop-proof: {proof}\r\n\r\n{{}}")
                        .as_bytes(),
                );
                read_request_from(&mut stream);
                let answer = if asked.fetch_add(1, Ordering::SeqCst) >= refusals {
                    let body = format!("{{\"code\":\"{CODE}\"}}");
                    format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
                } else {
                    let body = "{\"message\":\"no\"}";
                    format!("HTTP/1.1 403 Forbidden\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
                };
                let _ = stream.write_all(answer.as_bytes());
                continue;
            }
            let _ = stream.write_all(
                format!("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\nx-piwi-desktop-proof: {proof}\r\n\r\n{{}}")
                    .as_bytes(),
            );
        }
    }

    #[test]
    fn the_session_loads_after_the_restarted_server_proves_the_token() {
        let port = serve_health("pd_token", true);
        let windows = Recorder::default();
        let proved = resume_session(&windows, &server(port, "pd_token"), |w| w.show_splash("slow", false), always());
        assert!(proved);
        windows.run_main_thread();
        assert_eq!(
            *windows.told.borrow(),
            vec![format!("session: http://127.0.0.1:{port}/__piwi/session?code={CODE}")]
        );
    }

    /// A server that proved the token and gives no code after the tries leaves the window on the stopped splash,
    /// shown, with no session; the supervisor need not have given up.
    #[test]
    fn a_server_that_gives_no_session_code_gets_no_session_and_the_stopped_splash() {
        let (port, asked) = serve_codes_after("pd_token", usize::MAX);
        let windows = Recorder::default();
        let proved = resume_session(&windows, &server(port, "pd_token"), |_| {}, always());
        assert!(!proved);
        windows.run_main_thread();
        assert_eq!(*windows.told.borrow(), vec!["splash: stopped (revealed)".to_string()]);
        assert!(windows.loads.borrow().is_empty());
        assert_eq!(asked.load(Ordering::SeqCst), SESSION_CODE_TRIES);
    }

    /// A code that fails once or twice after a good restart is asked for again, and the session loads.
    #[test]
    fn a_session_code_that_fails_after_a_good_restart_is_asked_for_again() {
        let (port, asked) = serve_codes_after("pd_token", 2);
        let windows = Recorder::default();
        assert!(resume_session(&windows, &server(port, "pd_token"), |_| {}, always()));
        windows.run_main_thread();
        assert_eq!(
            *windows.told.borrow(),
            vec![format!("session: http://127.0.0.1:{port}/__piwi/session?code={CODE}")]
        );
        assert_eq!(asked.load(Ordering::SeqCst), 3);
    }

    /// The tries stop when the proof can no longer stand, and then nothing is said: a later restart or the quit owns
    /// the splash.
    #[test]
    fn the_session_code_tries_stop_when_the_proof_no_longer_holds() {
        let (port, asked) = serve_codes_after("pd_token", usize::MAX);
        let windows = Recorder::default();
        let seen = Arc::new(AtomicUsize::new(0));
        let holds: ProofHolds = {
            let seen = seen.clone();
            // Holds for the proof wait and the first ask, then not.
            Arc::new(move || seen.fetch_add(1, Ordering::SeqCst) < 2)
        };
        assert!(!resume_session(&windows, &server(port, "pd_token"), |_| {}, holds));
        windows.run_main_thread();
        assert!(windows.told.borrow().is_empty());
        assert!(asked.load(Ordering::SeqCst) < SESSION_CODE_TRIES);
    }

    /// The first session at startup: a server that gives no code leaves the stopped splash, with the window up, while
    /// the proof holds; a sidecar that exits during the tries leaves the splash to the supervisor's "restarting", and a
    /// window launched hidden to the tray stays hidden.
    #[test]
    fn the_startup_shows_stopped_only_while_the_proof_holds() {
        let (port, asked) = serve_codes_after("pd_token", usize::MAX);
        let windows = Recorder::default();
        let error = open_first_session(&windows, &server(port, "pd_token"), None, always()).unwrap_err();
        assert!(!error.is_empty());
        assert_eq!(*windows.told.borrow(), vec!["splash: stopped (revealed)".to_string()]);
        assert_eq!(asked.load(Ordering::SeqCst), SESSION_CODE_TRIES);

        // The sidecar exits after the first ask: the tries stop, and nothing is said.
        let (port, asked) = serve_codes_after("pd_token", usize::MAX);
        let windows = Recorder::default();
        let session = Arc::new(Session::new(None, None));
        let generation = session.generation();
        let holds: ProofHolds = {
            let session = session.clone();
            let seen = Arc::new(AtomicUsize::new(0));
            Arc::new(move || {
                if seen.fetch_add(1, Ordering::SeqCst) == 1 {
                    session.exited();
                }
                session.unchanged_since(generation)
            })
        };
        assert!(open_first_session(&windows, &server(port, "pd_token"), None, holds).is_err());
        windows.run_main_thread();
        assert!(windows.told.borrow().is_empty(), "{:?}", windows.told.borrow());
        assert!(asked.load(Ordering::SeqCst) < SESSION_CODE_TRIES);

        // A code that comes loads the session.
        let (port, _) = serve_codes_after("pd_token", 1);
        let windows = Recorder::default();
        assert!(open_first_session(&windows, &server(port, "pd_token"), None, always()).is_ok());
        windows.run_main_thread();
        assert_eq!(
            *windows.told.borrow(),
            vec![format!("session: http://127.0.0.1:{port}/__piwi/session?code={CODE}")]
        );
    }

    /// A panic under the turn (a `holds` that panics) poisons its lock; the exit and the give-up still run, so the
    /// supervisor still restarts the sidecar.
    #[test]
    fn a_poisoned_turn_still_lets_the_exit_and_the_give_up_run() {
        let session = Arc::new(Session::new(None, None));
        session.mark_opened();
        let panicking: ProofHolds = Arc::new(|| panic!("holds panicked"));
        let poisoned = {
            let session = session.clone();
            std::thread::spawn(move || session.go_live_if(&panicking)).join()
        };
        assert!(poisoned.is_err());
        assert!(session.turn.is_poisoned());

        assert_eq!(session.exited(), 1);
        assert!(!session.is_live());
        assert!(session.go_live_if(&always()));
        assert!(session.is_live());
        assert!(session.gave_up());
        assert!(!session.is_live());
        assert_eq!(session.generation(), 2);
    }

    /// The startup path asks the same way: a code that fails once comes on the next ask; one that never comes ends
    /// in an error after the tries, or at once when told to stop.
    #[test]
    fn the_startup_asks_for_the_session_code_more_than_once() {
        let (port, asked) = serve_codes_after("pd_token", 2);
        let url = session_url_retrying(port, "pd_token", Some("/projects"), &PACE, || false).unwrap();
        assert!(url.starts_with(&format!("http://127.0.0.1:{port}/__piwi/session?code={CODE}")), "{url}");
        assert_eq!(asked.load(Ordering::SeqCst), 3);

        let (port, asked) = serve_codes_after("pd_token", usize::MAX);
        assert!(session_url_retrying(port, "pd_token", None, &PACE, || false).is_err());
        assert_eq!(asked.load(Ordering::SeqCst), SESSION_CODE_TRIES);

        let (port, asked) = serve_codes_after("pd_token", usize::MAX);
        assert!(session_url_retrying(port, "pd_token", None, &PACE, || true).is_err());
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }

    /// The sidecar can exit between its proof and the navigation the main thread makes: that load is dropped, and
    /// the window stays where the exit left it.
    #[test]
    fn a_proof_does_not_load_a_session_after_the_sidecar_exited_again() {
        let port = serve_health("pd_token", true);
        let session = Arc::new(Session::new(None, None));
        let generation = session.generation();
        let holds: ProofHolds = {
            let session = session.clone();
            Arc::new(move || session.unchanged_since(generation))
        };
        let windows = Recorder::default();
        assert!(resume_session(&windows, &server(port, "pd_token"), |_| {}, holds));
        session.restarts.fetch_add(1, Ordering::SeqCst);
        windows.run_main_thread();
        assert!(windows.told.borrow().is_empty());
    }

    /// A proof ends its wait too once it can no longer stand, as when the supervisor gave up or the app quits.
    #[test]
    fn the_wait_ends_when_the_proof_cannot_stand_any_more() {
        let port = serve_health("pd_token", false);
        let windows = Recorder::default();
        let checks = Arc::new(AtomicU64::new(0));
        let holds: ProofHolds = {
            let checks = checks.clone();
            Arc::new(move || checks.fetch_add(1, Ordering::SeqCst) < 8)
        };
        assert!(!resume_session(&windows, &server(port, "pd_token"), |_| {}, holds));
        windows.run_main_thread();
        assert!(windows.loads.borrow().is_empty());
    }

    /// A sidecar that exits before its first proof and starts again: the proof that passes is the new process's, and
    /// the load that follows is held to the generation read once that proof passed.
    #[test]
    fn a_sidecar_that_exited_before_its_first_proof_still_gets_the_session() {
        // The port stays bound, so no parallel test can take it while the first sidecar is gone.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let session = Arc::new(Session::new(None, None));
        let waiting = {
            let session = session.clone();
            std::thread::spawn(move || {
                await_first_proof(
                    port,
                    "pd_token",
                    &PACE,
                    || session.generation(),
                    || session.mark_opened(),
                    || false,
                    || {},
                )
            })
        };
        // The first sidecar exits before any proof; the restarted one proves the token on the same port.
        std::thread::sleep(Duration::from_millis(30));
        session.restarts.fetch_add(1, Ordering::SeqCst);
        std::thread::spawn(move || answer_proofs(listener, "pd_token", true));
        let at = waiting.join().unwrap().expect("the restarted sidecar proved the token");
        assert_eq!(at, 1);
        assert!(session.opened.load(Ordering::SeqCst));
        assert!(session.unchanged_since(at));
    }

    #[test]
    fn the_first_proof_wait_ends_when_told_to_stop() {
        let port = serve_health("pd_token", false);
        let session = Session::new(None, None);
        let checks = AtomicU64::new(0);
        let at = await_first_proof(
            port,
            "pd_token",
            &PACE,
            || session.generation(),
            || session.mark_opened(),
            || checks.fetch_add(1, Ordering::SeqCst) >= 4,
            || {},
        );
        assert_eq!(at, None);
        assert!(!session.opened.load(Ordering::SeqCst));
    }

    #[test]
    fn the_window_comes_up_only_when_the_supervisor_gave_up_on_the_server() {
        let said = |proved, superseded, quitting, gave_up| {
            let windows = Recorder::default();
            say_stopped(&windows, "stopped", proved, superseded, quitting, gave_up);
            windows.told.take()
        };
        assert_eq!(said(false, false, false, true), vec!["splash: stopped (revealed)".to_string()]);
        assert!(said(false, false, false, false).is_empty());
        assert!(said(true, false, false, true).is_empty());
        assert!(said(false, true, false, true).is_empty());
        assert!(said(false, false, true, true).is_empty());
    }

    #[test]
    fn a_session_counts_the_exits_after_the_generation_read() {
        let session = Session::new(None, None);
        let generation = session.generation();
        assert!(session.unchanged_since(generation));
        session.restarts.fetch_add(1, Ordering::SeqCst);
        assert!(!session.unchanged_since(generation));
        assert!(session.unchanged_since(session.generation()));
    }

    #[test]
    fn a_server_that_cannot_prove_the_token_gets_no_session() {
        let port = serve_health("pd_token", false);
        let windows = Recorder::default();
        let checks = Arc::new(AtomicU64::new(0));
        let holds: ProofHolds = {
            let checks = checks.clone();
            Arc::new(move || checks.fetch_add(1, Ordering::SeqCst) < 8)
        };
        let proved = resume_session(&windows, &server(port, "pd_token"), |w| w.show_splash("slow", false), holds);
        assert!(!proved);
        windows.run_main_thread();
        let told = windows.told.borrow();
        assert_eq!(*told, vec!["splash: slow".to_string()]);
        assert!(told.iter().all(|line| !line.starts_with("session")));
    }

    #[test]
    fn nothing_answering_leaves_the_windows_without_a_session() {
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let windows = Recorder::default();
        let proved = resume_session(&windows, &server(free, "pd_token"), |_| {}, Arc::new(|| false));
        assert!(!proved);
        windows.run_main_thread();
        assert!(windows.told.borrow().is_empty());
    }

    /// After the supervisor gives up, whether a crash loop ended it or a respawn that returned nothing, every window
    /// on the sidecar's origin has left it and the stopped splash is up.
    #[test]
    fn giving_up_leaves_the_sidecar_origin_and_reveals_the_stopped_splash() {
        let windows = Recorder::default();
        stopped_for_good(&windows, true, "stopped");
        assert_eq!(
            *windows.told.borrow(),
            vec!["hold links".to_string(), "leave: stopped".to_string(), "splash: stopped (revealed)".to_string()]
        );
    }

    #[test]
    fn giving_up_before_any_session_only_says_the_server_stopped() {
        let windows = Recorder::default();
        stopped_for_good(&windows, false, "stopped");
        assert_eq!(*windows.told.borrow(), vec!["hold links".to_string(), "splash: stopped (revealed)".to_string()]);
    }

    /// A link that comes after the sidecar exited is held before the window leaves its page, whether or not a
    /// session was opened, and only once the session ended, so no page of that sidecar takes one in between.
    #[test]
    fn the_sidecar_exiting_holds_links_before_the_window_leaves_it() {
        let session = Session::new(None, None);
        let windows = Recorder::default();
        assert_eq!(stopped_for_restart(&windows, Some(&session), "restarting"), 1);
        assert_eq!(*windows.told.borrow(), vec!["hold links".to_string()]);

        session.opened.store(true, Ordering::SeqCst);
        let windows = Recorder::default();
        assert_eq!(stopped_for_restart(&windows, Some(&session), "restarting"), 2);
        assert_eq!(*windows.told.borrow(), vec!["hold links".to_string(), "leave: restarting".to_string()]);

        let windows = Recorder::default();
        assert_eq!(stopped_for_restart(&windows, None, "restarting"), 0);
        assert_eq!(*windows.told.borrow(), vec!["hold links".to_string()]);

        let session = Arc::new(Session::new(None, None));
        session.opened.store(true, Ordering::SeqCst);
        assert!(session.go_live_if(&always()));
        let windows = Recorder { session: Some(session.clone()), ..Recorder::default() };
        assert_eq!(stopped_for_restart(&windows, Some(&session), "restarting"), 1);
        assert_eq!(*windows.told.borrow(), vec!["hold links, live: false".to_string(), "leave: restarting".to_string()]);
    }

    /// The dashboard window reaches the sidecar's origin only while a proof held for the session it loaded.
    #[test]
    fn the_window_may_reach_the_sidecar_only_while_the_session_is_live() {
        let url = |s: &str| tauri::Url::parse(s).unwrap();
        let page = url("http://127.0.0.1:3000/projects/1");
        let may = |session: &Session| main_window_may_navigate(&page, session.sidecar_port(Some(3000)), None);
        let session = Session::new(None, None);
        assert!(!may(&session));

        let holds: ProofHolds = Arc::new(|| true);
        let mut loaded = false;
        begin_session(Some(&session), &holds, || loaded = true);
        assert!(loaded);
        assert!(may(&session));
        // The app's own pages stay reachable whatever the state.
        assert!(main_window_may_navigate(&url("tauri://localhost/index.html"), session.sidecar_port(Some(3000)), None));

        session.exited();
        assert!(!may(&session));
        assert!(main_window_may_navigate(&url("tauri://localhost/index.html"), session.sidecar_port(Some(3000)), None));
    }

    /// An auxiliary or output window built just as the sidecar exited is closed, not left on the dead origin; one
    /// built while the session is live stays.
    #[test]
    fn a_window_built_after_the_sidecar_exited_is_closed() {
        let session = Session::new(None, None);
        begin_session(Some(&session), &always(), || {});
        let closed = std::cell::Cell::new(false);
        let live = |session: &Session| session.sidecar_port(Some(3000));

        assert!(crate::keep_window_if_live(live(&session), 3000, || closed.set(true)).is_ok());
        assert!(!closed.get());

        session.exited();
        assert!(crate::keep_window_if_live(live(&session), 3000, || closed.set(true)).is_err());
        assert!(closed.get());

        closed.set(false);
        begin_session(Some(&session), &always(), || {});
        session.gave_up();
        assert!(crate::keep_window_if_live(live(&session), 3000, || closed.set(true)).is_err());
        assert!(closed.get());
        // Another port is not the sidecar this window was opened for.
        closed.set(false);
        assert!(crate::keep_window_if_live(Some(3001), 3000, || closed.set(true)).is_err());
        assert!(closed.get());
    }

    /// A proof that no longer stands when the load runs leaves the session not live.
    #[test]
    fn a_stale_proof_does_not_make_the_session_live() {
        let session = Session::new(None, None);
        let holds: ProofHolds = Arc::new(|| false);
        let mut loaded = false;
        begin_session(Some(&session), &holds, || loaded = true);
        assert!(!loaded);
        assert!(!session.is_live());
        assert_eq!(session.sidecar_port(Some(3000)), None);
    }

    #[test]
    fn a_sidecar_exit_ends_the_live_session() {
        let session = Session::new(None, None);
        begin_session(Some(&session), &always(), || {});
        assert!(session.is_live());
        let generation = session.generation();
        assert_eq!(session.exited(), 1);
        assert!(!session.is_live());
        assert!(!session.unchanged_since(generation));
    }

    #[test]
    fn giving_up_ends_the_live_session_and_says_whether_one_was_opened() {
        let session = Session::new(None, None);
        assert!(!session.gave_up());
        session.mark_opened();
        begin_session(Some(&session), &always(), || {});
        assert!(session.is_live());
        assert!(session.gave_up());
        assert!(!session.is_live());
    }

    /// An exit or a give-up that lands between the proof's check and the store of `live` must leave the session not
    /// live: the check and the store are one turn, so the clear waits for it and runs after.
    #[test]
    fn an_exit_or_give_up_between_the_check_and_the_store_leaves_the_session_not_live() {
        for give_up in [false, true] {
            let session = Arc::new(Session::new(None, None));
            session.mark_opened();
            let generation = session.generation();
            let (checking, clear) = std::sync::mpsc::channel::<()>();
            let ends = {
                let session = session.clone();
                std::thread::spawn(move || {
                    clear.recv().unwrap();
                    if give_up {
                        session.gave_up();
                    } else {
                        session.exited();
                    }
                })
            };
            let holds: ProofHolds = {
                let session = session.clone();
                Arc::new(move || {
                    let stands = session.unchanged_since(generation);
                    // The end of the sidecar starts now and has time to land before the store, if nothing holds it.
                    checking.send(()).unwrap();
                    std::thread::sleep(Duration::from_millis(100));
                    stands
                })
            };
            begin_session(Some(&session), &holds, || {});
            ends.join().unwrap();
            assert!(!session.is_live(), "give_up: {give_up}");
        }
    }

    /// A load queued on the main thread before the final give-up runs after it: the give-up makes its proof stale, so
    /// it neither loads nor sets the flag.
    #[test]
    fn a_load_queued_before_the_final_give_up_never_sets_live() {
        let session = Arc::new(Session::new(None, None));
        session.mark_opened();
        let generation = session.generation();
        let holds: ProofHolds = {
            let session = session.clone();
            Arc::new(move || session.unchanged_since(generation))
        };
        begin_session(Some(&session), &holds, || {});
        assert!(session.is_live());
        assert!(session.gave_up());
        assert!(!session.is_live());
        let mut loaded = false;
        begin_session(Some(&session), &holds, || loaded = true);
        assert!(!loaded);
        assert!(!session.is_live());
        assert_eq!(session.sidecar_port(Some(3000)), None);
    }

    #[test]
    fn only_the_apps_own_pages_are_where_the_window_waits() {
        let page = |s: &str| tauri::Url::parse(s).unwrap();
        let dev = page("http://localhost:1420/");
        assert!(is_splash_page(&page("tauri://localhost/index.html"), None));
        assert!(is_splash_page(&page("http://tauri.localhost/index.html"), None));
        assert!(is_splash_page(&page("http://localhost:1420/index.html"), Some(&dev)));
        assert!(!is_splash_page(&page("http://localhost:1420/index.html"), None));
        assert!(!is_splash_page(&page("about:blank"), None));
        assert!(!is_splash_page(&page("http://127.0.0.1:3000/"), None));
        assert!(!is_splash_page(&page("file:///tmp/index.html"), None));
    }

    #[test]
    fn the_splash_is_remembered_only_when_it_is_one() {
        let page = |s: &str| tauri::Url::parse(s).unwrap();
        assert!(Session::new(Some(page("tauri://localhost/index.html")), None).splash.is_some());
        assert!(Session::new(Some(page("http://127.0.0.1:3000/")), None).splash.is_none());
        assert!(Session::new(None, None).splash.is_none());
    }

    /// What a server that holds the token answers a request for a session code with.
    fn code_answer(body: &str) -> Vec<u8> {
        format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).into_bytes()
    }

    #[test]
    fn the_session_url_holds_the_code_and_never_the_token() {
        let (port, seen) = crate::tests::serve_as_holder_of("pd_token", code_answer(&format!("{{\"code\":\"{CODE}\"}}")));
        let url = session_url(port, "pd_token", Some("/runs?tab=failed")).unwrap();
        assert_eq!(
            url,
            format!("http://127.0.0.1:{port}/__piwi/session?code={CODE}&to=%2Fruns%3Ftab%3Dfailed")
        );
        assert!(!url.contains("pd_token"), "{url}");
        let request = seen.join().unwrap();
        assert!(request.starts_with(&format!("POST {SESSION_CODE_PATH} HTTP/1.0\r\n")), "{request}");
        assert!(request.contains("x-piwi-token: pd_token"), "{request}");
        assert!(request.contains("Content-Type: application/json"), "{request}");
        assert!(!request.to_ascii_lowercase().contains("sec-fetch"), "{request}");
        assert!(!request.to_ascii_lowercase().contains("origin"), "{request}");
    }

    #[test]
    fn the_session_url_refuses_an_answer_that_is_not_a_session_code() {
        let token = "pd_aaaaaaaa";
        for body in [
            "{}".to_string(),
            "{\"code\":7}".to_string(),
            "{\"code\":\"pds_short\"}".to_string(),
            format!("{{\"code\":\"{token}\"}}"),
            format!("{{\"code\":\"{}\"}}", CODE.replace("pds_", "pdq_")),
            format!("{{\"code\":\"{}z\"}}", &CODE[..CODE.len() - 1]),
            "not json".to_string(),
        ] {
            let (port, seen) = crate::tests::serve_as_holder_of("pd_aaaaaaaa", code_answer(&body));
            assert!(session_url(port, token, None).is_err(), "{body}");
            seen.join().unwrap();
        }
        let (port, seen) = crate::tests::serve_as_holder_of(
            "pd_aaaaaaaa",
            b"HTTP/1.1 403 Forbidden\r\ncontent-length: 17\r\nconnection: close\r\n\r\n{\"message\":\"no\"}".to_vec(),
        );
        assert!(session_url(port, token, None).is_err());
        seen.join().unwrap();
    }

    #[test]
    fn a_process_that_took_the_port_gets_no_token_and_no_session_url() {
        let (port, seen) = crate::tests::serve_as_squatter();
        assert!(session_url(port, "pd_token", None).is_err());
        let request = seen.join().unwrap();
        assert!(!request.contains("pd_token"), "{request}");
        assert!(!request.contains("session-code"), "{request}");
    }
}
