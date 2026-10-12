/**
 * 凭据静态加密：用 Electron safeStorage（Windows DPAPI / macOS Keychain /
 * Linux libsecret）对配置里的敏感字段做落盘加密，替代明文 JSON。
 *
 * 只在序列化边界（saveConfig 写盘前 / loadConfig 读盘后）做转换：
 * - 加密值存成 { "__emsoder_enc__": "<base64>" } 信封；
 * - 内存中的 cfg 仍是明文，其余代码无需改动；
 * - 旧明文配置可无缝迁移（非信封值原样返回，下次保存自动加密）；
 * - 系统钥匙串不可用或解密失败时优雅降级，不影响应用启动。
 */
const { safeStorage } = require("electron");

const ENC_KEY = "__emsoder_enc__";

/** 顶层字符串凭据字段。 */
const TOP_SECRET_KEYS = ["pexelsApiKey", "unsplashApiKey", "imageGenApiKey"];

function canEncrypt() {
  try {
    return !!(
      safeStorage &&
      typeof safeStorage.encryptString === "function" &&
      typeof safeStorage.decryptString === "function" &&
      safeStorage.isEncryptionAvailable()
    );
  } catch {
    return false;
  }
}

function sealValue(value) {
  if (value == null || value === "") return value;
  if (!canEncrypt()) return value;
  try {
    return {
      [ENC_KEY]: safeStorage.encryptString(JSON.stringify(value)).toString("base64"),
    };
  } catch {
    return value;
  }
}

function unsealValue(value) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value[ENC_KEY] === "string"
  ) {
    try {
      const plain = safeStorage.decryptString(Buffer.from(value[ENC_KEY], "base64"));
      return JSON.parse(plain);
    } catch {
      return undefined; // 钥匙串变化导致解密失败 → 视为未设置
    }
  }
  return value;
}

function sealEnvObject(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return env;
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = typeof v === "string" ? sealValue(v) : v;
  }
  return out;
}

function unsealEnvObject(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return env;
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = unsealValue(v);
  }
  return out;
}

/** 写盘前：对 cfg 做深拷贝并加密敏感字段。 */
function sealConfig(cfg) {
  let out;
  try {
    out = JSON.parse(JSON.stringify(cfg));
  } catch {
    return cfg;
  }
  if (!canEncrypt()) return out;

  for (const k of TOP_SECRET_KEYS) {
    if (out[k]) out[k] = sealValue(out[k]);
  }
  if (Array.isArray(out.providers)) {
    for (const p of out.providers) {
      if (!p || typeof p !== "object") continue;
      if (p.apiKey) p.apiKey = sealValue(p.apiKey);
      if (p.oauthTokens && typeof p.oauthTokens === "object") {
        p.oauthTokens = sealValue(p.oauthTokens);
      }
    }
  }
  if (Array.isArray(out.mcpServers)) {
    for (const s of out.mcpServers) {
      if (s && typeof s === "object") s.env = sealEnvObject(s.env);
    }
  }
  out.executionEnv = sealEnvObject(out.executionEnv);
  return out;
}

/** 读盘后：对 raw 解密敏感字段。 */
function unsealConfig(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const out = { ...raw };
  for (const k of TOP_SECRET_KEYS) {
    if (out[k]) out[k] = unsealValue(out[k]);
  }
  if (Array.isArray(out.providers)) {
    out.providers = out.providers.map((p) => {
      if (!p || typeof p !== "object") return p;
      const q = { ...p };
      if (q.apiKey) q.apiKey = unsealValue(q.apiKey);
      if (q.oauthTokens && typeof q.oauthTokens === "object") {
        q.oauthTokens = unsealValue(q.oauthTokens);
      }
      return q;
    });
  }
  if (Array.isArray(out.mcpServers)) {
    out.mcpServers = out.mcpServers.map((s) => {
      if (!s || typeof s !== "object") return s;
      const q = { ...s };
      q.env = unsealEnvObject(q.env);
      return q;
    });
  }
  out.executionEnv = unsealEnvObject(out.executionEnv);
  return out;
}

module.exports = { sealConfig, unsealConfig, canEncrypt };
