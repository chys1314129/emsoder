/** Agent IPC handlers (send / stop / queue / file-changes / confirm / inline-edit / complete / commit-message / etc). */
const { chatOnce } = require("../../providers");
const git = require("../../tools/git");
const { runAgentTurn } = require("../agentBridge");

function register(ipcMain, ctx) {
  const {
    cfg,
    runner,
    sessions,
    publicSession,
    askConfirm,
    ptyBridge,
    memoryStore,
    getWindow,
    chatQueue,
    cancelAllConfirms,
    resolveConfirm,
    completion,
    assertTrustedSender,
  } = ctx;

  function targetSession(sessionId) {
    return sessions.getById?.(sessionId) || sessions.getActive();
  }

  /** 简易前后缀对齐行 diff（无第三方依赖） */
  function simpleLineDiff(before, after, maxLines = 500) {
    const a = String(before ?? "").split(/\r?\n/);
    const b = String(after ?? "").split(/\r?\n/);
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    }
    let ai = a.length;
    let bi = b.length;
    while (ai > i && bi > j && a[ai - 1] === b[bi - 1]) {
      ai--;
      bi--;
    }
    const out = [];
    out.push("--- before");
    out.push("+++ after");
    for (let k = 0; k < i && out.length < maxLines; k++) {
      out.push(" " + a[k]);
    }
    for (let k = i; k < ai && out.length < maxLines; k++) {
      out.push("-" + a[k]);
    }
    for (let k = j; k < bi && out.length < maxLines; k++) {
      out.push("+" + b[k]);
    }
    for (let k = ai; k < a.length && out.length < maxLines; k++) {
      out.push(" " + a[k]);
    }
    if (out.length >= maxLines) out.push("…(diff 已截断)");
    return out.join("\n");
  }

  ipcMain.handle("agent:stop", (_e, { sessionId } = {}) => {
    const targetId = sessionId || sessions.getActive()?.id || null;
    if (!targetId) return { ok: false, error: "无活动会话" };
    // 定向停止：只取消当前会话的 running/queued task，其他工作区继续执行。
    chatQueue.cancelSession(targetId, "已停止当前任务");
    cancelAllConfirms(targetId);
    runner.stop(targetId);
    chatQueue.emitStatus({ stoppedSessionId: targetId });
    return { ok: true, sessionId: targetId };
  });

  ipcMain.handle("agent:is-running", (_e, { sessionId } = {}) => {
    const targetId = sessionId || sessions.getActive()?.id;
    return !!(targetId && (runner.isSessionRunning?.(targetId) || chatQueue.isSessionBusy(targetId)));
  });

  ipcMain.handle("agent:queue-status", (_e, { sessionId } = {}) => ({
    ok: true,
    ...chatQueue.snapshot(),
    sessionId: sessionId || sessions.getActive()?.id || null,
  }));

  /** Chat 本轮文件变更摘要（不含正文） */
  ipcMain.handle("agent:file-changes", (_e, { sessionId } = {}) => ({
    ok: true,
    fileChanges: sessions.publicFileChanges(sessionId),
  }));

  /** 单文件写前/写后 + 简易 diff（按需拉取，避免列表 IPC 爆炸） */
  ipcMain.handle("agent:file-change-diff", (_e, { path: filePath, sessionId } = {}) => {
    const body = sessions.getFileChangeBodies(filePath, 120_000, sessionId);
    if (!body) return { ok: false, error: "未找到该文件的本轮快照" };
    return {
      ok: true,
      ...body,
      diff: simpleLineDiff(body.before, body.after),
    };
  });

  /** 回滚单个文件到本轮写前 */
  ipcMain.handle("agent:reject-change", async (_e, { path: filePath, sessionId } = {}) => {
    const r = await runner.applyReject(filePath, sessionId);
    return {
      ...r,
      fileChanges: sessions.publicFileChanges(sessionId),
      session: publicSession(targetSession(sessionId)),
    };
  });

  /** 一键回滚本轮全部未撤销变更 */
  ipcMain.handle("agent:reject-all-changes", async (_e, { sessionId } = {}) => {
    const r = await runner.applyRejectAll(sessionId);
    return {
      ...r,
      fileChanges: sessions.publicFileChanges(sessionId),
      session: publicSession(targetSession(sessionId)),
    };
  });

  /** 确认本轮改动并清空摘要（不回滚） */
  ipcMain.handle("agent:accept-all-changes", (_e, { sessionId } = {}) => {
    sessions.clearFileChanges(sessionId);
    return {
      ok: true,
      fileChanges: sessions.publicFileChanges(sessionId),
      session: publicSession(targetSession(sessionId)),
    };
  });

  ipcMain.on("agent:send", (event, payload) => {
    try {
      assertTrustedSender(event);
    } catch {
      return; // 非本应用页面来源，静默丢弃（fire-and-forget 无法回错误）
    }
    const text = String(payload?.text || "").trim();
    if (!text) return;
    const sessionId = payload?.sessionId || sessions.getActive()?.id || null;
    const session = sessionId && sessions.getById?.(sessionId);
    if (!session) return;
    const workspaceRoot = payload?.workspaceRoot || session.workspaceRoot || cfg.lastWorkspace || "";
    // Migrate legacy sessions lazily: once the user sends from a session, bind its root.
    if (!session.workspaceRoot && workspaceRoot) sessions.setWorkspaceRoot?.(workspaceRoot, sessionId);
    chatQueue.enqueue(
      { sessionId, workspaceRoot },
      ({ taskId, setCancel }) => {
        // runner registers its AbortController synchronously at run start; pool cancellation
        // delegates to targeted runner.stop(sessionId).
        setCancel(() => runner.stop(sessionId));
        return runAgentTurn({
          runner, cfg, text, payload: { ...payload, sessionId, workspaceRoot },
          getWindow: () => getWindow(), sessions, publicSession,
          confirm: askConfirm, ptyBridge, memoryStore,
          sessionId, workspaceRoot, taskId,
        });
      }
    ).catch(() => {
      /* errors already pushed via agent events */
    });
  });

  ipcMain.handle("agent:confirm-response", (_e, { id, allow }) => {
    resolveConfirm(id, allow);
    return { ok: true };
  });

  ipcMain.handle("agent:inline-edit", async (_e, { instruction, code, language, file }) => {
    const result = await chatOnce(cfg, {
      messages: [
        {
          role: "system",
          content:
            "You are a code editor. Return ONLY the full replacement code. No markdown fences, no explanation.",
        },
        {
          role: "user",
          content: [
            file ? `File: ${file}` : "",
            language ? `Language: ${language}` : "",
            `Instruction: ${instruction}`,
            "Code:",
            String(code || "").slice(0, 20000),
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      maxTokens: 8192,
      temperature: 0.1,
    });
    let next = String(result || "").trim();
    if (next.startsWith("```")) {
      next = next.replace(/^```[\w-]*\n?/, "").replace(/```$/, "").trim();
    }
    return { code: next };
  });

  ipcMain.handle("agent:complete", async (_e, payload) => {
    if (cfg.completionEnabled === false) {
      return { text: "" };
    }
    const prefix = String(payload?.prefix || "").slice(-4000);
    const suffix = String(payload?.suffix || "").slice(0, 1500);
    const language = payload?.language || "";
    if (prefix.trim().length < 8) return { text: "" };

    // cancel previous in-flight completion (race: keep only latest)
    const myGen = completion.bumpGen();
    completion.abortCurrent();
    completion.abort = new AbortController();
    const signal = completion.abort.signal;

    try {
      const result = await chatOnce(cfg, {
        messages: [
          {
            role: "system",
            content:
              "You are a code completion engine. Return ONLY the code to insert at the cursor. No markdown fences, no explanation. Prefer short completions (1-12 lines).",
          },
          {
            role: "user",
            content: [
              language ? `Language: ${language}` : "",
              "Prefix:",
              prefix,
              "Suffix:",
              suffix,
              "Completion:",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        maxTokens: 256,
        temperature: 0.1,
        signal,
        timeoutMs: 20_000,
      });
      if (myGen !== completion.gen || signal.aborted) {
        return { text: "", stale: true };
      }
      let text = String(result || "").trim();
      if (text.startsWith("```")) {
        text = text.replace(/^```[\w-]*\n?/, "").replace(/```$/, "").trim();
      }
      return { text: text.split(/\r?\n/).slice(0, 12).join("\n") };
    } catch (err) {
      if (err?.name === "AbortError" || myGen !== completion.gen) {
        return { text: "", stale: true };
      }
      return { text: "", error: err.message || String(err) };
    }
  });

  ipcMain.handle("agent:commit-message", async () => {
    const root = cfg.lastWorkspace;
    if (!root) throw new Error("未打开工作区");
    const status = await git.getStatus(root);
    if (!status.ok) throw new Error(status.error || "git status failed");
    if (!status.files.length) return { message: "", empty: true };
    const diff = await git.getDiff(root, { staged: false });
    const stagedDiff = await git.getDiff(root, { staged: true });
    const body = [
      `branch: ${status.branch}`,
      "files:",
      ...status.files.map((f) => `${f.status} ${f.path}`),
      "",
      "staged diff:",
      (stagedDiff.diff || "").slice(0, 12000),
      "",
      "unstaged diff:",
      (diff.diff || "").slice(0, 12000),
    ].join("\n");
    const message = await chatOnce(cfg, {
      messages: [
        {
          role: "system",
          content:
            "Generate a concise conventional commit message (type(scope): subject). Output only the message line(s), no quotes, no explanation.",
        },
        { role: "user", content: body.slice(0, 24000) },
      ],
      maxTokens: 200,
      temperature: 0.2,
    });
    return {
      message: String(message || "")
        .trim()
        .replace(/^["']|["']$/g, ""),
    };
  });
}

module.exports = { register };
