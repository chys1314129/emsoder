"use strict";
/**
 * Electron-compatible `safeStorage` for the Tauri build.
 *
 * What Electron actually stores on Windows is **not** a bare DPAPI blob. Probing
 * it (scripts/probe-oscrypt.js) shows a 66-byte payload for a 35-byte plaintext:
 *
 *     66 = 3 ("v10") + 12 (nonce) + 35 (ciphertext) + 16 (GCM tag)
 *
 * i.e. `"v10" || nonce || AES-256-GCM ciphertext || tag`. The AES key itself is
 * 32 random bytes wrapped with DPAPI and kept in `<userData>/Local State` under
 * `os_crypt.encrypted_key`, base64-encoded with an ASCII "DPAPI" prefix —
 * Chromium's OSCrypt layout, which Electron reuses.
 *
 * So the work splits between the two runtimes that are good at each half:
 *
 *   - Rust (`emsoder.exe --dpapi-key`): DPAPI, which Node cannot reach without a
 *     native addon.
 *   - Here: AES-256-GCM via Node's built-in `crypto`, so no dependency and the
 *     wire format lives in exactly one file.
 *
 * The payoff: an existing install's sealed API keys decrypt unchanged, in both
 * directions — the Electron build can still read a config the Tauri build wrote.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const V10 = "v10";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ORIGIN = path.join(__dirname, "..", "src", "core", "secretStore.js");

let appExe = "";
let userData = "";
let cachedKey = null;
let keyError = null;

/** Wired by platform.js. */
function configure({ appPath, userDataDir }) {
  appExe = appPath || "";
  userData = userDataDir || "";
  cachedKey = null;
  keyError = null;
}

function helperAvailable() {
  return process.platform === "win32" && !!appExe && fs.existsSync(appExe);
}

function runHelper(mode, values) {
  const out = execFileSync(appExe, [mode], {
    input: JSON.stringify(values),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  if (!Array.isArray(parsed)) throw new Error(`helper ${mode} 未返回数组`);
  return parsed;
}

function localStatePath() {
  return path.join(userData, "Local State");
}

function readLocalState() {
  try {
    const raw = fs.readFileSync(localStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Write `os_crypt.encrypted_key` back without disturbing Chromium's other keys. */
function writeLocalState(state) {
  const target = localStatePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(state, null, 2), "utf8");
}

/** Wrap 32 fresh key bytes with DPAPI, in Chromium's base64("DPAPI"+blob) form. */
function wrapKey(keyBytes) {
  const [result] = runHelper("--dpapi-blob", [keyBytes.toString("base64")]);
  if (!result || !result.key) {
    throw new Error(`DPAPI 包裹密钥失败：${result?.error || "未知原因"}`);
  }
  const blob = Buffer.from(result.key, "base64");
  return Buffer.concat([Buffer.from("DPAPI", "ascii"), blob]).toString("base64");
}

/**
 * The 32-byte AES key, created on first use if `Local State` has none yet — so a
 * fresh Tauri-only install and an Electron install converge on the same key.
 */
function aesKey() {
  if (cachedKey) return cachedKey;
  if (keyError) throw keyError;
  if (!helperAvailable()) {
    keyError = new Error("DPAPI helper 不可用");
    throw keyError;
  }

  try {
    const state = readLocalState();
    const encrypted = state?.os_crypt?.encrypted_key;
    if (typeof encrypted === "string" && encrypted) {
      const blob = Buffer.from(encrypted, "base64");
      const hasPrefix = blob.slice(0, 5).toString("ascii") === "DPAPI";
      const body = (hasPrefix ? blob.slice(5) : blob).toString("base64");
      const [result] = runHelper("--dpapi-key", [body]);
      if (!result || !result.key) {
        throw new Error(
          `解开 Local State 中的密钥失败：${result?.error || "未知原因"}（可能是其他 Windows 用户创建的配置）`
        );
      }
      const key = Buffer.from(result.key, "base64");
      if (key.length !== KEY_BYTES) {
        throw new Error(`密钥长度异常：${key.length} 字节（期望 ${KEY_BYTES}）`);
      }
      cachedKey = key;
      return cachedKey;
    }

    // No key yet: mint one and persist it in the same place Electron uses.
    const key = crypto.randomBytes(KEY_BYTES);
    state.os_crypt = state.os_crypt || {};
    state.os_crypt.encrypted_key = wrapKey(key);
    writeLocalState(state);
    cachedKey = key;
    return cachedKey;
  } catch (err) {
    keyError = err;
    throw err;
  }
}

/** plaintext -> Buffer of `v10 || nonce || ciphertext || tag` (Electron's shape). */
function encryptString(plainText) {
  const key = aesKey();
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(String(plainText), "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from(V10, "ascii"), nonce, ciphertext, cipher.getAuthTag()]);
}

/** Buffer/`v10...` string -> plaintext. Throws on any mismatch, like Electron. */
function decryptString(payload) {
  const key = aesKey();
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "base64");
  if (buffer.length < V10.length + NONCE_BYTES + TAG_BYTES) {
    throw new Error("密文长度不足，无法解密");
  }
  const prefix = buffer.subarray(0, V10.length).toString("ascii");
  if (prefix !== V10) {
    // Matches Electron's own error for a payload that is not in its format, which
    // happens when the value was written by a build without DPAPI available.
    throw new Error("Ciphertext does not appear to be encrypted.");
  }
  const nonce = buffer.subarray(V10.length, V10.length + NONCE_BYTES);
  const tag = buffer.subarray(buffer.length - TAG_BYTES);
  const ciphertext = buffer.subarray(V10.length + NONCE_BYTES, buffer.length - TAG_BYTES);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext)]).toString("utf8");
}

module.exports = {
  configure,
  available: helperAvailable,
  encryptString,
  decryptString,
  localStatePath,
  ORIGIN,
};
