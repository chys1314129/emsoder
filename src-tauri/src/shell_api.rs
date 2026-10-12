//! Reverse RPC: requests the Node host makes *to* the shell.
//!
//! The host is the Electron main process reincarnated, so its `dialog`,
//! `shell`, `screen` and `BrowserWindow` calls have to land somewhere. They
//! arrive here as `{"t":"req","id":..,"ch":..,"args":[..]}` and are answered
//! with `{"t":"res",...}` in Electron's own return shapes, so the ported host
//! code keeps working unchanged:
//!
//! * `dialog.open`    -> `{ canceled, filePaths[] }`
//! * `dialog.save`    -> `{ canceled, filePath }`
//! * `dialog.message` -> `{ response: number }`
//! * `screen.workArea`-> `{ x, y, width, height }`
//!
//! Replies from async callbacks go through a cloned `AppHandle` (not a captured
//! `State`, which borrows and cannot outlive the call).

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::rpc::Tunnel;
use crate::{appwin, paths};

pub fn handle(app: &AppHandle, msg: &Value) {
    let id = msg
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let channel = msg
        .get("ch")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let args = msg.get("args").cloned().unwrap_or_else(|| json!([]));
    let tunnel = app.state::<Tunnel>();

    match channel.as_str() {
        // ---- fire and forget -------------------------------------------
        "shell.openExternal" => {
            let target = arg_str(&args, 0).unwrap_or_default();
            // Same allow-list as the Electron build: http(s) only. Anything
            // else (file:, javascript:, custom schemes) is dropped, otherwise a
            // click on `file://…` in Monaco or markdown would hand the path to
            // a Windows shell handler.
            match scheme::classify(&target) {
                Some(scheme::Kind::Http) => {
                    use tauri_plugin_opener::OpenerExt;
                    if let Err(err) = app.opener().open_url(target.clone(), None::<&str>) {
                        eprintln!("[emsoder] 打开链接失败：{err}");
                    }
                }
                other => eprintln!("[emsoder] 拦截打开非 http(s) 链接：{other:?} {target}"),
            }
            tunnel.reply(&id, Ok(Value::Null));
        }

        // ---- synchronous queries ---------------------------------------
        "screen.workArea" => {
            let area = appwin::work_area(app);
            tunnel.reply(
                &id,
                Ok(json!({
                    "x": area.x, "y": area.y,
                    "width": area.width, "height": area.height,
                })),
            );
        }
        "app.info" => {
            tunnel.reply(
                &id,
                Ok(json!({
                    "version": app.package_info().version.to_string(),
                    "userData": paths::user_data_dir().to_string_lossy(),
                    "resources": paths::resources_dir(app).to_string_lossy(),
                })),
            );
        }
        "window.bounds" => {
            let kind = arg_str(&args, 0).unwrap_or_else(|| appwin::MAIN.to_string());
            let value = appwin::bounds(app, &kind).unwrap_or(Value::Null);
            tunnel.reply(&id, Ok(value));
        }

        // ---- window operations -----------------------------------------
        "window.ensure" => {
            let kind = arg_str(&args, 0).unwrap_or_else(|| appwin::MAIN.to_string());
            let handle = app.clone();
            let reply_id = id.clone();
            // Windows must be built on the main thread.
            if let Err(err) = app.run_on_main_thread(move || {
                let tunnel = handle.state::<Tunnel>();
                let existing = if kind == appwin::BALL {
                    appwin::ball_window(&handle)
                } else {
                    appwin::main_window(&handle)
                };
                if let Some(window) = existing {
                    tunnel.reply(&reply_id, Ok(json!({ "created": false, "label": window.label() })));
                    return;
                }
                let created = if kind == appwin::BALL {
                    appwin::create_ball(&handle)
                } else {
                    appwin::create_main(&handle)
                };
                match created {
                    Ok(window) => {
                        if kind == appwin::MAIN {
                            appwin::install_handlers(&handle, &window);
                        }
                        tunnel.reply(
                            &reply_id,
                            Ok(json!({ "created": true, "label": window.label() })),
                        );
                    }
                    Err(err) => tunnel.reply(&reply_id, Err(format!("创建窗口失败：{err}"))),
                }
            }) {
                tunnel.reply(&id, Err(format!("无法在主线程创建窗口：{err}")));
            }
        }
        "window.show" => {
            let kind = arg_str(&args, 0).unwrap_or_else(|| appwin::MAIN.to_string());
            appwin::reveal(app, &kind);
            tunnel.reply(&id, Ok(Value::Null));
        }
        "window.focus-main" => {
            appwin::focus_main(app);
            tunnel.reply(&id, Ok(Value::Null));
        }
        "window.destroy" => {
            let kind = arg_str(&args, 0).unwrap_or_else(|| appwin::MAIN.to_string());
            appwin::destroy(app, &kind);
            tunnel.reply(&id, Ok(Value::Null));
        }
        "window.set-always-on-top" => {
            let kind = arg_str(&args, 0).unwrap_or_else(|| appwin::BALL.to_string());
            let on = arg_bool(&args, 1).unwrap_or(true);
            if let Some(window) = app.get_webview_window(&kind) {
                let _ = window.set_always_on_top(on);
            }
            tunnel.reply(&id, Ok(Value::Null));
        }

        // ---- app lifecycle ---------------------------------------------
        "app.quit" => {
            tunnel.reply(&id, Ok(Value::Null));
            // Route through the flush path rather than `exit(0)`: the host gets
            // its `app:before-quit` and a grace period to persist state.
            crate::graceful_exit(app);
        }

        // ---- dialogs (async: the callback answers the host later) -------
        "dialog.open" => handle_open_dialog(app, &id, &args),
        "dialog.save" => handle_save_dialog(app, &id, &args),
        "dialog.message" => handle_message_dialog(app, &id, &args),

        other => {
            tunnel.reply(&id, Err(format!("未知的反向通道：{other}")));
        }
    }
}

fn arg_str(args: &Value, index: usize) -> Option<String> {
    args.get(index).and_then(Value::as_str).map(str::to_string)
}

fn arg_bool(args: &Value, index: usize) -> Option<bool> {
    args.get(index).and_then(Value::as_bool)
}

fn reply_paths(app: &AppHandle, id: &str, paths: Vec<String>) {
    let canceled = paths.is_empty();
    app.state::<Tunnel>()
        .reply(id, Ok(json!({ "canceled": canceled, "filePaths": paths })));
}

/// `dialog.showOpenDialog(win, { properties, defaultPath, title })`
fn handle_open_dialog(app: &AppHandle, id: &str, args: &Value) {
    let options = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let properties: Vec<String> = options
        .get("properties")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let directory = properties.iter().any(|p| p == "openDirectory");
    let multiple = properties.iter().any(|p| p == "multiSelections");

    let mut builder = app.dialog().file();
    if let Some(title) = options.get("title").and_then(Value::as_str) {
        builder = builder.set_title(title);
    }
    if let Some(default_path) = options.get("defaultPath").and_then(Value::as_str) {
        if !default_path.is_empty() {
            builder = builder.set_directory(default_path);
        }
    }

    let handle = app.clone();
    let reply_id = id.to_string();

    if directory {
        builder.pick_folder(move |folder| {
            let list = folder.map(|f| vec![f.to_string()]).unwrap_or_default();
            reply_paths(&handle, &reply_id, list);
        });
        return;
    }
    if multiple {
        builder.pick_files(move |files| {
            let list = files
                .map(|fs| fs.into_iter().map(|f| f.to_string()).collect())
                .unwrap_or_default();
            reply_paths(&handle, &reply_id, list);
        });
        return;
    }
    builder.pick_file(move |file| {
        let list = file.map(|f| vec![f.to_string()]).unwrap_or_default();
        reply_paths(&handle, &reply_id, list);
    });
}

/// `dialog.showSaveDialog(win, { title, defaultPath, filters })`
fn handle_save_dialog(app: &AppHandle, id: &str, args: &Value) {
    let options = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let mut builder = app.dialog().file();
    if let Some(title) = options.get("title").and_then(Value::as_str) {
        builder = builder.set_title(title);
    }
    if let Some(default_path) = options.get("defaultPath").and_then(Value::as_str) {
        if !default_path.is_empty() {
            // Electron's defaultPath is "folder + suggested filename"; the
            // plugin splits them.
            let as_path = std::path::Path::new(default_path);
            if let Some(dir) = as_path.parent() {
                if !dir.as_os_str().is_empty() {
                    builder = builder.set_directory(dir);
                }
            }
            if let Some(name) = as_path.file_name().and_then(|n| n.to_str()) {
                builder = builder.set_file_name(name);
            }
        }
    }
    if let Some(filters) = options.get("filters").and_then(Value::as_array) {
        for filter in filters {
            let Some(name) = filter.get("name").and_then(Value::as_str) else {
                continue;
            };
            let Some(exts) = filter.get("extensions").and_then(Value::as_array) else {
                continue;
            };
            let ext_refs: Vec<&str> = exts.iter().filter_map(Value::as_str).collect();
            if ext_refs.is_empty() {
                continue;
            }
            builder = builder.add_filter(name, &ext_refs);
        }
    }

    let handle = app.clone();
    let reply_id = id.to_string();
    builder.save_file(move |file| {
        let path = file.map(|f| f.to_string());
        let canceled = path.is_none();
        handle.state::<Tunnel>().reply(
            &reply_id,
            Ok(json!({ "canceled": canceled, "filePath": path })),
        );
    });
}

/// `dialog.showMessageBox(win, { type, title, message, detail, buttons })`
fn handle_message_dialog(app: &AppHandle, id: &str, args: &Value) {
    let options = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let title = options
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("EMSoder");
    let message = options
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let detail = options.get("detail").and_then(Value::as_str).unwrap_or("");
    // The plugin has no separate `detail` field; join it the way the native
    // dialog lays it out.
    let body = if detail.is_empty() {
        message.to_string()
    } else {
        format!("{message}\n\n{detail}")
    };
    let kind = match options.get("type").and_then(Value::as_str) {
        Some("error") => MessageDialogKind::Error,
        Some("warning") => MessageDialogKind::Warning,
        _ => MessageDialogKind::Info,
    };
    let buttons: Vec<String> = options
        .get("buttons")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_else(|| vec!["OK".to_string()]);
    let dialog_buttons = if buttons.len() >= 2 {
        MessageDialogButtons::OkCancelCustom(buttons[0].clone(), buttons[1].clone())
    } else {
        MessageDialogButtons::Ok
    };

    let handle = app.clone();
    let reply_id = id.to_string();
    app.dialog()
        .message(body)
        .title(title)
        .kind(kind)
        .buttons(dialog_buttons)
        .show(move |accepted| {
            // Electron reports the clicked button's index; 0 is the first.
            let response = if accepted { 0 } else { 1 };
            handle
                .state::<Tunnel>()
                .reply(&reply_id, Ok(json!({ "response": response })));
        });
}

/// URL scheme classifier — keeps the http(s) allow-list in one place without
/// pulling in a URL-parsing crate just to read a scheme.
mod scheme {
    #[derive(Debug, Clone, Copy)]
    pub enum Kind {
        Http,
        Other,
    }

    pub fn classify(raw: &str) -> Option<Kind> {
        let trimmed = raw.trim();
        let colon = trimmed.find(':')?;
        let name = &trimmed[..colon];
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
        {
            return None;
        }
        match name.to_ascii_lowercase().as_str() {
            "http" | "https" => Some(Kind::Http),
            _ => Some(Kind::Other),
        }
    }
}
