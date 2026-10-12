//! Window lifecycle: the main window, the floating ball, and the close handshake.
//!
//! Geometry and the ball toggle come from `emsoder-config.json` (see `paths`),
//! because they are needed before the Node host exists. Everything afterwards —
//! the close handshake in particular — is driven by the host, mirroring the
//! Electron build's split (`src/main/main.js`).

use serde_json::json;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::rpc::Tunnel;

pub const MAIN: &str = "main";
pub const BALL: &str = "ball";

/// Logical (DIP) work area of the primary monitor.
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn work_area(app: &AppHandle) -> Rect {
    const FALLBACK: Rect = Rect { x: 0.0, y: 0.0, width: 1280.0, height: 800.0 };
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return FALLBACK;
    };
    let scale = monitor.scale_factor();
    let monitor_pos = monitor.position();
    let (x, y) = (monitor_pos.x as f64 / scale, monitor_pos.y as f64 / scale);
    // `work_area()` is a PhysicalRect, so convert to logical (DIP) to match the
    // units Electron reported and the units the window builders expect.
    let area = monitor.work_area();
    let (ax, ay) = (area.position.x as f64 / scale, area.position.y as f64 / scale);
    let (aw, ah) = (area.size.width as f64 / scale, area.size.height as f64 / scale);
    // A monitor whose work area is unset reports zeroes on some drivers.
    if aw <= 0.0 || ah <= 0.0 {
        let s = monitor.size();
        return Rect {
            x,
            y,
            width: s.width as f64 / scale,
            height: s.height as f64 / scale,
        };
    }
    Rect { x: ax, y: ay, width: aw, height: ah }
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

pub fn ball_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(BALL)
}

/// Create the main window. Starts hidden; `reveal` shows it once the renderer
/// has painted, and `lib.rs` arms a 1200 ms fallback so a slow Monaco load can
/// never leave the user staring at nothing.
pub fn create_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let (x, y, w, h) =
        crate::paths::window_bounds().unwrap_or((f64::NAN, f64::NAN, 1440.0, 900.0));
    let mut builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("EMSoder")
        .inner_size(w, h)
        .min_inner_size(960.0, 640.0)
        .visible(false);
    if x.is_finite() && y.is_finite() {
        builder = builder.position(x, y);
    }
    builder.build()
}

/// Create the floating ball: frameless, transparent, always on top, off the
/// taskbar, parked bottom-right of the work area.
pub fn create_ball(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let area = work_area(app);
    let (w, h) = (132.0, 44.0);
    WebviewWindowBuilder::new(app, BALL, WebviewUrl::App("ball.html".into()))
        .title("EMSoder Ball")
        .inner_size(w, h)
        .position(area.x + area.width - w - 24.0, area.y + area.height - h - 60.0)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .shadow(false)
        .visible(false)
        .build()
}

/// Show a window that has finished loading, and lift it in front.
pub fn reveal(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Bring the main window back to the front (the `app:show-main` path used by
/// the floating ball).
pub fn focus_main(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn destroy(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        // destroy(), not close(): the close handshake already ran, and going
        // through CloseRequested again would re-ask the renderer forever.
        let _ = window.destroy();
    }
}

/// Current outer geometry in Electron's DIP convention, for the host's
/// `getBounds()` cache and for `windowBounds` persistence.
pub fn bounds(app: &AppHandle, label: &str) -> Option<serde_json::Value> {
    let window = app.get_webview_window(label)?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(json!({
        "x": (pos.x as f64 / scale).round(),
        "y": (pos.y as f64 / scale).round(),
        "width": (size.width as f64 / scale).round(),
        "height": (size.height as f64 / scale).round(),
    }))
}

/// Wire the main window's events: close handshake, geometry reporting, and
/// tearing the ball down with it.
pub fn install_handlers(app: &AppHandle, window: &WebviewWindow) {
    let handle = app.clone();
    window.on_window_event(move |event| {
        let tunnel = handle.state::<Tunnel>();
        match event {
            // The host owns the handshake (save bounds → tell the renderer →
            // 3 s failsafe → destroy). We only stop the native close and hand
            // over, so all of that logic stays in one place.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if let Some(b) = bounds(&handle, MAIN) {
                    tunnel.emit_to_host("window:bounds", json!([{ "kind": MAIN, "bounds": b }]));
                }
                tunnel.emit_to_host("app:before-close", json!([]));
            }
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                if let Some(b) = bounds(&handle, MAIN) {
                    tunnel.emit_to_host("window:bounds", json!([{ "kind": MAIN, "bounds": b }]));
                }
            }
            tauri::WindowEvent::Destroyed => {
                if let Some(ball) = ball_window(&handle) {
                    let _ = ball.destroy();
                }
            }
            _ => {}
        }
    });
}
