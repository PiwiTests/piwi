// The dashboard window's session with the sidecar.
//
// The window holds the sidecar's cookie, so it stays on a sidecar page only while the process behind the port
// is the one that proved it holds the token. When the sidecar exits, every window on its origin leaves it: the
// dashboard window goes to the bundled splash and the others close. The session loads again, with a fresh
// bootstrap, only after the restarted process proves the token. A proof that never comes leaves the window on
// the splash with its status set.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::{bootstrap_url, health_ok, main_window_may_navigate, show_splash_status, ServerGaveUp};

/// What the dashboard window shows and when, for the sidecar behind it. Managed by the app.
pub(crate) struct Session {
    splash: Option<tauri::Url>,
    opened: AtomicBool,
    restarts: AtomicU64,
    status: Mutex<Option<&'static str>>,
}

impl Session {
    /// `window_url` is where the dashboard window starts: its bundled splash.
    pub(crate) fn new(window_url: Option<tauri::Url>, dev_url: Option<&tauri::Url>) -> Self {
        Self {
            splash: window_url.filter(|url| is_splash_page(url, dev_url)),
            opened: AtomicBool::new(false),
            restarts: AtomicU64::new(0),
            status: Mutex::new(None),
        }
    }

    /// The window loads the sidecar's session from here on.
    pub(crate) fn mark_opened(&self) {
        self.opened.store(true, Ordering::SeqCst);
    }

    /// The status line the splash shows; written again whenever the splash loads.
    pub(crate) fn set_status(&self, text: Option<&'static str>) {
        *self.status.lock().unwrap() = text;
    }

    pub(crate) fn status(&self) -> Option<&'static str> {
        *self.status.lock().unwrap()
    }
}

/// Whether `url` is one of the app's own pages the window can wait on: not a sidecar page, `about:` or a
/// non-web scheme.
fn is_splash_page(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    matches!(url.scheme(), "tauri" | "http" | "https") && main_window_may_navigate(url, None, dev_url)
}

/// What the dashboard window and its siblings do for the session.
pub(crate) trait SessionWindows {
    /// Every window on the sidecar's origin leaves it, and the splash shows `text`.
    fn leave_server(&self, text: &'static str);
    /// The splash shows `text`.
    fn show_splash(&self, text: &'static str);
    /// The dashboard window loads the sidecar's session from `bootstrap_url`.
    fn load_session(&self, bootstrap_url: String);
}

impl SessionWindows for AppHandle {
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
        });
        show_splash_status(self, text);
    }

    fn show_splash(&self, text: &'static str) {
        show_splash_status(self, text);
    }

    fn load_session(&self, bootstrap_url: String) {
        if let Some(session) = self.try_state::<Session>() {
            session.set_status(None);
        }
        let handle = self.clone();
        let _ = self.run_on_main_thread(move || {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.eval(&format!("window.location.replace('{bootstrap_url}')"));
            }
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
    let Some(session) = app.try_state::<Session>() else {
        return 0;
    };
    let restart = session.restarts.fetch_add(1, Ordering::SeqCst) + 1;
    if session.opened.load(Ordering::SeqCst) {
        app.leave_server(server.texts.restarting);
    }
    restart
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
        let superseded = || session.restarts.load(Ordering::SeqCst) != restart;
        let gave_up = || app.state::<ServerGaveUp>().0.load(Ordering::SeqCst);
        let proved = resume_session(
            &app,
            &server,
            |windows| windows.show_splash(server.texts.slow),
            || superseded() || gave_up() || quitting.load(Ordering::SeqCst),
        );
        if !proved && !superseded() && !quitting.load(Ordering::SeqCst) && gave_up() {
            app.show_splash(server.texts.stopped);
        }
    });
}

/// Wait for the restarted server's proof, then load its session. A server that never proves gets no session.
pub(crate) fn resume_session<W: SessionWindows>(
    windows: &W,
    server: &ServerSession,
    on_slow: impl Fn(&W),
    stop: impl Fn() -> bool,
) -> bool {
    let proved = wait_for_proof(server.port, &server.token, server.pace, stop, || on_slow(windows));
    if proved {
        windows.load_session(bootstrap_url(server.port, &server.token, None));
    }
    proved
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::io::Write;

    use super::*;
    use crate::tests::read_request_from;
    use crate::proof_of;

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

    /// Records what the windows were told, in order.
    #[derive(Default)]
    struct Recorder(RefCell<Vec<String>>);

    impl SessionWindows for Recorder {
        fn leave_server(&self, text: &'static str) {
            self.0.borrow_mut().push(format!("leave: {text}"));
        }
        fn show_splash(&self, text: &'static str) {
            self.0.borrow_mut().push(format!("splash: {text}"));
        }
        fn load_session(&self, bootstrap_url: String) {
            self.0.borrow_mut().push(format!("session: {bootstrap_url}"));
        }
    }

    /// A server that answers every request on its port with `token`'s proof for that request, or a wrong one.
    fn serve_health(token: &'static str, honest: bool) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let request = read_request_from(&mut stream);
                let challenge = request
                    .lines()
                    .find_map(|l| l.strip_prefix("x-piwi-desktop-challenge: "))
                    .unwrap_or_default()
                    .to_string();
                let proof = if honest { proof_of(token, port, &challenge) } else { proof_of("other", port, &challenge) };
                let _ = stream.write_all(
                    format!("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\nx-piwi-desktop-proof: {proof}\r\n\r\n{{}}")
                        .as_bytes(),
                );
            }
        });
        port
    }

    #[test]
    fn the_session_loads_after_the_restarted_server_proves_the_token() {
        let port = serve_health("pd_token", true);
        let windows = Recorder::default();
        let proved = resume_session(&windows, &server(port, "pd_token"), |w| w.show_splash("slow"), || false);
        assert!(proved);
        assert_eq!(
            *windows.0.borrow(),
            vec![format!("session: http://127.0.0.1:{port}/__piwi/session?token=pd_token")]
        );
    }

    #[test]
    fn a_server_that_cannot_prove_the_token_gets_no_session() {
        let port = serve_health("pd_token", false);
        let windows = Recorder::default();
        let stops_after = std::cell::Cell::new(0);
        let proved = resume_session(
            &windows,
            &server(port, "pd_token"),
            |w| w.show_splash("slow"),
            || {
                stops_after.set(stops_after.get() + 1);
                stops_after.get() > 8
            },
        );
        assert!(!proved);
        let told = windows.0.borrow();
        assert_eq!(*told, vec!["splash: slow".to_string()]);
        assert!(told.iter().all(|line| !line.starts_with("session")));
    }

    #[test]
    fn nothing_answering_leaves_the_windows_without_a_session() {
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let windows = Recorder::default();
        let proved = resume_session(&windows, &server(free, "pd_token"), |_| {}, || true);
        assert!(!proved);
        assert!(windows.0.borrow().is_empty());
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
}
