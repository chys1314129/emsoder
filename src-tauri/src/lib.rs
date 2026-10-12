//! EMSoder — Tauri shell.
//!
//! The shell is deliberately thin. It owns exactly what cannot live in Node:
//! native windows, the app menu, dialogs, DPAPI secret sealing, and the
//! high-volume push channel into the webview. Everything else — config,
//! sessions, the agent, tools, MCP, the PTY, the debugger — runs in the Node
//! host process, which is the Electron main process with its `electron`
//! imports redirected (see `desktop/host/`).
//!
//! ```text
//!  WebView2 (renderer/)  ⇄  Rust shell (src-tauri/)  ⇄  Node host (host/)  ⇄  Pi agent sidecar
//! ```

pub mod appwin;
pub mod helper;
pub mod menu;
pub mod paths;
pub mod rpc;
pub mod secrets;
mod shell_api;

use tauri::{Manager, RunEvent};

pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch should surface the
        // existing window rather than start a rival instance.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            appwin::focus_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(rpc::Tunnel::new())
        .invoke_handler(tauri::generate_handler![
            rpc::rpc,
            rpc::rpc_listen,
            rpc::ui_ready
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Window first, host second: the shell paints while Node boots,
            // which is what kept the Electron build feeling instant.
            let main = appwin::create_main(&handle)?;
            appwin::install_handlers(&handle, &main);

            #[cfg(debug_assertions)]
            main.open_devtools();

            // Fallback reveal: if the renderer is slow (Monaco is 13 MB of
            // JS), still surface the frame so the user knows it launched.
            let fallback = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1200));
                appwin::reveal(&fallback, appwin::MAIN);
            });

            menu::build(&handle)?;

            if let Err(err) = rpc::start_host(&handle) {
                eprintln!("[emsoder] 宿主进程启动失败：{err}");
                // Surface it rather than showing a dead UI.
                let handle_for_dialog = handle.clone();
                std::thread::spawn(move || {
                    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                    handle_for_dialog
                        .dialog()
                        .message(format!(
                            "无法启动后台进程，EMSoder 不能继续运行。\n\n{err}\n\n请确认 resources/skill-runtime/node/node.exe 存在，或系统 PATH 中有 node。"
                        ))
                        .title("EMSoder 启动失败")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                });
            }

            // Floating ball is opt-in, matching `floatingBallEnabled === true`.
            if paths::floating_ball_enabled() {
                match appwin::create_ball(&handle) {
                    Ok(_) => {
                        // The ball's page is tiny; reveal it once it has
                        // reported in (bridge calls ui_ready), with a fallback.
                        let ball_reveal = handle.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(600));
                            appwin::reveal(&ball_reveal, appwin::BALL);
                        });
                    }
                    Err(err) => eprintln!("[emsoder] 悬浮球创建失败：{err}"),
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("EMSoder 启动失败：无法构建 Tauri 应用")
        .run(|app, event| match event {
            RunEvent::ExitRequested { api, .. } => {
                let tunnel = app.state::<rpc::Tunnel>();
                // Already flushing (our own app.exit() re-enters this event), or
                // the host is gone and there is nothing left to flush.
                if tunnel.exit_guard_claimed() || !tunnel.host_alive() {
                    return;
                }
                // Let the host stop the agent, flush sessions/memories/quests and
                // stop MCP servers — the same ordering as the Electron
                // `before-quit` handler — before the process goes away.
                api.prevent_exit();
                graceful_exit(app);
            }
            RunEvent::Exit => {
                // Belt and braces: never leave a stray node process behind.
                app.state::<rpc::Tunnel>().shutdown(500);
            }
            _ => {}
        });
}

/// Flush the host and leave. Shared by the last-window-closed path, the Quit
/// menu item and any `app.quit()` from the host, so no exit route skips the
/// host's persistence flush.
///
/// Safe to call more than once: only the first caller acts, later re-entrant
/// calls (from our own `app.exit`) return immediately.
pub fn graceful_exit(app: &tauri::AppHandle) {
    let tunnel = app.state::<rpc::Tunnel>();
    if !tunnel.claim_exit() {
        return;
    }
    if tunnel.host_alive() {
        tunnel.emit_to_host("app:before-quit", serde_json::json!([]));
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        handle.state::<rpc::Tunnel>().shutdown(2500);
        handle.exit(0);
    });
}
