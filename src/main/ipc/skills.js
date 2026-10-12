/** Skills (zcode / agents SKILL.md) IPC handlers. */
const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const { spawn } = require("child_process");
const { saveConfig } = require("../../core/config");
const {
  augmentProcessEnv,
  executionEnv,
  imageGenerationEnv,
  resolveSkillRuntimeRoot,
} = require("../../tools/skillRuntime");

function runProcess(command, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, opts.timeoutMs || 180_000);
    child.stdout.on("data", (d) => { stdout = (stdout + String(d)).slice(-8000); });
    child.stderr.on("data", (d) => { stderr = (stderr + String(d)).slice(-8000); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err.message || err), timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut: false });
    });
  });
}

function register(ipcMain, ctx) {
  const { cfg } = ctx;

  // One real image generation request. Key stays only in this spawned process;
  // result is written under OS temp and immediately deleted.
  ipcMain.handle("skills:image-gen-test", async () => {
    const key = String(cfg.imageGenApiKey || "").trim();
    if (!key) {
      return { ok: false, code: "NO_KEY", error: "请先保存图片生成 API Key，再测试。" };
    }
    let catalog;
    try {
      catalog = await require("../../tools/skills").loadSkillCatalog(cfg, cfg.lastWorkspace || "");
    } catch (e) {
      return { ok: false, code: "CATALOG", error: e.message || String(e) };
    }
    const skill = (catalog.skills || []).find((s) => s.id === "ppt-master");
    if (!skill?.dir) {
      return { ok: false, code: "NO_SKILL", error: "找不到预装 ppt-master 技能。" };
    }
    const runtime = resolveSkillRuntimeRoot();
    const py = runtime && path.join(runtime, "python", process.platform === "win32" ? "python.exe" : "python");
    try {
      await fs.access(py);
    } catch {
      return { ok: false, code: "NO_PYTHON", error: "未找到便携 Python，请重新同步运行时。" };
    }
    const script = path.join(skill.dir, "scripts", "image_gen.py");
    try {
      await fs.access(script);
    } catch {
      return { ok: false, code: "NO_SCRIPT", error: "ppt-master 的 image_gen.py 缺失。" };
    }
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "emsoder-image-gen-test-"));
    const env = augmentProcessEnv(process.env, {
      ...executionEnv(cfg),
      ...imageGenerationEnv(cfg),
    });
    const backend = String(cfg.imageGenBackend || "modelscope");
    const model = String(cfg.imageGenModel || "").trim();
    const args = [
      script,
      "a clean blue abstract presentation cover, minimal professional design",
      "--aspect_ratio", "16:9",
      "--image_size", "512px",
      "--output", tmp,
      "--filename", "test",
      "--backend", backend,
    ];
    if (model) args.push("--model", model);
    try {
      const r = await runProcess(py, args, { cwd: path.dirname(script), env, timeoutMs: 180_000 });
      const out = path.join(tmp, "test.png");
      let bytes = 0;
      try { bytes = (await fs.stat(out)).size; } catch { /* generated file missing */ }
      if (r.code !== 0 || !bytes) {
        // Never return env/config/key; only concise process diagnostics.
        const hint = String(r.stderr || r.stdout || "").replace(/(?:sk-|ms-)[A-Za-z0-9._-]+/g, "***").slice(-1200);
        return { ok: false, code: "GEN_FAILED", error: hint || "图片生成失败，请检查后端、Key、模型和额度。" };
      }
      return { ok: true, backend, model: model || "默认模型", bytes };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ---- Skills (zcode / agents SKILL.md) ----
  ipcMain.handle("skills:list", async () => {
    const {
      loadSkillCatalog,
    } = require("../../tools/skills");
    let SKILL_CN = {};
    let extractTriggers = () => [];
    try {
      ({ SKILL_CN, extractTriggers } = require("../../tools/skillInfo"));
    } catch {
      /* optional enrichment for sidebar search */
    }
    try {
      const catalog = await loadSkillCatalog(cfg, cfg.lastWorkspace || "");
      let runtime = null;
      try {
        runtime = require("../../tools/skillRuntime").listBundledTools();
      } catch {
        runtime = null;
      }
      return {
        ok: true,
        enabled: catalog.enabled !== false,
        roots: catalog.roots || [],
        skills: (catalog.skills || []).map((s) => {
          const key = String(s.name || s.id || "").toLowerCase();
          const cn = SKILL_CN[key] || SKILL_CN[s.name] || SKILL_CN[s.id];
          const cnDescription = cn?.desc || "";
          const triggers =
            (cn?.triggers && cn.triggers.length
              ? cn.triggers
              : extractTriggers(s.description || "")) || [];
          return {
            id: s.id,
            name: s.name,
            description: s.description,
            cnDescription,
            triggers,
            source: s.source,
            dir: s.dir,
            disabled: !!s.disabled,
          };
        }),
        runtime,
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e), skills: [], roots: [] };
    }
  });
  function applySkillsDisabledKeys(keys, disabled) {
    const list = Array.isArray(cfg.skillsDisabled)
      ? [...cfg.skillsDisabled]
      : [];
    const drop = new Set(
      (Array.isArray(keys) ? keys : [])
        .map((x) => String(x || "").trim().toLowerCase())
        .filter(Boolean)
    );
    if (!drop.size) return { ok: false, error: "missing ids", changed: 0 };
    let next = list.filter((x) => !drop.has(String(x).toLowerCase()));
    if (disabled) {
      for (const raw of keys) {
        const key = String(raw || "").trim();
        if (!key) continue;
        const lower = key.toLowerCase();
        if (!next.some((x) => String(x).toLowerCase() === lower)) next.push(key);
      }
    }
    cfg.skillsDisabled = next;
    saveConfig(cfg);
    try {
      require("../../tools/skills").invalidateSkillCache();
    } catch {
      /* ignore */
    }
    return {
      ok: true,
      changed: drop.size,
      skillsDisabled: cfg.skillsDisabled,
    };
  }

  ipcMain.handle("skills:set-disabled", (_e, { id, disabled }) => {
    const key = String(id || "").trim();
    if (!key) return { ok: false, error: "missing id" };
    return applySkillsDisabledKeys([key], disabled);
  });

  // 批量禁用/启用（技能侧栏：对当前筛选结果一键操作）
  ipcMain.handle("skills:set-disabled-batch", (_e, { ids, disabled }) => {
    const keys = Array.isArray(ids) ? ids : [];
    return applySkillsDisabledKeys(keys, disabled);
  });

  ipcMain.handle("skills:read", async (_e, { id }) => {
    const key = String(id || "").trim();
    if (!key) return { ok: false, error: "missing id" };
    try {
      const { loadSkillCatalog, loadSkillContent } = require("../../tools/skills");
      const catalog = await loadSkillCatalog(cfg, cfg.lastWorkspace || "");
      const result = await loadSkillContent(catalog, key, "", {
        allowDisabled: true,
      });
      if (!result.ok) return result;
      const skill = result.skill || {};
      const skillId = String(skill.id || skill.name || key).toLowerCase();
      let cnDesc = "";
      let cnTriggers = [];
      let autoTriggers = [];
      try {
        const { SKILL_CN, extractTriggers } = require("../../tools/skillInfo");
        const cn = SKILL_CN[skillId] || SKILL_CN[skill.name] || {};
        cnDesc = cn.desc || "";
        cnTriggers = cn.triggers || [];
        autoTriggers = extractTriggers(skill.description || "");
      } catch { /* ignore */ }
      return {
        ok: true,
        name: skill.name || key,
        description: skill.description || "",
        source: skill.source || "",
        dir: skill.dir || "",
        content: result.content || "",
        cnDescription: cnDesc,
        triggers: [...new Set([...cnTriggers, ...autoTriggers])].slice(0, 15),
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("skills:uninstall", async (_e, { id }) => {
    const key = String(id || "").trim();
    if (!key) return { ok: false, error: "missing id" };
    try {
      const { loadSkillCatalog, findSkill } = require("../../tools/skills");
      const catalog = await loadSkillCatalog(cfg, cfg.lastWorkspace || "");
      const skill = findSkill(catalog, key);
      if (!skill) return { ok: false, error: "skill not found" };
      // only allow uninstalling user-installed skills (zcode/agents/workspace)
      if (
        skill.source === "bundled" ||
        skill.source === "plugin" ||
        skill.source === "core"
      ) {
        return { ok: false, error: "预装/捆绑/插件技能不可卸载，仅可禁用" };
      }
      const dir = skill.dir;
      if (!dir) return { ok: false, error: "skill dir missing" };
      // safety: must be under a known skills directory
      const allowedRoots = [
        path.join(os.homedir(), ".zcode", "skills"),
        path.join(os.homedir(), ".agents", "skills"),
        cfg.lastWorkspace ? path.join(cfg.lastWorkspace, ".emsoder", "skills") : null,
      ].filter(Boolean).map((r) => path.resolve(r).toLowerCase());
      const absDir = path.resolve(dir).toLowerCase();
      // 只允许删除技能根目录的「严格子目录」；禁止等于根目录本身，
      // 否则当 SKILL.md 恰好位于技能根（如 ~/.zcode/skills/SKILL.md）时，
      // 会递归删除整个 skills 目录（把其它技能一并抹掉）。
      const inAllowed = allowedRoots.some((r) => absDir.startsWith(r + path.sep));
      if (!inAllowed) {
        return { ok: false, error: "技能目录不在可卸载范围内" };
      }
      await fs.rm(dir, { recursive: true, force: true });
      // also remove from disabled list
      const list = (cfg.skillsDisabled || []).filter(
        (x) => String(x).toLowerCase() !== key.toLowerCase()
      );
      cfg.skillsDisabled = list;
      saveConfig(cfg);
      try { require("../../tools/skills").invalidateSkillCache(); } catch {}
      // also remove symlink if exists (zcode -> agents)
      try {
        const zcodeLink = path.join(os.homedir(), ".zcode", "skills", skill.name);
        const st = await fs.lstat(zcodeLink).catch(() => null);
        if (st?.isSymbolicLink()) await fs.unlink(zcodeLink);
      } catch {}
      return { ok: true, message: `已卸载 ${skill.name}` };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // ---- Skills install wizard (npx skills add wrapper) ----
  ipcMain.handle("skills:install-presets", () => {
    try {
      const { PRESETS } = require("../../tools/skillInstall");
      return { ok: true, presets: PRESETS };
    } catch (e) {
      return { ok: false, error: e.message || String(e), presets: [] };
    }
  });

  ipcMain.handle("skills:install", async (event, payload) => {
    const skillInstall = require("../../tools/skillInstall");
    const sendLog = (line) => {
      try {
        event.sender.send("skills:install-log", { line: String(line || "") });
      } catch {
        /* window gone */
      }
    };
    try {
      const result = await skillInstall.runSkillsAdd({
        repo: payload?.repo,
        skill: payload?.skill,
        global: payload?.global !== false,
        onLog: sendLog,
      });
      try {
        require("../../tools/skills").invalidateSkillCache();
      } catch {
        /* ignore */
      }
      return result;
    } catch (e) {
      return {
        ok: false,
        code: null,
        error: e.message || String(e),
        stdout: "",
        stderr: "",
        cmd: "",
      };
    }
  });

  ipcMain.handle("skills:install-cancel", () => {
    try {
      return require("../../tools/skillInstall").cancelSkillsInstall();
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("skills:install-status", () => {
    try {
      const { isInstallRunning } = require("../../tools/skillInstall");
      return { ok: true, running: isInstallRunning() };
    } catch (e) {
      return { ok: false, running: false, error: e.message || String(e) };
    }
  });
}

module.exports = { register };
