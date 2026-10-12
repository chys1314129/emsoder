/* EmsoderSearchSide: workspace search sidebar.
   Depends on: EmsoderState (state, $), emsoder, EmsoderDom (escapeHtml/emptyState).
   openFile() stays in app.js and is reached via window.EmsoderApp?.openFile?.(). */
(() => {
  const { state, $ } = EmsoderState;
  const escapeHtml = (s) => EmsoderDom.escapeHtml(s);
  const sideBody = $("sideBody");
  const sideTitle = $("sideTitle");

  function renderSearchSide() {
    sideTitle.textContent = "搜索";
    sideBody.innerHTML = "";

    const form = document.createElement("div");
    form.style.padding = "12px";

    const qField = document.createElement("div");
    qField.className = "field";
    const qLabel = document.createElement("label");
    qLabel.textContent = "关键词";
    const qInput = document.createElement("input");
    qInput.id = "searchQuery";
    qInput.placeholder = "在工作区搜索…";
    qField.appendChild(qLabel);
    qField.appendChild(qInput);
    form.appendChild(qField);

    const globField = document.createElement("div");
    globField.className = "field";
    const globLabel = document.createElement("label");
    globLabel.textContent = "扩展过滤";
    const globInput = document.createElement("input");
    globInput.id = "searchGlob";
    globInput.placeholder = ".js / .ts";
    globField.appendChild(globLabel);
    globField.appendChild(globInput);
    form.appendChild(globField);

    const btnSearch = document.createElement("button");
    btnSearch.className = "btn primary";
    btnSearch.id = "btnDoSearch";
    btnSearch.style.width = "100%";
    btnSearch.textContent = "搜索";
    form.appendChild(btnSearch);

    const meta = document.createElement("div");
    meta.id = "searchMeta";
    meta.style.cssText = "margin-top:8px;font-size:11px;color:var(--text-muted)";
    form.appendChild(meta);

    const results = document.createElement("div");
    results.id = "searchResults";
    results.style.cssText = "margin-top:8px;user-select:text";
    form.appendChild(results);

    const btnMore = document.createElement("button");
    btnMore.className = "btn";
    btnMore.id = "btnSearchMore";
    btnMore.style.cssText = "width:100%;margin-top:8px;display:none";
    btnMore.textContent = "加载更多";
    form.appendChild(btnMore);

    sideBody.appendChild(form);

    const PAGE = 40;
    let allResults = [];
    let shown = 0;
    const paintPage = () => {
      const box = $("searchResults");
      const more = $("btnSearchMore");
      const metaEl = $("searchMeta");
      if (!box) return;
      const slice = allResults.slice(shown, shown + PAGE);
      for (const r of slice) {
        const btn = document.createElement("button");
        btn.className = "search-hit";
        btn.innerHTML = `<div class="path">${escapeHtml(r.relative)}:${r.line}</div><div class="line">${escapeHtml(r.text)}</div>`;
        btn.onclick = () => window.EmsoderApp?.openFile?.(r.path, r.line);
        box.appendChild(btn);
      }
      shown += slice.length;
      if (metaEl) {
        metaEl.textContent = allResults.length
          ? `显示 ${shown} / ${allResults.length}`
          : "";
      }
      if (more) more.style.display = shown < allResults.length ? "block" : "none";
    };
    const run = async () => {
      const q = $("searchQuery").value.trim();
      const box = $("searchResults");
      if (!q) return;
      if (!state.workspace) {
        box.replaceChildren(EmsoderDom.emptyState("请先打开工作区"));
        return;
      }
      box.replaceChildren(EmsoderDom.emptyState("搜索中…"));
      if ($("searchMeta")) $("searchMeta").textContent = "";
      if ($("btnSearchMore")) $("btnSearchMore").style.display = "none";
      try {
        const out = await emsoder.search({
          query: q,
          glob: $("searchGlob").value.trim(),
          maxResults: 200,
        });
        box.replaceChildren();
        allResults = [];
        shown = 0;
        if (!out.ok) {
          box.appendChild(EmsoderDom.emptyState(out.error || "搜索失败"));
          return;
        }
        if (!out.results.length) {
          box.appendChild(EmsoderDom.emptyState(`没有匹配 “${q}”`));
          return;
        }
        allResults = out.results;
        paintPage();
      } catch (err) {
        box.replaceChildren(EmsoderDom.emptyState(err.message || String(err)));
      }
    };
    $("btnDoSearch").onclick = run;
    $("btnSearchMore").onclick = () => paintPage();
    $("searchQuery").addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    });
  }

  window.EmsoderSearchSide = {
    render: renderSearchSide,
  };
})();
