//! Native application menu — the Tauri equivalent of `buildMenu()` in
//! `src/main/main.js`, menu for menu and accelerator for accelerator.
//!
//! Every click is forwarded to the Node host as `menu:<id>`. The host then
//! decides, exactly as the Electron main process did: renderer-only items are
//! broadcast to the webview on the same `menu:*` channel the renderer already
//! listens on, and main-process items (open folder, test provider, about) run
//! their logic in the host.

use serde_json::json;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Manager};

use crate::rpc::Tunnel;

/// Build a menu item, dropping the accelerator rather than failing if the
/// string does not parse (e.g. `Ctrl+``). A bad shortcut must never stop the
/// app from starting.
fn item(
    app: &AppHandle,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
    if let Some(accel) = accelerator {
        if let Ok(built) = MenuItemBuilder::with_id(id, label).accelerator(accel).build(app) {
            return Ok(built);
        }
        eprintln!("[emsoder] 快捷键无法解析，已忽略：{accel}");
    }
    MenuItemBuilder::with_id(id, label).build(app)
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let file = SubmenuBuilder::new(app, "文件")
        .item(&item(app, "open-workspace", "打开文件夹…", Some("CmdOrCtrl+O"))?)
        .item(&item(app, "open-file", "打开文件…", Some("CmdOrCtrl+P"))?)
        .separator()
        .item(&item(app, "save", "保存", Some("CmdOrCtrl+S"))?)
        .separator()
        // A custom Quit rather than `PredefinedMenuItem::quit`: the predefined
        // item terminates the app directly, skipping the host's flush of
        // sessions/memories/quests. This one routes through `graceful_exit`.
        .item(&item(app, "quit", "退出", Some("CmdOrCtrl+Q"))?)
        .build()?;

    // Native roles: undo/redo/cut/copy/paste/select-all keep working in Monaco
    // and the chat input without any renderer involvement.
    let edit = SubmenuBuilder::new(app, "编辑")
        .item(&PredefinedMenuItem::undo(app, Some("撤销"))?)
        .item(&PredefinedMenuItem::redo(app, Some("重做"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("剪切"))?)
        .item(&PredefinedMenuItem::copy(app, Some("复制"))?)
        .item(&PredefinedMenuItem::paste(app, Some("粘贴"))?)
        .item(&PredefinedMenuItem::select_all(app, Some("全选"))?)
        .build()?;

    let view = SubmenuBuilder::new(app, "视图")
        .item(&item(app, "toggle-sidebar", "切换 AI 侧栏", Some("CmdOrCtrl+Shift+L"))?)
        .item(&item(app, "toggle-bottom", "切换底部面板", Some("CmdOrCtrl+J"))?)
        .item(&item(app, "show-terminal", "终端", Some("Ctrl+`"))?)
        .item(&item(app, "show-git", "Git 面板", None)?)
        .item(&item(app, "new-chat", "新对话", Some("CmdOrCtrl+N"))?)
        .separator()
        .item(&item(app, "reload-ui", "重新加载", Some("CmdOrCtrl+R"))?)
        .item(&item(app, "toggle-devtools", "开发者工具", Some("CmdOrCtrl+Shift+I"))?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, Some("全屏"))?)
        .build()?;

    let ai = SubmenuBuilder::new(app, "AI")
        .item(&item(app, "add-selection", "选区加入对话", Some("CmdOrCtrl+Shift+K"))?)
        .item(&item(app, "explain-selection", "解释选区", None)?)
        .item(&item(app, "inline-edit", "Inline Edit", Some("CmdOrCtrl+I"))?)
        .item(&item(app, "gen-commit", "生成 Commit Message", None)?)
        .build()?;

    let model = SubmenuBuilder::new(app, "模型")
        .item(&item(app, "select-model", "选择模型…", None)?)
        .item(&item(app, "providers", "管理服务商…", None)?)
        .item(&item(app, "test-provider", "测试当前服务商", None)?)
        .build()?;

    let help = SubmenuBuilder::new(app, "帮助")
        .item(&item(app, "about", "关于 EMSoder", None)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&file, &edit, &view, &ai, &model, &help])
        .build()?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let id = event.id().as_ref().to_string();
        let tunnel = app.state::<Tunnel>();

        // Rust-owned items act immediately; the host never sees them.
        match id.as_str() {
            "quit" => {
                // Close the main window rather than exiting outright, so the
                // renderer's unsaved-tab handshake still runs and the exit goes
                // through the same flush path as clicking the window's X.
                match crate::appwin::main_window(app) {
                    Some(window) => {
                        let _ = window.close();
                    }
                    None => crate::graceful_exit(app),
                }
                return;
            }
            "reload-ui" => {
                if let Some(window) = crate::appwin::main_window(app) {
                    let _ = window.eval("location.reload()");
                }
                return;
            }
            "toggle-devtools" => {
                if let Some(window) = crate::appwin::main_window(app) {
                    if window.is_devtools_open() {
                        window.close_devtools();
                    } else {
                        window.open_devtools();
                    }
                }
                return;
            }
            _ => {}
        }

        tunnel.emit_to_host(&format!("menu:{id}"), json!([]));
    });

    Ok(())
}
