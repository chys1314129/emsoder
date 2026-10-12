//! DPAPI helper mode: the same exe, invoked as a one-shot synchronous tool.
//!
//! The host process (Node) needs `safeStorage`-equivalent sealing, but
//! `loadConfig()` / `saveConfig()` in `src/core/config.js` are **synchronous**
//! and called from ~15 places, so an async RPC round trip is not an option and
//! Node cannot call DPAPI directly without a native addon.
//!
//! So the host shells out to this exe with `execFileSync` — one call per config
//! save, batching every secret in that save into a single spawn:
//!
//! ```text
//! emsoder.exe --dpapi-seal     <<< ["sk-abc", null, "another"]
//! emsoder.exe --dpapi-unseal   <<< ["QAAA...base64", null]
//! ```
//!
//! Both read a JSON array from stdin and write a JSON array to stdout, where a
//! `null` slot passes through untouched and an entry that fails becomes `null`
//! (the host reads that as "secret unset" — the same graceful degradation the
//! Electron build had when the keychain was unavailable).
//!
//! This runs before any GUI/Tauri initialisation, so it works headless.

use base64::Engine as _;
use std::io::{Read, Write};

/// Returns `Some(exit_code)` when the process was invoked in helper mode and
/// has already done its job; `None` means "carry on and start the app".
pub fn try_run() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.iter().skip(1).find(|a| a.starts_with("--dpapi"))?;
    match mode.as_str() {
        "--dpapi-seal" => Some(run_strings(true)),
        "--dpapi-unseal" => Some(run_strings(false)),
        // Raw-byte forms, for the Chromium OSCrypt key which is random binary and
        // must not go through a UTF-8 round trip.
        "--dpapi-blob" => Some(run_blobs(true)),
        "--dpapi-key" => Some(run_blobs(false)),
        other => {
            let _ = writeln!(std::io::stderr(), "unknown helper mode: {other}");
            Some(2)
        }
    }
}

/// `["<base64>"] -> [{"key":"<base64>"} | {"error":"..."}]`
///
/// `seal` wraps raw bytes with DPAPI (used to mint a fresh OSCrypt key);
/// otherwise it unwraps (used to read the existing one). Objects rather than
/// bare values so a failure explains itself — this is the layer that decides
/// whether an existing install keeps its API keys.
fn run_blobs(seal: bool) -> i32 {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return 2;
    }
    let items: Vec<Option<String>> = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(_) => return 2,
    };

    let encode = base64::engine::general_purpose::STANDARD;
    let out: Vec<serde_json::Value> = items
        .iter()
        .map(|item| match item {
            None => serde_json::json!({ "error": "输入为空" }),
            Some(b64) => match base64::Engine::decode(&encode, b64.trim()) {
                Err(_) => serde_json::json!({ "error": "base64 解码失败" }),
                Ok(raw) => {
                    let result = if seal {
                        crate::secrets::protect_bytes(&raw)
                    } else {
                        crate::secrets::unprotect_bytes(&raw)
                    };
                    match result {
                        Ok(bytes) => serde_json::json!({ "key": encode.encode(bytes) }),
                        Err(err) => serde_json::json!({ "error": err }),
                    }
                }
            },
        })
        .collect();

    write_json(&out)
}

/// `["secret"] -> ["<base64>" | null]`
fn run_strings(seal: bool) -> i32 {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return 2;
    }
    let items: Vec<Option<String>> = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(_) => return 2,
    };

    let out: Vec<serde_json::Value> = items
        .iter()
        .map(|item| match item {
            None => serde_json::Value::Null,
            Some(s) => {
                let r = if seal {
                    crate::secrets::protect(s)
                } else {
                    crate::secrets::unprotect(s)
                };
                match r {
                    Ok(v) => serde_json::Value::String(v),
                    Err(_) => serde_json::Value::Null,
                }
            }
        })
        .collect();

    write_json(&out)
}

fn write_json(value: &[serde_json::Value]) -> i32 {
    let encoded = serde_json::to_string(value).unwrap_or_else(|_| "[]".into());
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    if handle.write_all(encoded.as_bytes()).is_err() {
        return 2;
    }
    let _ = handle.flush();
    0
}
