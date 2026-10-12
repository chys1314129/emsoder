/* EmsoderMemorySide: long-term memory sidebar (list / detail / add / edit).
   Depends on: EmsoderState (state, $), emsoder, EmsoderDom (escapeHtml/toast/showConfirm).
   App-only functions are reached defensively via window.EmsoderApp?.fn?.(). */
(() => {
  const { state, $ } = EmsoderState;
  const escapeHtml = (s) => EmsoderDom.escapeHtml(s);
  const toast = (...a) => EmsoderDom.toast(...a);
  const sideBody = $("sideBody");
  const sideTitle = $("sideTitle");

  let _memorySearchTimer = null;

  async function renderMemorySide() {
    sideTitle.textContent = "长期记忆";
    if (!window.emsoder?.listMemories) {
      sideBody.innerHTML = '<div class="tree-empty">记忆 API 未就绪</div>';
      return;
    }
    sideBody.innerHTML = '<div class="tree-empty">加载中…</div>';
    let memories = [];
    try {
      const r = await emsoder.listMemories({ limit: 200 });
      memories = r?.ok ? r.memories || [] : [];
      if (!r?.ok) {
        sideBody.innerHTML = `<div class="tree-empty">${escapeHtml(r?.error || "加载失败")}</div>`;
        return;
      }
    } catch (e) {
      sideBody.innerHTML = `<div class="tree-empty">${escapeHtml(e.message || e)}</div>`;
      return;
    }

    sideBody.innerHTML = "";
    // Toolbar: search + add + extract-now + clear
    const toolbar = document.createElement("div");
    toolbar.className = "skills-toolbar";
    toolbar.innerHTML = `
      <input type="text" id="memorySearchInput" placeholder="搜索记忆内容或标签…" class="skills-search" />
      <button class="btn small" id="btnMemoryAdd" title="手动添加">+ 添加</button>
      <button class="btn small" id="btnMemoryExtract" title="从当前会话提取">提取</button>
      <button class="btn small" id="btnMemoryClear" title="清空全部">清空</button>
    `;
    sideBody.appendChild(toolbar);

    const list = document.createElement("div");
    list.className = "skill-list";
    list.id = "memoryList";
    sideBody.appendChild(list);

    function paint(items) {
      list.innerHTML = "";
      if (!items.length) {
        list.innerHTML = '<div class="tree-empty">暂无记忆。开启设置里的「长期记忆」后，每轮对话结束会自动提取事实/偏好。</div>';
        return;
      }
      for (const m of items) {
        const row = document.createElement("div");
        row.className = "skill-row";
        const imp = "★".repeat(m.importance || 3) + "☆".repeat(5 - (m.importance || 3));
        row.innerHTML = `
          <div class="skill-info">
            <span class="skill-name">${escapeHtml(m.content)}</span>
            <span class="skill-source">${escapeHtml((m.tags || []).join(", "))} · ${imp}</span>
          </div>
        `;
        row.addEventListener("click", () => showMemoryDetail(m.id));
        list.appendChild(row);
      }
    }
    paint(memories);

    // Search box (debounced)
    const searchInput = $("memorySearchInput");
    searchInput?.addEventListener("input", () => {
      clearTimeout(_memorySearchTimer);
      _memorySearchTimer = setTimeout(async () => {
        const q = searchInput.value.trim();
        if (!q) { paint(memories); return; }
        try {
          const r = await emsoder.listMemories({ q });
          paint(r?.ok ? r.memories || [] : []);
        } catch { /* ignore */ }
      }, 200);
    });

    $("btnMemoryAdd")?.addEventListener("click", () => showMemoryDetail(null));
    $("btnMemoryExtract")?.addEventListener("click", async () => {
      toast("正在从当前会话提取记忆…");
      try {
        const r = await emsoder.extractMemoriesNow();
        if (r?.ok) {
          toast(`提取了 ${r.added?.length || 0} 条记忆`);
          await renderMemorySide();
        } else {
          toast(r?.error || "提取失败", true);
        }
      } catch (e) { toast(e.message || e, true); }
    });
    $("btnMemoryClear")?.addEventListener("click", async () => {
      if (!(await EmsoderDom.showConfirm("确定清空全部长期记忆？不可恢复。"))) return;
      try {
        await emsoder.clearMemories();
        toast("已清空");
        await renderMemorySide();
      } catch (e) { toast(e.message || e, true); }
    });
  }

  async function showMemoryDetail(id) {
    let mem = null;
    if (id) {
      try {
        const all = await emsoder.listMemories({});
        mem = (all?.memories || []).find((m) => m.id === id) || null;
      } catch { /* ignore */ }
    }
    sideBody.innerHTML = "";
    const back = document.createElement("button");
    back.className = "btn small";
    back.textContent = "← 返回";
    back.addEventListener("click", () => renderMemorySide());
    sideBody.appendChild(back);

    const form = document.createElement("div");
    form.className = "skill-detail";
    form.innerHTML = `
      <div class="skill-section-title">${id ? "编辑记忆" : "添加记忆"}</div>
      <textarea id="memContent" rows="3" placeholder="记忆内容（事实或偏好）" style="width:100%;resize:vertical">${escapeHtml(mem?.content || "")}</textarea>
      <input type="text" id="memTags" placeholder="标签，逗号分隔" value="${escapeHtml((mem?.tags || []).join(", "))}" style="width:100%;margin-top:6px" />
      <label style="display:block;margin-top:6px;font-size:12px">重要性（1-5）
        <input type="number" id="memImportance" min="1" max="5" value="${mem?.importance || 3}" style="width:60px" />
      </label>
      <div style="margin-top:8px;display:flex;gap:6px">
        <button class="btn primary" id="memSave">${id ? "保存" : "添加"}</button>
        ${id ? '<button class="btn" id="memDelete">删除</button>' : ""}
      </div>
    `;
    sideBody.appendChild(form);

    $("memSave")?.addEventListener("click", async () => {
      const content = $("memContent").value.trim();
      if (!content) { toast("内容不能为空", true); return; }
      const tags = $("memTags").value.split(",").map((t) => t.trim()).filter(Boolean);
      const importance = Math.min(5, Math.max(1, Number($("memImportance").value) || 3));
      try {
        if (id) {
          await emsoder.updateMemory(id, { content, tags, importance });
          toast("已保存");
        } else {
          await emsoder.addMemory({ content, tags, importance });
          toast("已添加");
        }
        await renderMemorySide();
      } catch (e) { toast(e.message || e, true); }
    });
    $("memDelete")?.addEventListener("click", async () => {
      if (!(await EmsoderDom.showConfirm("删除这条记忆？"))) return;
      try {
        await emsoder.removeMemory(id);
        toast("已删除");
        await renderMemorySide();
      } catch (e) { toast(e.message || e, true); }
    });
  }

  window.EmsoderMemorySide = {
    render: renderMemorySide,
    showDetail: showMemoryDetail,
  };
})();
