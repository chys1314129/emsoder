/* EmsoderInlineEdit: inline-edit modal (Ctrl+I) — describe a change, apply to selection/file.
   Depends on: EmsoderState (state, $), emsoder, EmsoderDom (toast/openModal/closeModal),
   EmsoderEditor (getValue/getSelectionText/getLanguage/replaceSelectionOrAll).
   flushActiveToTab/renderTabs stay in app.js -> window.EmsoderApp?.fn?.(). */
(() => {
  const { state, $ } = EmsoderState;
  const toast = (...a) => EmsoderDom.toast(...a);
  const openModal = (id) => EmsoderDom.openModal(id);
  const closeModal = (id) => EmsoderDom.closeModal(id);

  function openInlineModal() {
    if (!state.activePath) {
      toast("请先打开一个文件", true);
      return;
    }
    $("inlineInstruction").value = "";
    openModal("modalInline");
    setTimeout(() => $("inlineInstruction").focus(), 50);
  }

  async function runInlineEdit(instruction) {
    if (!state.activePath || !instruction?.trim()) return;
    let code = EmsoderEditor.getValue();
    const sel = EmsoderEditor.getSelectionText();
    if (sel) code = sel;
    $("sbStatus").textContent = "Inline Edit…";
    try {
      const r = await emsoder.inlineEdit({
        instruction,
        code,
        file: state.activePath,
        language: EmsoderEditor.getLanguage(),
      });
      if (!r.code) {
        toast("模型返回为空", true);
        return;
      }
      EmsoderEditor.replaceSelectionOrAll(r.code);
      await window.EmsoderApp?.flushActiveToTab?.();
      window.EmsoderApp?.renderTabs?.();
      toast("Inline Edit 完成");
    } catch (err) {
      toast(err.message || err, true);
    }
  }

  $("btnInlineEdit").onclick = openInlineModal;
  $("btnRunInline").onclick = async () => {
    const instruction = $("inlineInstruction").value.trim();
    if (!instruction) {
      toast("请填写修改说明", true);
      return;
    }
    closeModal("modalInline");
    await runInlineEdit(instruction);
  };

  window.EmsoderInlineEdit = {
    open: openInlineModal,
    run: runInlineEdit,
  };
})();
