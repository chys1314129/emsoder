/* EmsoderState: shared renderer state object + $ (getElementById) helper.
   Loaded BEFORE app.js and all UI modules so they can share one `state`
   reference and one `$`. */
(() => {
  function $(id) {
    return document.getElementById(id);
  }

  const state = {
    config: null,
    workspace: "",
    tabs: [],
    activePath: null,
    generating: false,
    /** 当前会话的排队数；主进程任务池快照为权威来源 */
    queueDepth: 0,
    /** sessionId -> { state, workspaceRoot, position }，支持后台工作区并行 */
    sessionRuntime: new Map(),
    /** 本轮正常做完后，等发送键重新可点再响 */
    notifyWhenSendable: false,
    /** Pi plan 模式待审批计划文本 */
    pendingPlan: null,
    expandedDirs: new Set(),
    sideView: "sessions",
    streamingEl: null,
    streamingRaw: "",
    streamingRaf: 0,
    streamingScrollPending: false,
    reasoningEl: null,
    reasoningRaw: "",
    reasoningRaf: 0,
    activeToolRow: null,
    pendingConfirmId: null,
    monacoReady: false,
    attachments: [],
    /** @-mention state */
    mention: {
      visible: false,
      items: [],
      index: 0,
      triggerPos: 0,
      searchText: "",
      cache: null,
      ts: 0,
    },
    /** skills sidebar filter (preserved across re-render) */
    skillsFilter: {
      q: "",
      status: "all", // all | enabled | disabled
      source: "all", // all | zcode | agents | workspace | core | bundled | plugin
    },
    runStartedAt: 0,
    _runTick: 0,
    _runDetail: "",
    editMessageId: null,
    branchMeta: [],
    excludedBranches: [],
    activeSessionId: null,
    /** 本轮 Agent 写盘摘要（无 before/after） */
    fileChanges: [],
    fileChangesSessionId: null,
  };

  window.EmsoderState = { state, $ };
})();
