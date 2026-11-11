//! Windows taskbar thumbnail toolbar for the main window.
//!
//! Adds **Stop** and **Open** buttons under the taskbar-button thumbnail (the
//! little strip Windows shows when you hover the taskbar button) so a run can be
//! stopped, or the window reopened, without restoring the window — the
//! window-minimised/closed-to-tray case this whole feature is for.
//!
//! Windows-only, and reachable only through `ITaskbarList3` plus a window
//! subclass to receive the button clicks (Windows routes them as `WM_COMMAND`
//! with `THBN_CLICKED`, which Tauri does not surface). Clicks are turned into
//! app actions: **Open** restores, shows and focuses the window here in the
//! shell (`bring_to_front`); **Stop**, enabled only while a local run is running
//! (`set_stop_enabled`), emits `piwi:taskbar-stop`, which the dashboard's run
//! store listens for and stops its active runs (the shell does not own which
//! run is "current").
//!
//! NOTE: this module is compile-verified (native build + a Windows cross-check)
//! but its COM / subclass / GDI behaviour has not been exercised on a real
//! Windows desktop yet — it needs a functional pass there before being trusted.
#![cfg(windows)]

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::OnceLock;

use tauri::{AppHandle, Emitter as _, Manager as _, WebviewWindow};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, TRUE, WPARAM};
use windows::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject, HGDIOBJ};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{
    DefSubclassProc, ITaskbarList3, SetWindowSubclass, TaskbarList, THB_FLAGS, THB_ICON,
    THB_TOOLTIP, THBF_DISABLED, THBF_ENABLED, THUMBBUTTON, THUMBBUTTONFLAGS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateIconIndirect, RegisterWindowMessageW, HICON, ICONINFO, WM_COMMAND,
};

/// Command ids for the two thumb buttons (arbitrary, distinct, app-private).
const ID_STOP: u16 = 0xB001;
const ID_OPEN: u16 = 0xB002;
/// `WM_COMMAND` high word for a thumb-button click (`THBN_CLICKED`).
const THBN_CLICKED: u32 = 0x1800;
/// Subclass id — any constant, unique within this window's subclasses.
const SUBCLASS_ID: usize = 0x7177_0001;

/// The registered `TaskbarButtonCreated` message id — the signal that the
/// taskbar button now exists and buttons may be added. Resolved once.
static TASKBAR_BUTTON_CREATED: OnceLock<u32> = OnceLock::new();
/// Thumb buttons can be *added* only once per window; later changes must go
/// through `ThumbBarUpdateButtons`. Guards against a second add.
static BUTTONS_ADDED: AtomicBool = AtomicBool::new(false);
/// The window the buttons were added to, as its handle's address; 0 until they are.
static BUTTONS_WINDOW: AtomicUsize = AtomicUsize::new(0);
/// Whether **Stop** is enabled: while a local run is running (`set_stop_enabled`).
static STOP_ENABLED: AtomicBool = AtomicBool::new(false);

/// Which glyph a thumb button shows.
#[derive(Clone, Copy)]
enum Glyph {
    /// A filled square — "stop".
    Stop,
    /// A square outline — "open the window".
    Open,
}

/// Install the thumbnail toolbar on the main window. Best-effort: any failure
/// (no HWND, COM unavailable) simply leaves the taskbar button without buttons.
pub fn install(window: &WebviewWindow) {
    let Ok(handle) = window.hwnd() else {
        return;
    };
    // Tauri gives the handle as the HWND of the `windows` version it depends on: the same pointer.
    let hwnd = HWND(handle.0);
    // Leak one AppHandle clone as the subclass's ref-data; it lives for the whole
    // process, so there is nothing to free.
    let app: Box<AppHandle> = Box::new(window.app_handle().clone());
    let ref_data = Box::into_raw(app) as usize;

    unsafe {
        // COM apartment for ITaskbarList3. tao already initialises one on the main
        // thread; this is a harmless no-op / RPC_E_CHANGED_MODE if so.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let _ = TASKBAR_BUTTON_CREATED.set(RegisterWindowMessageW(w!("TaskbarButtonCreated")));
        let _ = SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, ref_data);
        // The taskbar button usually exists by the time setup runs, so try now;
        // if it does not, the TaskbarButtonCreated message will drive it later.
        add_buttons(hwnd);
    }
}

/// Window subclass: watch for the taskbar button coming into existence and for
/// thumb-button clicks; defer everything else.
unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    ref_data: usize,
) -> LRESULT {
    if TASKBAR_BUTTON_CREATED.get().is_some_and(|m| *m == msg) {
        add_buttons(hwnd);
    } else if msg == WM_COMMAND && ((wparam.0 >> 16) & 0xFFFF) as u32 == THBN_CLICKED {
        let command = (wparam.0 & 0xFFFF) as u16;
        // Safe: `ref_data` is the AppHandle pointer set in `install`, valid for
        // the life of the process.
        let app = &*(ref_data as *const AppHandle);
        match command {
            ID_STOP => {
                let _ = app.emit("piwi:taskbar-stop", ());
            }
            ID_OPEN => {
                if let Some(window) = app.get_webview_window("main") {
                    crate::bring_to_front(&window);
                }
            }
            _ => {}
        }
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

/// The shell's taskbar list, initialised; `None` when COM gives none.
unsafe fn taskbar_list() -> Option<ITaskbarList3> {
    let taskbar: ITaskbarList3 = CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER).ok()?;
    taskbar.HrInit().ok()?;
    Some(taskbar)
}

/// Add the Stop/Open buttons to the window's taskbar thumbnail, once; Stop as
/// `set_stop_enabled` last left it.
unsafe fn add_buttons(hwnd: HWND) {
    if BUTTONS_ADDED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(taskbar) = taskbar_list() else {
        // Allow a later attempt (e.g. on TaskbarButtonCreated) to retry.
        BUTTONS_ADDED.store(false, Ordering::SeqCst);
        return;
    };
    let buttons = [
        thumb_button(
            ID_STOP,
            Glyph::Stop,
            "Stop run",
            STOP_ENABLED.load(Ordering::SeqCst),
        ),
        thumb_button(ID_OPEN, Glyph::Open, "Open Piwi Desktop", true),
    ];
    if taskbar.ThumbBarAddButtons(hwnd, &buttons).is_ok() {
        BUTTONS_WINDOW.store(hwnd.0 as usize, Ordering::SeqCst);
    }
}

/// Enable the thumbnail's **Stop** while a local run is running, and disable it
/// while none is. On the main thread, which owns the window the buttons are on;
/// before they are added, `add_buttons` reads the state it leaves.
pub fn set_stop_enabled(running: bool) {
    if STOP_ENABLED.swap(running, Ordering::SeqCst) == running {
        return;
    }
    let window = BUTTONS_WINDOW.load(Ordering::SeqCst);
    if window == 0 {
        return;
    }
    let stop = THUMBBUTTON {
        dwMask: THB_FLAGS,
        iId: ID_STOP as u32,
        dwFlags: button_flags(running),
        ..Default::default()
    };
    unsafe {
        if let Some(taskbar) = taskbar_list() {
            let _ = taskbar.ThumbBarUpdateButtons(HWND(window as *mut c_void), &[stop]);
        }
    }
}

/// A thumb button's flags: clickable, or greyed out.
fn button_flags(enabled: bool) -> THUMBBUTTONFLAGS {
    if enabled {
        THBF_ENABLED
    } else {
        THBF_DISABLED
    }
}

/// Build one `THUMBBUTTON` with an icon, tooltip and its enabled state.
fn thumb_button(id: u16, glyph: Glyph, tip: &str, enabled: bool) -> THUMBBUTTON {
    let mut button = THUMBBUTTON {
        dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
        iId: id as u32,
        dwFlags: button_flags(enabled),
        ..Default::default()
    };
    if let Some(icon) = make_icon(glyph) {
        button.hIcon = icon;
    }
    // Leave the final slot as the NUL terminator.
    let max = button.szTip.len() - 1;
    for (slot, unit) in button.szTip.iter_mut().zip(tip.encode_utf16().take(max)) {
        *slot = unit;
    }
    button
}

/// A 16×16 white glyph as an `HICON`. Drawn in white (channel order is
/// irrelevant) and symmetric (top-down vs bottom-up is irrelevant) so the two
/// details that are easy to get wrong for a Windows bitmap do not matter here.
fn make_icon(glyph: Glyph) -> Option<HICON> {
    const SIZE: i32 = 16;
    let n = SIZE as usize;
    // BGRA, premultiplied — white with a per-pixel alpha mask.
    let mut bits = vec![0u8; n * n * 4];
    let put = |bits: &mut [u8], x: usize, y: usize| {
        let i = (y * n + x) * 4;
        bits[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
    };
    let lo = n / 4; // inset border
    let hi = n - lo - 1;
    match glyph {
        Glyph::Stop => {
            for y in lo..=hi {
                for x in lo..=hi {
                    put(&mut bits, x, y);
                }
            }
        }
        Glyph::Open => {
            for t in lo..=hi {
                put(&mut bits, t, lo); // top
                put(&mut bits, t, hi); // bottom
                put(&mut bits, lo, t); // left
                put(&mut bits, hi, t); // right
            }
        }
    }

    unsafe {
        let color = CreateBitmap(SIZE, SIZE, 1, 32, Some(bits.as_ptr().cast()));
        if color.is_invalid() {
            return None;
        }
        // A zeroed AND-mask: the colour bitmap's own alpha does the shaping.
        let mask_bits = vec![0u8; n * n];
        let mask = CreateBitmap(SIZE, SIZE, 1, 1, Some(mask_bits.as_ptr().cast()));
        let info = ICONINFO {
            fIcon: TRUE,
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: mask,
            hbmColor: color,
        };
        let icon = CreateIconIndirect(&info);
        // CreateIconIndirect copies the bitmaps; free ours either way.
        let _ = DeleteObject(HGDIOBJ(color.0));
        let _ = DeleteObject(HGDIOBJ(mask.0));
        icon.ok()
    }
}
