/* EmsoderSettings: settings form fill + skills list inside settings modal.
   Depends on: EmsoderState (state, $), emsoder, EmsoderDom (escapeHtml/toast),
   EmsoderPermission (normalize/refresh), EmsoderReasoningMenu (normalize). */
(() => {
  const { state, $ } = EmsoderState;
  const escapeHtml = (s) => EmsoderDom.escapeHtml(s);
  const toast = (...a) => EmsoderDom.toast(...a);

  function fillSettingsForm() {
    const c = state.config;
    if (!c) return;
    $("stTerminal").value = c.terminalRunMode || "askEveryTime";
    if ($("stPermissionMode")) {
      $("stPermissionMode").value = EmsoderPermission.normalize(
        c.permissionMode
      );
    }
    EmsoderPermission.refresh();
    if ($("stCollapseProcess")) {
      $("stCollapseProcess").value =
        c.collapseProcess === false ? "false" : "true";
    }
    $("stCompletion").value = c.completionEnabled === false ? "false" : "true";
    $("stLang").value = c.responseLanguage || "zh-cn";
    $("stMaxTokens").value = c.maxTokens ?? 0;
    $("stTemp").value = c.temperature ?? 0.2;
    if ($("stReasoningEffort")) {
      $("stReasoningEffort").value = EmsoderReasoningMenu.normalize(c.reasoningEffort);
    }
    if ($("stAgentBackend")) {
      $("stAgentBackend").value = c.agentBackend === "pi" ? "pi" : "emsoder";
    }
    if ($("stRunMode")) {
      $("stRunMode").value =
        c.runMode === "plan" || c.runMode === "goal" ? c.runMode : "auto";
    }
    if ($("stAgentMaxRounds")) {
      $("stAgentMaxRounds").value =
        c.agentMaxRounds == null || Number(c.agentMaxRounds) <= 0
          ? 0
          : c.agentMaxRounds;
    }
    if ($("stAgentAutoContinue")) {
      $("stAgentAutoContinue").value =
        c.agentAutoContinue === false || c.agentAutoContinue === 0
          ? 0
          : c.agentAutoContinue == null || Number(c.agentAutoContinue) < 0
            ? -1
            : c.agentAutoContinue;
    }
    $("stFont").value = c.fontSize || 14;
    $("stSystem").value = c.systemPrompt || "";
    $("stDeny").value = c.commandDenyList || "";
    if ($("stSkillsEnabled")) {
      $("stSkillsEnabled").value = c.skillsEnabled === false ? "false" : "true";
    }
    if ($("stSkillsPlugins")) {
      $("stSkillsPlugins").value =
        c.skillsIncludePlugins === false ? "false" : "true";
    }
    if ($("stMemoriesEnabled")) {
      $("stMemoriesEnabled").value = c.memoriesEnabled === true ? "true" : "false";
    }
    if ($("stMemoriesMaxCount")) {
      $("stMemoriesMaxCount").value = c.memoriesMaxCount ?? 500;
    }
    if ($("stContextWindow")) {
      $("stContextWindow").value = c.contextWindow || 0;
    }
    if ($("stAutoCompressAt")) {
      $("stAutoCompressAt").value = c.autoCompressAt ?? 80;
    }
    if ($("stSoundEnabled")) {
      $("stSoundEnabled").value = c.soundEnabled === false ? "false" : "true";
    }
    if ($("stSoundVolume")) {
      $("stSoundVolume").value = c.soundVolume ?? 1.0;
    }
    if ($("stFloatingBall")) {
      $("stFloatingBall").value = c.floatingBallEnabled === true ? "true" : "false";
    }
    if ($("stImageProvider")) {
      $("stImageProvider").value = c.imageProvider === "unsplash" ? "unsplash" : "pexels";
    }
    // Key 已配置则显示占位，让用户知道有值但不回显明文
    if ($("stPexelsKey")) {
      $("stPexelsKey").value = c.pexelsApiKeySet ? "***" : "";
      $("stPexelsKey").placeholder = c.pexelsApiKeySet ? "已配置（留空不改动）" : "未配置";
    }
    if ($("stUnsplashKey")) {
      $("stUnsplashKey").value = c.unsplashApiKeySet ? "***" : "";
      $("stUnsplashKey").placeholder = c.unsplashApiKeySet ? "已配置（留空不改动）" : "未配置";
    }
    if ($("stImageGenBackend")) {
      $("stImageGenBackend").value = c.imageGenBackend || "modelscope";
    }
    if ($("stImageGenModel")) {
      $("stImageGenModel").value = c.imageGenModel || "";
    }
    if ($("stImageGenBaseUrl")) {
      $("stImageGenBaseUrl").value = c.imageGenBaseUrl || "";
    }
    if ($("stImageGenKey")) {
      $("stImageGenKey").value = c.imageGenApiKeySet ? "***" : "";
      $("stImageGenKey").placeholder = c.imageGenApiKeySet ? "已配置（留空不改动）" : "未配置";
    }
    refreshSkillsSettingsList();
  }

  async function refreshSkillsSettingsList() {
    const box = $("stSkillsList");
    if (!box || !window.emsoder?.listSkills) return;
    box.innerHTML = '<div class="tree-empty">加载中…</div>';
    try {
      const r = await emsoder.listSkills();
      if (!r?.ok) {
        box.innerHTML =
          '<div class="tree-empty">' +
          escapeHtml(r?.error || "加载失败") +
          "</div>";
        return;
      }
      if (r.enabled === false) {
        box.innerHTML =
          '<div class="tree-empty">Skills 已关闭（保存设置后生效）</div>';
        return;
      }
      const skills = r.skills || [];
      if (!skills.length) {
        box.innerHTML =
          '<div class="tree-empty">未发现技能。目录：~/.zcode/skills、~/.agents/skills</div>';
        return;
      }
      box.innerHTML = "";
      for (const s of skills.slice(0, 80)) {
        const el = document.createElement("div");
        el.className = "list-item";
        el.style.padding = "6px 8px";
        const desc = (s.description || "").replace(/\s+/g, " ").slice(0, 100);
        el.innerHTML =
          `<div class="meta"><div class="name">${escapeHtml(s.name)}` +
          (s.disabled ? ' <span style="opacity:.6">关</span>' : "") +
          `</div><div class="desc">${escapeHtml(s.source || "")} · ${escapeHtml(
            desc
          )}</div></div>`;
        el.title = s.dir || s.id;
        el.onclick = async () => {
          try {
            await emsoder.setSkillDisabled(s.id || s.name, !s.disabled);
            state.config = await emsoder.getConfig();
            toast((s.disabled ? "已启用: " : "已禁用: ") + s.name);
            await refreshSkillsSettingsList();
          } catch (e) {
            toast(e.message || e, true);
          }
        };
        box.appendChild(el);
      }
      if (skills.length > 80) {
        const more = document.createElement("div");
        more.className = "tree-empty";
        more.textContent = `…共 ${skills.length} 个，仅显示前 80`;
        box.appendChild(more);
      }
    } catch (e) {
      box.innerHTML =
        '<div class="tree-empty">' + escapeHtml(e.message || e) + "</div>";
    }
  }

  $("btnRefreshSkills")?.addEventListener("click", () =>
    refreshSkillsSettingsList()
  );

  window.EmsoderSettings = {
    fill: fillSettingsForm,
    refreshSkillsList: refreshSkillsSettingsList,
  };
})();
