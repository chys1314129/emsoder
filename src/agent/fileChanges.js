/**
 * Shared file-change utilities for chat (SessionStore + AgentRunner)
 * and quest (QuestStore + QuestRunner) paths.
 *
 * Eliminates duplicated: clip/truncation, parseMutatingPath,
 * looksLikeNeedsContinue, resolveUnder, applyRejectCore.
 */

const fs = require("fs/promises");
const path = require("path");

/**
 * Clip before/after bodies to a char budget (half each).
 * @returns {{ before, after, truncated }}
 */
function clipChangeBodies(row, maxChars = 120_000) {
  const cap = Math.max(4_000, Number(maxChars) || 120_000);
  const half = Math.floor(cap / 2);
  const clip = (s) => {
    if (s == null) return { text: s, truncated: false };
    const t = String(s);
    if (t.length <= half) return { text: t, truncated: false };
    return {
      text: t.slice(0, half) + `\n…(截断，原长 ${t.length})`,
      truncated: true,
    };
  };
  const b = clip(row.before);
  const a = clip(row.after);
  return {
    before: b.text,
    after: a.text,
    truncated: !!(b.truncated || a.truncated),
  };
};

/**
 * Build the public-facing file-change body object (with truncation).
 */
function publicFileChangeBody(row, maxChars = 120_000) {
  const c = clipChangeBodies(row, maxChars);
  return {
    path: row.path,
    relative: row.relative || row.path,
    kind: row.kind || "edit",
    rejected: !!row.rejected,
    before: c.before,
    after: c.after,
    truncated: c.truncated,
  };
}

/**
 * Extract the target file path from a file-mutating tool-call args JSON.
 * Works for write_file / edit_file / apply_diff.
 */
function parseMutatingPath(argsJson) {
  try {
    const args =
      typeof argsJson === "string"
        ? JSON.parse(argsJson || "{}")
        : argsJson || {};
    const p = args.path || args.filename;
    return p ? String(p) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a possibly-relative path under a workspace root.
 * (Quest runner's local version; runner.js uses resolveSafePath for validation.)
 */
function resolveUnder(root, p) {
  if (!p) return root || process.cwd();
  if (path.isAbsolute(p)) return p;
  return path.resolve(root || process.cwd(), p);
}

/**
 * Unified "model wants to continue" detector.
 * Runner had extra keywords (剩余步骤/还没做完/请告诉我是否); quest was missing them.
 */
function looksLikeNeedsContinue(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const cleaned = t
    .replace(/没有剩余(步骤|工作|改动)?/g, "")
    .replace(/没有(再|更多)?(要改|要做|剩余)/g, "")
    .replace(/无需再(改|继续)?/g, "");
  return /需要我继续|要我继续|是否继续|接下来|下一步|如果你想|请告诉我是否|等你确认|我可以继续|剩余步骤|尚未完成|还没做完|TODO|未完成|先到这|先到这里|先到这儿|到此为止|暂时到这|这一轮先|本轮先|先完成了这|这部分先|其余的可以|其余部分|等你说继续|等你回复|等你指示|请回复继续|需要你确认|需要你点|要不要继续|还要我继续|后续步骤|剩下的我|未做完|没做完|先停一下|先停在这|暂停在这|等指令|等你下令|需要的话再|有需要再|再说一声|接着(改|做|处理)|然后(改|做)|还要改|还需要|say continue|shall I continue|want me to continue|let me know if|if you want me to continue|waiting for (your )?(confirmation|go-ahead|approval)|paused here|stop here for now|next I (will|can)|more to do/i.test(cleaned);
}

/**
 * Model actually closed the whole task. Keep this strict so a
 * mid-task "已改完这个文件" does not look finished.
 */
function looksLikeFinished(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (looksLikeNeedsContinue(t)) return false;
  return /已(经)?(全部|都)?(改完|做完|完成|搞定|处理完|改好|做好|处理好)|改完了|做完了|完成了|搞定了|改好了|做好了|测试通过|修改完成|处理完毕|没有(再|更多)?(要改|要做|剩余)|没有更多了|无需再|可以结束|到此结束|就这些|以上就是|本次改动|all tasks? (are )?done|task (is )?complete[d]?|nothing (else|more) to (do|change)|no further (changes|steps)|that(?:'s| is) (all|it)/i.test(t);
}

/** Model dumped remaining work back to the user. Keep running. */
function looksLikeHandoff(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return /你可以(自己|自行|再)|请你(自己|自行|再)|建议你(自己|自行|运行|测试|检查)|你来(跑|测|试|检查|验证)|你自己(跑|测|试|检查|验证)|自行(运行|测试|检查|验证)|你再(看|跑|测|试)|剩下的(你|请)|现在你可以|run (it|the tests) yourself|you can (now )?(run|test|verify|check)/i.test(t);
}

/**
 * Shared stale-protected rollback for a single file change row.
 * @param {object} row - { path, before, after, rejected }
 * @returns {Promise<{ok:boolean, code?:string, path?:string, error?:string}>}
 */
async function rollbackFileRow(row) {
  const abs = path.normalize(String(row.path || ""));
  if (!abs) throw new Error("缺少路径");
  if (row.rejected) return { ok: true, already: true };

  let current = null;
  let exists = true;
  try {
    current = await fs.readFile(abs, "utf8");
  } catch {
    exists = false;
    current = null;
  }

  // stale 保护
  if (row.after != null) {
    if (exists && current !== String(row.after)) {
      return {
        ok: false,
        code: "STALE_FILE",
        path: abs,
        error: "文件已被再次修改，未自动撤销",
      };
    }
    if (!exists && row.before != null) {
      return {
        ok: false,
        code: "STALE_FILE",
        path: abs,
        error: "文件已不存在，未自动撤销",
      };
    }
  }

  if (row.before == null) {
    // was create - delete file
    if (exists) {
      try {
        await fs.unlink(abs);
      } catch {
        /* file may already be gone */
      }
    }
  } else {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, row.before, "utf8");
  }
  return { ok: true, path: abs };
}

module.exports = {
  clipChangeBodies,
  publicFileChangeBody,
  parseMutatingPath,
  resolveUnder,
  looksLikeNeedsContinue,
  looksLikeFinished,
  looksLikeHandoff,
  rollbackFileRow,
};
