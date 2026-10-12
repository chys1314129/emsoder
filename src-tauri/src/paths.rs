//! Local (Rust-side) reads of paths and the handful of config fields the shell
//! needs before the Node host is up.
//!
//! Window geometry and the floating-ball toggle have to be known *before* the
//! first window is created, and the host is started after — so the shell reads
//! `emsoder-config.json` itself. Only these two plain keys are read; every
//! secret in that file stays sealed and is the host's business.

use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::Manager as _;

/// Electron's `app.getPath("userData")` — `%APPDATA%\EMSoder`.
///
/// Deliberately *not* Tauri's `app_data_dir()` (which would be
/// `%APPDATA%\com.emsoder.desktop`): reusing Electron's directory is what lets
/// an existing install keep its config, sessions, memories and API keys.
pub fn user_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("EMSODER_USER_DATA") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.is_empty() {
            return Path::new(&appdata).join("EMSoder");
        }
    }
    std::env::temp_dir().join("EMSoder")
}

/// Strip Windows' verbatim (`\\?\`) prefix from a path.
///
/// `resource_dir()` hands back a canonicalized path, i.e. `\\?\D:\...`, and that
/// prefix must not be passed to a child process: Node cannot use it as an entry
/// script and fails with `EISDIR: lstat 'D:'` (the path collapses to the drive
/// letter). This only ever bit the **release** build, because the dev branch
/// below builds paths from `CARGO_MANIFEST_DIR`, which has no prefix.
///
/// `\\?\UNC\server\share` becomes `\\server\share`, mirroring `dunce::simplified`
/// — hand-rolled here because it is a dozen lines and one less dependency.
pub fn simplify(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

/// Development build: the repo's own `resources/` and `host/` directories.
/// Release build: bundled resources next to the exe.
pub fn resources_dir(app: &tauri::AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        // src-tauri/ -> desktop/
        let project = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let res = project.join("resources");
        if res.is_dir() {
            return res;
        }
    }
    simplify(
        app.path()
            .resource_dir()
            .unwrap_or_else(|_| PathBuf::from(".")),
    )
}

fn config_path() -> PathBuf {
    user_data_dir().join("emsoder-config.json")
}

fn read_config_json() -> Option<Value> {
    let raw = std::fs::read_to_string(config_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

/// `{ x, y, width, height }` of the last main-window geometry, if recorded.
pub fn window_bounds() -> Option<(f64, f64, f64, f64)> {
    let cfg = read_config_json()?;
    let b = cfg.get("windowBounds")?.clone();
    let get = |k: &str| b.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
    let w = get("width").unwrap_or(1440.0);
    let h = get("height").unwrap_or(900.0);
    let x = get("x");
    let y = get("y");
    Some((x.unwrap_or(f64::NAN), y.unwrap_or(f64::NAN), w, h))
}

/// The floating ball is opt-in and defaults to off, matching the renderer's
/// `floatingBallEnabled === true` check.
pub fn floating_ball_enabled() -> bool {
    read_config_json()
        .and_then(|c| c.get("floatingBallEnabled").and_then(Value::as_bool))
        .unwrap_or(false)
}
