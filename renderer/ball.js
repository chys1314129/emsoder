/* Floating-ball renderer: subscribes to agent events and reflects task state.
   State priority: running > review > stopped > idle. */
(() => {
  const body = document.body;
  const labelEl = document.getElementById("label");
  const LABELS = { idle: "空闲", running: "运行中", review: "待审", stopped: "已停止" };

  let generating = false;
  let hasReview = false;
  let lastReason = "done";

  function paint() {
    let s = "idle";
    if (generating) s = "running";
    else if (hasReview) s = "review";
    else if (lastReason === "stopped") s = "stopped";
    body.dataset.state = s;
    if (labelEl) labelEl.textContent = LABELS[s] || "空闲";
  }

  const api = window.emsoder;
  if (api?.onAgentEvent) {
    api.onAgentEvent((msg) => {
      switch (msg.type) {
        case "assistant_start":
        case "reasoning_delta":
        case "tool_start":
          generating = true;
          break;
        case "queue":
          generating = !!msg.running || (msg.depth || 0) > 0;
          break;
        case "assistant_done":
          generating = false;
          lastReason = msg.reason || "done";
          break;
        case "file_changes":
          hasReview = Array.isArray(msg.fileChanges) &&
            msg.fileChanges.some((f) => f && !f.rejected);
          break;
        case "session":
          if (msg.session) {
            const rs = msg.session.runStatus || "idle";
            hasReview = rs === "review";
            if (rs !== "running") generating = generating && false;
          }
          break;
        default:
          return;
      }
      paint();
    });
  }

  document.getElementById("btnShow")?.addEventListener("click", () => {
    api?.showMainWindow?.();
  });
  document.getElementById("btnStop")?.addEventListener("click", () => {
    api?.stopAgent?.();
  });

  paint();
})();
