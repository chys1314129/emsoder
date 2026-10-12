/* EmsoderDrafts: debounced save of unsaved tabs + restore on startup.
   Depends on: EmsoderState (state, $), emsoder, EmsoderDom (showConfirm/toast/basename),
   EmsoderTabs (flushActiveToTab/renderTabs/activateTab). */
(() => {
  const { state, $ } = EmsoderState;
  const toast = (...a) => EmsoderDom.toast(...a);
  const basename = (p) => EmsoderDom.basename(p);

  let draftTimer = null;

  function scheduleDraftSave() {
    if (draftTimer) return;
    draftTimer = setTimeout(async () => {
      draftTimer = null;
      try {
        await window.EmsoderTabs?.flushActiveToTab?.();
        const dirty = state.tabs
          .filter((t) => t.dirty)
          .map((t) => ({
            path: t.path,
            name: t.name,
            content: t.content,
            original: t.original,
          }));
        if (dirty.length) await emsoder.saveDrafts(dirty);
        else await emsoder.clearDrafts();
      } catch {
        /* ignore */
      }
    }, 800);
  }

  async function maybeRestoreDrafts() {
    try {
      const data = await emsoder.loadDrafts();
      const drafts = data?.drafts || [];
      if (!drafts.length) return;
      if (
        !(await EmsoderDom.showConfirm(
          "发现 " + drafts.length + " 个未保存草稿（可能来自上次异常退出）。是否恢复？"
        ))
      ) {
        await emsoder.clearDrafts();
        return;
      }
      for (const d of drafts) {
        if (!d?.path) continue;
        let content = d.content || "";
        let original = d.original || "";
        try {
          const disk = await emsoder.readFile(d.path);
          if (disk?.content != null) original = disk.content;
        } catch {
          /* ignore */
        }
        const existing = state.tabs.find((t) => t.path === d.path);
        if (existing) {
          existing.content = content;
          existing.original = original;
          existing.dirty = content !== original;
        } else {
          state.tabs.push({
            path: d.path,
            name: d.name || basename(d.path),
            content,
            original,
            dirty: content !== original,
          });
        }
      }
      window.EmsoderTabs?.renderTabs?.();
      const first = state.tabs.find((t) => t.dirty) || state.tabs[0];
      if (first) await window.EmsoderTabs?.activateTab?.(first.path);
      toast("已恢复未保存草稿");
    } catch (e) {
      console.warn("restore drafts", e);
    }
  }

  window.EmsoderDrafts = {
    scheduleDraftSave,
    maybeRestoreDrafts,
  };
})();
