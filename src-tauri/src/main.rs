// Prevents an extra console window on Windows in release builds. The DPAPI
// helper mode still works: the host spawns this exe with redirected pipes, and
// redirected standard handles are honoured regardless of the subsystem flag.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Helper modes must short-circuit before any GUI/Tauri initialisation —
    // the host calls this same binary synchronously to seal config secrets.
    if let Some(code) = emsoder_lib::helper::try_run() {
        std::process::exit(code);
    }
    emsoder_lib::run();
}
