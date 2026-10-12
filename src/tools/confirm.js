/**
 * Permission gate for tools (aligned with ZCode-style modes).
 *
 * permissionMode:
 *   confirm       变更前确认 — 改文件 / 跑命令前都问
 *   auto_edit     自动编辑   — 自动改文件；终端仍按安全策略
 *   plan          计划模式   — 禁止直接改文件/跑命令，先出计划
 *   full          高危才询问 — 自动改文件 + 安全命令自动；仅高危仍问
 *   unrestricted  完全授权   — 不问用户，文件和终端都自动执行
 *
 * 兼容旧字段：
 *   autoRunTools     ≈ unrestricted（旧「完全自动」）
 *   autoApproveSafe  ≈ auto_edit（或 full 时的安全终端）
 *   terminalRunMode  askEveryTime | autoSafe | autoAll
 */

const MODES = ["confirm", "auto_edit", "plan", "full", "unrestricted"];

function normalizePermissionMode(cfg) {
  const raw = String(cfg?.permissionMode || "").toLowerCase().trim();
  if (MODES.includes(raw)) return raw;
  // 旧配置迁移
  if (cfg?.autoRunTools) return "unrestricted";
  if (cfg?.autoApproveSafe) return "auto_edit";
  return "confirm";
}

function permissionMeta(mode) {
  const m = MODES.includes(mode) ? mode : "confirm";
  const table = {
    confirm: {
      id: "confirm",
      label: "变更前确认",
      short: "确认",
      title: "改文件前先问我。终端命令也会确认。",
    },
    auto_edit: {
      id: "auto_edit",
      label: "自动编辑",
      short: "自动",
      title: "自动编辑文件。终端命令仍会按安全策略确认。",
    },
    plan: {
      id: "plan",
      label: "计划模式",
      short: "计划",
      title: "编辑前先出计划。不直接改文件或跑命令。",
    },
    full: {
      id: "full",
      label: "高危才询问",
      short: "高危问",
      title: "自动改文件，安全命令自动执行，只有高危命令才问你。",
    },
    unrestricted: {
      id: "unrestricted",
      label: "完全授权",
      short: "授权",
      title: "不问你。文件和终端都由模型自己判断并继续。",
    },
  };
  return table[m];
}

/**
 * 文件写入类确认（write / edit / apply_diff）
 * @returns {Promise<boolean>} true=允许
 */
async function maybeConfirm(ctx, message) {
  const mode = normalizePermissionMode(ctx?.cfg);
  if (mode === "plan") {
    // 计划模式：工具层应先拦截；这里再挡一层
    if (typeof ctx.confirm === "function") {
      return ctx.confirm(
        `当前是「计划模式」，默认不直接改文件。\n仍要执行？\n\n${message}`
      );
    }
    return false;
  }
  if (mode === "auto_edit" || mode === "full" || mode === "unrestricted") return true;
  // confirm：弹确认
  if (typeof ctx.confirm === "function") return ctx.confirm(message);
  return true;
}

/**
 * 终端是否应自动放行（不含黑名单拦截）
 * @returns {{ auto: boolean, reason: string }}
 */
function terminalAutoPolicy(cfg, looksSafe) {
  const mode = normalizePermissionMode(cfg);
  const tr = cfg?.terminalRunMode || "askEveryTime";
  // 完全自动旧开关 / terminal autoAll
  if (cfg?.autoRunTools || tr === "autoAll" || mode === "unrestricted") {
    return { auto: true, reason: mode === "unrestricted" ? "unrestricted" : "autoAll" };
  }
  if (mode === "full") {
    // 高危才询问：安全命令自动，危险仍问
    return { auto: !!looksSafe, reason: looksSafe ? "full-safe" : "full-ask" };
  }
  if (mode === "plan") {
    return { auto: false, reason: "plan" };
  }
  // confirm / auto_edit：终端默认每次问，除非 terminalRunMode=autoSafe 且命令安全
  if (tr === "autoSafe" && looksSafe) {
    return { auto: true, reason: "autoSafe" };
  }
  // 兼容：旧 autoApproveSafe 在 auto_edit 时曾顺带放行安全终端——保留为 optional
  // 用户要求「自动编辑」只管文件，终端仍确认 → 不在这里放行
  return { auto: false, reason: "ask" };
}

module.exports = {
  MODES,
  normalizePermissionMode,
  permissionMeta,
  maybeConfirm,
  terminalAutoPolicy,
};
