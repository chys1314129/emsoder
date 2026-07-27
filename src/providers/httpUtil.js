const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;

function isRetryableError(err, status) {
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("socket") ||
    msg.includes("request timeout")
  );
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function mergeAbortSignals(userSignal, timeoutMs) {
  const ctrl = new AbortController();
  let timer = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      ctrl.abort(
        Object.assign(new Error("Request timeout"), { name: "TimeoutError" })
      );
    }, timeoutMs);
  }
  const cleanup = () => {
    if (timer) clearTimeout(timer);
  };
  if (userSignal) {
    if (userSignal.aborted) {
      cleanup();
      ctrl.abort(userSignal.reason);
    } else {
      userSignal.addEventListener(
        "abort",
        () => {
          cleanup();
          ctrl.abort(userSignal.reason);
        },
        { once: true }
      );
    }
  }
  ctrl.signal.addEventListener("abort", cleanup, { once: true });
  return { signal: ctrl.signal, cleanup };
}

/**
 * Classify provider errors into actionable codes for UI.
 */
function classifyProviderError(errOrText) {
  const raw = String(errOrText?.message || errOrText || "");
  const lower = raw.toLowerCase();
  let code = "unknown";
  let hint = "请检查网络、Base URL 与模型名。";
  let action = null; // providers | models | settings

  if (lower.includes("abort") || lower.includes("已停止")) {
    code = "aborted";
    hint = "已停止生成。";
  } else if (lower.includes("timeout") || lower.includes("超时")) {
    code = "timeout";
    hint = "请求超时。可换更快模型，或检查代理/网络。";
    action = "models";
  } else if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("incorrect api key")
  ) {
    code = "auth";
    hint = "API Key 无效或未配置。请到「服务商」填写正确密钥。";
    action = "providers";
  } else if (
    lower.includes("403") ||
    lower.includes("permission") ||
    lower.includes("forbidden")
  ) {
    code = "forbidden";
    hint = "无权限访问该模型。请检查账号权限或换模型。";
    action = "models";
  } else if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("too many")
  ) {
    code = "rate_limit";
    hint = "触发限流。稍后再试，或换服务商/模型。";
    action = "models";
  } else if (
    lower.includes("insufficient") ||
    lower.includes("quota") ||
    lower.includes("balance") ||
    lower.includes("billing") ||
    lower.includes("credits")
  ) {
    code = "quota";
    hint = "额度不足或欠费。请到服务商控制台充值，或换本地 Ollama。";
    action = "providers";
  } else if (
    lower.includes("model") &&
    (lower.includes("not found") ||
      lower.includes("does not exist") ||
      lower.includes("invalid model"))
  ) {
    code = "model";
    hint = "模型名不存在。请在「模型」里改成服务商支持的名称。";
    action = "models";
  } else if (
    lower.includes("enotfound") ||
    lower.includes("econnrefused") ||
    lower.includes("network error") ||
    lower.includes("fetch failed")
  ) {
    code = "network";
    hint = "连不上服务商。检查 Base URL、本机 Ollama 是否启动、代理设置。";
    action = "providers";
  } else if (lower.includes("404")) {
    code = "not_found";
    hint = "接口路径不对。OpenAI 兼容一般要 …/v1，可改 Base URL。";
    action = "providers";
  }

  return { code, message: raw, hint, action };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_RETRIES,
  isRetryableError,
  sleep,
  mergeAbortSignals,
  classifyProviderError,
};
