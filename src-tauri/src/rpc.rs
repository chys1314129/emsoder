//! The RPC tunnel between the three processes.
//!
//! ```text
//!  renderer (webview)          Rust shell              Node host
//!  ─────────────────           ──────────              ─────────
//!  invoke("rpc")        ──►    write line      ──►     handler runs
//!  await result         ◄──    pending map     ◄──     {"t":"res",...}
//!  Channel onmessage    ◄──    forward         ◄──     {"t":"ev",...}
//!                              reverse handler ◄──     {"t":"req",...} (dialogs, keys, windows)
//! ```
//!
//! Newline-delimited JSON, one object per line, in both directions — the same
//! framing `src/pi/protocol.js` already uses for the Pi agent sidecar, so the
//! codebase has one wire convention rather than two.
//!
//! Pushes go through a `tauri::ipc::Channel` rather than `emit`: the terminal
//! stream (`term:data`) and agent deltas are high-volume and ordered, and a
//! Channel is a direct, ordered pipe to the webview with no event-bus fan-out.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::paths;

/// Cross-platform "don't flash a console window" flag for child processes.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct Inner {
    stdin: Option<ChildStdin>,
    child: Option<Child>,
    pending: HashMap<String, tokio::sync::oneshot::Sender<Result<Value, String>>>,
}

pub struct Tunnel {
    inner: Mutex<Inner>,
    /// Push targets, keyed by window label ("main" / "ball").
    sinks: Mutex<Vec<(String, Channel<String>)>>,
    seq: AtomicU64,
    host_gone: AtomicBool,
    /// Set once the graceful-exit path has run, so re-entrant `ExitRequested`
    /// events cannot loop.
    exit_guard: AtomicBool,
}

impl Tunnel {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            sinks: Mutex::new(Vec::new()),
            seq: AtomicU64::new(0),
            host_gone: AtomicBool::new(false),
            exit_guard: AtomicBool::new(false),
        }
    }

    /// Pure read: has the graceful-exit path been claimed yet?
    ///
    /// Deliberately separate from `claim_exit`. Using one mutating call for both
    /// the "should I act?" check and the claim means the check consumes the flag
    /// and the actor then bails out — which is exactly how the app once managed
    /// to close every window and then never exit.
    pub fn exit_guard_claimed(&self) -> bool {
        self.exit_guard.load(Ordering::SeqCst)
    }

    /// Returns true for the first caller only.
    pub fn claim_exit(&self) -> bool {
        !self.exit_guard.swap(true, Ordering::SeqCst)
    }

    /// Webview asks a question and waits for the host's answer.
    ///
    /// `from` is the asking window's label. Electron's `event.sender` identified
    /// the caller, and IPC modules use that to push progress back to the window
    /// that asked (`event.sender.send`), so the identity has to survive the trip.
    ///
    /// Deliberately no timeout: an agent turn legitimately runs for minutes,
    /// and Electron's `ipcRenderer.invoke` had none either.
    pub async fn request(&self, channel: &str, args: Value, from: Option<&str>) -> Result<Value, String> {
        if self.host_gone.load(Ordering::SeqCst) {
            return Err("宿主进程已退出，请重启 EMSoder".into());
        }
        let id = format!("web-{}", self.seq.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.pending.insert(id.clone(), tx);
            let mut line = json!({ "t": "req", "id": id, "ch": channel, "args": args });
            if let Some(label) = from {
                line["from"] = json!(label);
            }
            let line = line.to_string();
            match inner.stdin.as_mut() {
                Some(stdin) => {
                    if writeln!(stdin, "{line}").is_err() || stdin.flush().is_err() {
                        inner.pending.remove(&id);
                        return Err("无法写入宿主进程（管道已断开）".into());
                    }
                }
                None => {
                    inner.pending.remove(&id);
                    return Err("宿主进程未启动".into());
                }
            }
        }
        match rx.await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(err)) => Err(err),
            Err(_) => Err("宿主进程在应答前退出".into()),
        }
    }

    /// Answer a request the host made to us.
    pub fn reply(&self, id: &str, result: Result<Value, String>) {
        let line = match result {
            Ok(value) => json!({ "t": "res", "id": id, "ok": true, "value": value }),
            Err(err) => json!({ "t": "res", "id": id, "ok": false, "error": err }),
        };
        self.write_line(&line.to_string());
    }

    /// Fire an event at the host (menu clicks, window geometry changes).
    pub fn emit_to_host(&self, channel: &str, args: Value) {
        let line = json!({ "t": "ev", "ch": channel, "args": args }).to_string();
        self.write_line(&line);
    }

    fn write_line(&self, line: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(stdin) = inner.stdin.as_mut() {
            if writeln!(stdin, "{line}").is_err() {
                drop(inner);
                self.mark_host_gone();
            } else {
                let _ = stdin.flush();
            }
        }
    }

    fn resolve(&self, id: &str, result: Result<Value, String>) {
        let tx = self.inner.lock().unwrap().pending.remove(id);
        if let Some(tx) = tx {
            let _ = tx.send(result);
        }
    }

    pub fn add_sink(&self, label: String, channel: Channel<String>) {
        let mut sinks = self.sinks.lock().unwrap();
        // A window that registers twice (a double script include, or a reload that
        // raced its own teardown) must not receive everything twice — replace its
        // previous sink instead of appending a second one.
        sinks.retain(|(existing, _)| existing != &label);
        sinks.push((label, channel));
    }

    /// Forward a host push to its destination window(s).
    ///
    /// `target` is the label the host addressed. Electron's `webContents.send`
    /// reached exactly one window, so a per-window send must not fan out to all
    /// of them: the host's broadcast loop sends once per window, and fanning each
    /// of those out again delivered every streamed chat message twice.
    ///
    /// A missing target means a genuine broadcast (the shell's own notices).
    fn fan_out(&self, line: &str, target: Option<&str>) {
        let sinks = self.sinks.lock().unwrap();
        for (label, sink) in sinks.iter() {
            if let Some(wanted) = target {
                if label != wanted {
                    continue;
                }
            }
            let _ = sink.send(line.to_string());
        }
    }

    fn mark_host_gone(&self) {
        if self.host_gone.swap(true, Ordering::SeqCst) {
            return;
        }
        let waiting = {
            let mut inner = self.inner.lock().unwrap();
            std::mem::take(&mut inner.pending)
        };
        for (_, tx) in waiting {
            let _ = tx.send(Err("宿主进程已退出，请重启 EMSoder".into()));
        }
        self.fan_out(
            &json!({ "t": "ev", "ch": "app:host-exit", "args": [{}] }).to_string(),
            None,
        );
    }

    pub fn host_alive(&self) -> bool {
        !self.host_gone.load(Ordering::SeqCst)
    }

    /// Politely ask the host to shut down, then force-kill if it dawdles.
    pub fn shutdown(&self, grace_ms: u64) {
        if self.host_alive() {
            self.emit_to_host("app:quit", Value::Array(vec![]));
        }
        let mut child = self.inner.lock().unwrap().child.take();
        let Some(child) = child.as_mut() else { return };
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(grace_ms);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                Err(_) => return,
            }
        }
    }
}

/// Where the Node host lives, and which Node runs it.
fn resolve_host_command(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    // Dev: run straight out of the repo. Release: `resources/runtime/` is built
    // by scripts/build-host.js and mirrors the repo layout (host/ next to src/),
    // because that is what the host's `require("../src/...")` expects.
    let host_script = if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("host").join("host.js"))
            .unwrap_or_else(|| PathBuf::from("host/host.js"))
    } else {
        paths::resources_dir(app)
            .join("runtime")
            .join("host")
            .join("host.js")
    };
    if !host_script.is_file() {
        return Err(format!("找不到宿主脚本：{}", host_script.display()));
    }

    // Prefer the bundled runtime (what the shipped app guarantees, and the ABI
    // node-pty's prebuilds are matched against); fall back to PATH for a dev
    // machine that has not vendored it.
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let bundled = paths::resources_dir(app)
        .join("skill-runtime")
        .join("node")
        .join(node_name);
    let node = if bundled.is_file() {
        bundled
    } else {
        PathBuf::from(node_name)
    };

    // Which runtime and script a packaged build actually resolves is the first
    // thing to establish when a built app starts with a dead host. Gated so it
    // costs nothing in normal runs.
    if std::env::var("EMSODER_DEBUG").as_deref() == Ok("1") {
        eprintln!("[emsoder] resources_dir = {}", paths::resources_dir(app).display());
        eprintln!("[emsoder] node          = {} (存在: {})", node.display(), node.is_file());
        eprintln!("[emsoder] host_script   = {} (存在: {})", host_script.display(), host_script.is_file());
    }
    Ok((node, host_script))
}

/// Spawn the Node host and start pumping the tunnel. Called from `setup`.
pub fn start_host(app: &AppHandle) -> Result<(), String> {
    let (node, host_script) = resolve_host_command(app)?;
    let resources = paths::resources_dir(app);
    let cwd = host_script
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let mut cmd = Command::new(&node);
    cmd.arg(&host_script)
        .current_dir(&cwd)
        .env("EMSODER_RESOURCES", &resources)
        .env("EMSODER_USER_DATA", paths::user_data_dir())
        .env("EMSODER_NODE", &node)
        .env(
            "EMSODER_APP_EXE",
            std::env::current_exe()
                .map(paths::simplify)
                .unwrap_or_else(|_| PathBuf::from("emsoder.exe")),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "无法启动宿主进程（{} {}）：{e}",
            node.display(),
            host_script.display()
        )
    })?;

    let stdin = child.stdin.take().ok_or("宿主 stdin 不可用")?;
    let stdout = child.stdout.take().ok_or("宿主 stdout 不可用")?;
    let stderr = child.stderr.take().ok_or("宿主 stderr 不可用")?;

    {
        let tunnel = app.state::<Tunnel>();
        let mut inner = tunnel.inner.lock().unwrap();
        inner.stdin = Some(stdin);
        inner.child = Some(child);
    }

    let app_out = app.clone();
    std::thread::Builder::new()
        .name("emsoder-host-stdout".into())
        .spawn(move || pump_stdout(app_out, stdout))
        .map_err(|e| e.to_string())?;

    let app_err = app.clone();
    std::thread::Builder::new()
        .name("emsoder-host-stderr".into())
        .spawn(move || pump_stderr(app_err, stderr))
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn pump_stdout(app: AppHandle, stdout: std::process::ChildStdout) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            eprintln!("[emsoder] 宿主输出了非法 JSON 行：{}", &line[..line.len().min(200)]);
            continue;
        };
        let tunnel = app.state::<Tunnel>();
        match msg.get("t").and_then(Value::as_str) {
            Some("res") => {
                let id = msg.get("id").and_then(Value::as_str).unwrap_or_default();
                let result = if msg.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                    Ok(msg.get("value").cloned().unwrap_or(Value::Null))
                } else {
                    Err(msg
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("未知错误")
                        .to_string())
                };
                tunnel.resolve(id, result);
            }
            Some("ev") => {
                let target = msg.get("to").and_then(Value::as_str);
                tunnel.fan_out(&line, target);
            }
            Some("req") => {
                crate::shell_api::handle(&app, &msg);
            }
            _ => {}
        }
    }
    app.state::<Tunnel>().mark_host_gone();
}

fn pump_stderr(app: AppHandle, stderr: std::process::ChildStderr) {
    let reader = BufReader::new(stderr);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        // The host's own logger already writes userData/emsoder.log; stderr is
        // for start-up crashes that happen before the logger is up.
        eprintln!("[host] {line}");
        let _ = app;
    }
}

// ---------------------------------------------------------------------------
// Commands called from the renderer
// ---------------------------------------------------------------------------

/// Register this webview as a push target for its own window label.
#[tauri::command]
pub fn rpc_listen(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Tunnel>,
    channel: Channel<String>,
) -> Result<(), String> {
    state.add_sink(window.label().to_string(), channel);
    Ok(())
}

/// The renderer's single entry point: `invoke("rpc", { channel, args })`.
#[tauri::command]
pub async fn rpc(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Tunnel>,
    channel: String,
    args: Option<Value>,
) -> Result<Value, String> {
    state
        .request(
            &channel,
            args.unwrap_or_else(|| Value::Array(vec![])),
            Some(window.label()),
        )
        .await
}

/// The renderer has painted — show the window now instead of flashing an empty
/// frame. Mirrors Electron's `ready-to-show` + 1200 ms fallback.
#[tauri::command]
pub fn ui_ready(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label().to_string();
    crate::appwin::reveal(&app, &label);
    Ok(())
}
